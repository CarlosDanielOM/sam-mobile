import { calculateApiEquivalentCost } from './cost-calculator';
import type {
  AgentRecord,
  AgentRunAttribution,
  AgentRunRecord,
  BillingMode,
  CostAllocationRecord,
  CostRollup,
  ModelCallAttemptRecord,
  ModelCallRecord,
  PricingSnapshotRecord,
  ProviderAccountRecord,
  SubscriptionPlanRecord,
  TelemetryRepository,
  TelemetryStatus,
  TokenUsage,
  TurnRecord,
} from './types';
import { aggregateTokenUsage } from './usage';

function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

const TERMINAL_STATUSES = new Set<TelemetryStatus>(['completed', 'failed', 'cancelled', 'interrupted']);

type MoneyComponent = { amount: number | null; currency: string | null };

/**
 * Sums the known parts of a set of monetary components. Unknown (null) amounts
 * never become zero: they are excluded from the sum and flagged via
 * `hasUnknown`. Mixed currencies make the whole sum unknown.
 */
export function sumKnown(records: MoneyComponent[]): { amount: number | null; currency: string | null; hasUnknown: boolean } {
  if (!records.length) {
    return { amount: null, currency: null, hasUnknown: false };
  }
  const known = records.filter((record) => record.amount !== null);
  let hasUnknown = known.length !== records.length;
  const currencies = new Set(known.map((record) => record.currency));
  if (currencies.size > 1) {
    return { amount: null, currency: null, hasUnknown: true };
  }
  let total = 0n;
  for (const record of known) {
    if (!Number.isSafeInteger(record.amount) || record.amount! < 0) {
      throw new Error('Monetary values must be non-negative safe integers.');
    }
    total += BigInt(record.amount!);
  }
  const amount = Number(total);
  if (!Number.isSafeInteger(amount)) {
    throw new Error('Aggregated monetary value exceeds the safe integer range.');
  }
  if (known.length && known[0].currency === null) {
    hasUnknown = true;
  }
  return {
    amount,
    currency: known.length ? known[0].currency : null,
    hasUnknown,
  };
}

/**
 * Strict variant used for call-level totals: the total stays unknown unless
 * every component is known in a single currency.
 */
function sameKnownCurrency(
  records: MoneyComponent[],
): { amount: number; currency: string } | null {
  const result = sumKnown(records);
  if (!records.length || result.hasUnknown || result.amount === null || result.currency === null) {
    return null;
  }
  return { amount: result.amount, currency: result.currency };
}

export type SessionUsageSummary = {
  inputTokens: number | null;
  cacheReadTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  currency: string | null;
  hasUnknownCost: boolean;
  contextPercent: number | null;
};

export type TurnUsageDetail = {
  turnId: string | null;
  agentName: string;
  providerId: string;
  modelId: string;
  accountLabel: string;
  billingMode: BillingMode;
  apiEquivalentMicros: number | null;
  apiEquivalentCurrency: string | null;
  meteredMicros: number | null;
  meteredCurrency: string | null;
  uncachedInputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  ttftMs: number | null;
  latencyMs: number | null;
  tokensPerSecondMilli: number | null;
  attribution: AgentRunAttribution[];
};

export type StartModelCallInput = {
  sessionId: string;
  /** Optional context: omit for calls that did not originate from a chat turn. */
  turnId?: string | null;
  messageId?: string | null;
  generationId?: string | null;
  agentId: string;
  agentRunId: string;
  ownsTurn?: boolean;
  ownsAgentRun?: boolean;
  parentCallId?: string | null;
  providerAccountId: string;
  provider: string;
  model: string;
  routeReason?: string | null;
  routePolicyId?: string | null;
  fallbackFromCallId?: string | null;
  modelContextLimit?: number | null;
  contextTokens?: number | null;
  requestedMaxOutputTokens?: number | null;
  rawMetadata?: unknown;
  requestedAt?: number;
};

export type CompleteAttemptInput = {
  status: Extract<TelemetryStatus, 'completed' | 'failed' | 'cancelled' | 'interrupted'>;
  completedAt?: number;
  providerRequestId?: string | null;
  usage?: TokenUsage | null;
  finishReason?: string | null;
  errorType?: string | null;
  errorCode?: string | null;
  failureStage?: string | null;
  meteredCostMicros?: number | null;
  meteredCurrency?: string | null;
  meteredCostSource?: string | null;
  /**
   * Fallback API-equivalent cost, used only when no configured pricing snapshot
   * resolves for this attempt (e.g. Pi's registry-priced `usage.cost`). Never
   * use this for provider-metered charges.
   */
  apiEquivalentCostMicros?: number | null;
  apiEquivalentCurrency?: string | null;
  apiEquivalentCostSource?: string | null;
  rawMetadata?: unknown;
};

export class TelemetryService {
  private readonly attemptTiming = new Map<string, { firstTokenAt: number | null; lastTokenAt: number | null }>();
  private readonly repository: TelemetryRepository;
  private readonly now: () => number;

  constructor(repository: TelemetryRepository, now: () => number = () => Date.now()) {
    this.repository = repository;
    this.now = now;
  }

  getModelCallByMessageId(messageId: string): ModelCallRecord | null {
    return this.repository.getModelCallByMessageId(messageId);
  }

  /**
   * Display-oriented rollup of a session's recorded usage. Token dimensions sum
   * the known parts (reported values preferred over estimates); unknown
   * dimensions are skipped rather than zeroed. Cost sums known API-equivalent
   * values and flags `hasUnknownCost` when any call lacks one, so a partial
   * total is never presented as complete. Returns null when nothing displayable
   * has been recorded yet.
   */
  getSessionUsageSummary(sessionId: string): SessionUsageSummary | null {
    const calls = this.repository.listModelCallsBySession(sessionId);
    if (!calls.length) {
      return null;
    }
    let inputTokens: number | null = null;
    let cacheReadTokens: number | null = null;
    let outputTokens: number | null = null;
    const add = (current: number | null, value: number | null): number | null =>
      value === null ? current : (current ?? 0) + value;
    for (const call of calls) {
      const usage = this.repository.getModelCallUsage(call.id);
      if (!usage) {
        continue;
      }
      inputTokens = add(
        inputTokens,
        usage.reportedUncachedInputTokens ??
          usage.reportedInputTokens ??
          usage.estimatedUncachedInputTokens ??
          usage.estimatedInputTokens,
      );
      cacheReadTokens = add(cacheReadTokens, usage.reportedCacheReadTokens ?? usage.estimatedCacheReadTokens);
      outputTokens = add(outputTokens, usage.reportedOutputTokens ?? usage.estimatedOutputTokens);
    }
    const cost = sumKnown(
      calls.map((call) => ({ amount: call.apiEquivalentCostMicros, currency: call.apiEquivalentCurrency })),
    );
    // A null currency means no call has a known cost; the zero from sumKnown is
    // an empty sum, not a real value, and must not be displayed as one.
    const hasKnownCost = cost.currency !== null;
    // Context fullness describes a single request, not the session: use the
    // most recent call with usage (its input, cache reads, and output are what
    // the next request's context will hold) against that call's context limit.
    let contextPercent: number | null = null;
    for (let index = calls.length - 1; index >= 0 && contextPercent === null; index--) {
      const call = calls[index];
      if (call.modelContextLimit === null || call.modelContextLimit <= 0) {
        continue;
      }
      const callUsage = this.repository.getModelCallUsage(call.id);
      if (!callUsage) {
        continue;
      }
      const tokens =
        (callUsage.reportedUncachedInputTokens ??
          callUsage.reportedInputTokens ??
          callUsage.estimatedUncachedInputTokens ??
          callUsage.estimatedInputTokens ??
          0) +
        (callUsage.reportedCacheReadTokens ?? callUsage.estimatedCacheReadTokens ?? 0) +
        (callUsage.reportedOutputTokens ?? callUsage.estimatedOutputTokens ?? 0);
      contextPercent = Math.min(999, Math.round((tokens * 1_000) / call.modelContextLimit) / 10);
    }
    if (inputTokens === null && cacheReadTokens === null && outputTokens === null && !hasKnownCost) {
      return null;
    }
    return {
      inputTokens,
      cacheReadTokens,
      outputTokens,
      costMicros: hasKnownCost ? cost.amount : null,
      currency: cost.currency,
      hasUnknownCost: cost.hasUnknown,
      contextPercent,
    };
  }

  getTurnUsageDetail(sessionId: string): TurnUsageDetail | null {
    const sessionCalls = this.repository.listModelCallsBySession(sessionId);
    if (!sessionCalls.length) {
      return null;
    }
    const latest = sessionCalls[sessionCalls.length - 1];
    const turnCalls = latest.turnId ? this.repository.listModelCallsByTurn(latest.turnId) : [latest];
    const primary = [...turnCalls].reverse().find((call) => call.ownsTurn) ?? latest;
    const usage = this.repository.getModelCallUsage(primary.id);
    const account = this.repository.getProviderAccount(primary.providerAccountId);
    const attribution = latest.turnId ? this.getTurnAttribution(latest.turnId) : [];
    const pick = (reported: number | null | undefined, estimated: number | null | undefined): number | null =>
      reported ?? estimated ?? null;
    return {
      turnId: latest.turnId,
      agentName: this.repository.getAgentRun(primary.agentRunId)?.agentNameSnapshot ?? 'SAM',
      providerId: primary.provider,
      modelId: primary.model,
      accountLabel: account?.displayLabel ?? primary.provider,
      billingMode: account?.billingMode ?? 'unknown',
      apiEquivalentMicros: primary.apiEquivalentCostMicros,
      apiEquivalentCurrency: primary.apiEquivalentCurrency,
      meteredMicros: primary.meteredCostMicros,
      meteredCurrency: primary.meteredCurrency,
      uncachedInputTokens: pick(
        usage?.reportedUncachedInputTokens ?? usage?.reportedInputTokens,
        usage?.estimatedUncachedInputTokens ?? usage?.estimatedInputTokens,
      ),
      cacheReadTokens: pick(usage?.reportedCacheReadTokens, usage?.estimatedCacheReadTokens),
      cacheWriteTokens: pick(usage?.reportedCacheWriteTokens, usage?.estimatedCacheWriteTokens),
      outputTokens: pick(usage?.reportedOutputTokens, usage?.estimatedOutputTokens),
      reasoningTokens: pick(usage?.reportedReasoningTokens, usage?.estimatedReasoningTokens),
      ttftMs: primary.ttftMs,
      latencyMs: primary.totalLatencyMs,
      tokensPerSecondMilli: primary.outputTokensPerSecondMilli,
      attribution,
    };
  }

  ensureAgent(input: {
    id: string;
    name: string;
    kind: string;
    persistent: boolean;
    ownerAgentId?: string | null;
    defaultModelPolicyId?: string | null;
    metadata?: unknown;
    createdAt?: number;
  }): AgentRecord {
    const existing = this.repository.getAgent(input.id);
    if (existing) {
      return existing;
    }
    const record: AgentRecord = {
      id: input.id,
      name: input.name,
      kind: input.kind,
      persistent: input.persistent,
      ownerAgentId: input.ownerAgentId ?? null,
      defaultModelPolicyId: input.defaultModelPolicyId ?? null,
      metadataJson: json(input.metadata),
      createdAt: input.createdAt ?? this.now(),
      deletedAt: null,
    };
    this.repository.insertAgent(record);
    return record;
  }

  deleteAgent(agentId: string, at = this.now()): void {
    const agent = this.repository.getAgent(agentId);
    if (agent && agent.deletedAt === null) {
      this.repository.updateAgent({ ...agent, deletedAt: at });
    }
  }

  ensureProviderAccount(input: {
    id: string;
    provider: string;
    displayLabel: string;
    billingMode?: BillingMode;
    planReference?: string | null;
    metadata?: unknown;
    at?: number;
  }): ProviderAccountRecord {
    const existing = this.repository.getProviderAccount(input.id);
    if (existing) {
      return existing;
    }
    const at = input.at ?? this.now();
    const record: ProviderAccountRecord = {
      id: input.id,
      provider: input.provider,
      displayLabel: input.displayLabel,
      billingMode: input.billingMode ?? 'unknown',
      planReference: input.planReference ?? null,
      active: true,
      metadataJson: json(input.metadata),
      createdAt: at,
      updatedAt: at,
    };
    this.repository.insertProviderAccount(record);
    return record;
  }

  saveProviderAccount(record: ProviderAccountRecord): void {
    const existing = this.repository.getProviderAccount(record.id);
    if (existing) {
      this.repository.updateProviderAccount(record);
    } else {
      this.repository.insertProviderAccount(record);
    }
  }

  saveSubscriptionPlan(record: SubscriptionPlanRecord): void {
    if (!Number.isSafeInteger(record.priceMicros) || record.priceMicros < 0) {
      throw new Error('Subscription prices must be non-negative integer micro-units.');
    }
    if (record.periodEnd <= record.periodStart) {
      throw new Error('Subscription period end must be after its start.');
    }
    this.repository.insertSubscriptionPlan(record);
  }

  savePricingSnapshot(record: PricingSnapshotRecord): void {
    if (this.repository.getPricingSnapshot(record.id)) {
      throw new Error(`Pricing snapshot ${record.id} already exists and is immutable.`);
    }
    for (const value of [
      record.inputPerMillionMicros,
      record.cacheReadPerMillionMicros,
      record.cacheWritePerMillionMicros,
      record.outputPerMillionMicros,
      record.reasoningPerMillionMicros,
    ]) {
      if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error('Pricing rates must be non-negative integer micro-units.');
      }
    }
    this.repository.insertPricingSnapshot(record);
  }

  currentPricing(provider: string, model: string, at?: number): PricingSnapshotRecord | null {
    return this.resolvePricing({ provider, providerAccountId: '', model }, at ?? this.now());
  }

  saveUserModelPricing(input: {
    provider: string;
    model: string;
    inputPerMillionMicros: number;
    outputPerMillionMicros: number;
    cacheReadPerMillionMicros?: number | null;
    cacheWritePerMillionMicros?: number | null;
    notes?: string | null;
  }): PricingSnapshotRecord {
    const at = this.now();
    const record: PricingSnapshotRecord = {
      id: id('price'),
      provider: input.provider,
      providerAccountId: null,
      model: input.model,
      inputPerMillionMicros: input.inputPerMillionMicros,
      cacheReadPerMillionMicros: input.cacheReadPerMillionMicros ?? null,
      cacheWritePerMillionMicros: input.cacheWritePerMillionMicros ?? null,
      outputPerMillionMicros: input.outputPerMillionMicros,
      reasoningPerMillionMicros: null,
      modalityRatesJson: null,
      currency: 'USD',
      effectiveFrom: at,
      effectiveTo: null,
      source: 'user_override',
      notes: input.notes ?? null,
      createdAt: at,
    };
    this.savePricingSnapshot(record);
    return record;
  }

  startTurn(input: {
    id?: string;
    sessionId: string;
    userMessageId?: string | null;
    metadata?: unknown;
    startedAt?: number;
  }): TurnRecord {
    const record: TurnRecord = {
      id: input.id ?? id('turn'),
      sessionId: input.sessionId,
      userMessageId: input.userMessageId ?? null,
      status: 'running',
      startedAt: input.startedAt ?? this.now(),
      completedAt: null,
      metadataJson: json(input.metadata),
    };
    this.repository.insertTurn(record);
    return record;
  }

  reopenTurn(turnId: string): TurnRecord | null {
    const turn = this.repository.getTurn(turnId);
    if (!turn) {
      return null;
    }
    const next = { ...turn, status: 'running' as const, completedAt: null };
    this.repository.updateTurn(next);
    return next;
  }

  completeTurn(turnId: string, status: TelemetryStatus, completedAt = this.now()): void {
    const turn = this.repository.getTurn(turnId);
    // Idempotent: a terminal turn is only reopened explicitly via reopenTurn.
    if (turn && turn.completedAt === null) {
      this.repository.updateTurn({ ...turn, status, completedAt });
    }
  }

  startAgentRun(input: {
    id?: string;
    agentId: string;
    parentAgentRunId?: string | null;
    spawnedByAgentId?: string | null;
    spawnedByRunId?: string | null;
    sessionId: string;
    /** Optional context: omit for runs that did not originate from a chat turn. */
    turnId?: string | null;
    purpose?: string | null;
    spawnReason?: string | null;
    metadata?: unknown;
    startedAt?: number;
  }): AgentRunRecord {
    const agent = this.repository.getAgent(input.agentId);
    if (!agent || agent.deletedAt !== null) {
      throw new Error(`Unknown agent ${input.agentId}.`);
    }
    const turnId = input.turnId ?? null;
    if (input.parentAgentRunId) {
      const parent = this.repository.getAgentRun(input.parentAgentRunId);
      if (!parent || parent.turnId !== turnId || parent.sessionId !== input.sessionId) {
        throw new Error('Parent agent run must exist in the same session and turn.');
      }
    }
    const record: AgentRunRecord = {
      id: input.id ?? id('run'),
      agentId: input.agentId,
      parentAgentRunId: input.parentAgentRunId ?? null,
      spawnedByAgentId: input.spawnedByAgentId ?? null,
      spawnedByRunId: input.spawnedByRunId ?? null,
      sessionId: input.sessionId,
      turnId,
      purpose: input.purpose ?? null,
      spawnReason: input.spawnReason ?? null,
      status: 'running',
      startedAt: input.startedAt ?? this.now(),
      completedAt: null,
      agentNameSnapshot: agent.name,
      agentKindSnapshot: agent.kind,
      metadataJson: json(input.metadata),
    };
    this.repository.insertAgentRun(record);
    return record;
  }

  completeAgentRun(agentRunId: string, status: TelemetryStatus, completedAt = this.now()): void {
    const run = this.repository.getAgentRun(agentRunId);
    // Idempotent: never overwrite a terminal run.
    if (run && run.completedAt === null) {
      this.repository.updateAgentRun({ ...run, status, completedAt });
    }
  }

  startModelCall(input: StartModelCallInput): ModelCallRecord {
    const requestedAt = input.requestedAt ?? this.now();
    const turnId = input.turnId ?? null;
    const run = this.repository.getAgentRun(input.agentRunId);
    if (!run) {
      throw new Error(`Unknown agent run ${input.agentRunId}.`);
    }
    if (run.sessionId !== input.sessionId || run.turnId !== turnId || run.agentId !== input.agentId) {
      throw new Error('Model call must match its agent run session, turn, and agent.');
    }
    if (input.parentCallId && !this.repository.getModelCall(input.parentCallId)) {
      throw new Error(`Unknown parent model call ${input.parentCallId}.`);
    }
    if (input.fallbackFromCallId && !this.repository.getModelCall(input.fallbackFromCallId)) {
      throw new Error(`Unknown fallback origin model call ${input.fallbackFromCallId}.`);
    }
    const record: ModelCallRecord = {
      id: id('call'),
      sessionId: input.sessionId,
      turnId,
      messageId: input.messageId ?? null,
      generationId: input.generationId ?? null,
      agentId: input.agentId,
      agentRunId: input.agentRunId,
      ownsTurn: input.ownsTurn ?? false,
      ownsAgentRun: input.ownsAgentRun ?? false,
      parentCallId: input.parentCallId ?? null,
      providerAccountId: input.providerAccountId,
      provider: input.provider,
      model: input.model,
      providerRequestId: null,
      routeReason: input.routeReason ?? null,
      routePolicyId: input.routePolicyId ?? null,
      fallbackFromCallId: input.fallbackFromCallId ?? null,
      requestedAt,
      firstTokenAt: null,
      lastTokenAt: null,
      completedAt: null,
      ttftMs: null,
      generationDurationMs: null,
      totalLatencyMs: null,
      outputTokensPerSecondMilli: null,
      status: 'running',
      finishReason: null,
      errorType: null,
      errorCode: null,
      failureStage: null,
      cancelledAt: null,
      modelContextLimit: input.modelContextLimit ?? null,
      contextTokens: input.contextTokens ?? null,
      contextUtilizationBps:
        input.modelContextLimit && input.contextTokens !== null && input.contextTokens !== undefined
          ? Math.round((input.contextTokens * 10_000) / input.modelContextLimit)
          : null,
      requestedMaxOutputTokens: input.requestedMaxOutputTokens ?? null,
      pricingSnapshotId: null,
      meteredCostMicros: null,
      meteredCurrency: null,
      meteredCostSource: null,
      apiEquivalentCostMicros: null,
      apiEquivalentCurrency: null,
      apiEquivalentCostSource: null,
      rawMetadataJson: json(input.rawMetadata),
    };
    this.repository.insertModelCall(record);
    return record;
  }

  startAttempt(input: {
    callId: string;
    providerAccountId: string;
    provider: string;
    model: string;
    rawMetadata?: unknown;
    startedAt?: number;
  }): ModelCallAttemptRecord {
    const call = this.repository.getModelCall(input.callId);
    if (!call) {
      throw new Error(`Unknown model call ${input.callId}.`);
    }
    if (call.completedAt !== null) {
      throw new Error(`Model call ${input.callId} is already finalized; create a new call instead.`);
    }
    const attempts = this.repository.listModelCallAttempts(input.callId);
    const record: ModelCallAttemptRecord = {
      id: id('attempt'),
      callId: input.callId,
      attemptNumber: attempts.length + 1,
      providerAccountId: input.providerAccountId,
      provider: input.provider,
      model: input.model,
      startedAt: input.startedAt ?? this.now(),
      responseReceivedAt: null,
      firstTokenAt: null,
      lastTokenAt: null,
      completedAt: null,
      latencyMs: null,
      providerRequestId: null,
      httpStatus: null,
      status: 'running',
      errorType: null,
      errorCode: null,
      failureStage: null,
      pricingSnapshotId: null,
      meteredCostMicros: null,
      meteredCurrency: null,
      meteredCostSource: null,
      apiEquivalentCostMicros: null,
      apiEquivalentCurrency: null,
      apiEquivalentCostSource: null,
      rawMetadataJson: json(input.rawMetadata),
    };
    this.repository.insertModelCallAttempt(record);
    this.attemptTiming.set(record.id, { firstTokenAt: null, lastTokenAt: null });
    return record;
  }

  recordResponse(
    attemptId: string,
    input: { at?: number; httpStatus?: number | null; providerRequestId?: string | null },
  ): void {
    const attempt = this.repository.getModelCallAttempt(attemptId);
    if (!attempt || attempt.completedAt !== null) {
      return;
    }
    this.repository.updateModelCallAttempt({
      ...attempt,
      responseReceivedAt: input.at ?? this.now(),
      httpStatus: input.httpStatus ?? attempt.httpStatus,
      providerRequestId: input.providerRequestId ?? attempt.providerRequestId,
    });
  }

  recordToken(callId: string, attemptId: string, at = this.now()): void {
    const timing = this.attemptTiming.get(attemptId) ?? { firstTokenAt: null, lastTokenAt: null };
    timing.lastTokenAt = at;
    if (timing.firstTokenAt === null) {
      timing.firstTokenAt = at;
      const attempt = this.repository.getModelCallAttempt(attemptId);
      if (attempt && attempt.completedAt === null) {
        this.repository.updateModelCallAttempt({ ...attempt, firstTokenAt: at, status: 'streaming' });
      }
      const call = this.repository.getModelCall(callId);
      if (call && call.completedAt === null) {
        this.repository.updateModelCall({
          ...call,
          firstTokenAt: at,
          ttftMs: Math.max(0, at - call.requestedAt),
          status: 'streaming',
        });
      }
    }
    this.attemptTiming.set(attemptId, timing);
  }

  completeAttempt(attemptId: string, input: CompleteAttemptInput): ModelCallAttemptRecord | null {
    const attempt = this.repository.getModelCallAttempt(attemptId);
    if (!attempt) {
      return null;
    }
    // Idempotent: finalizing an attempt twice keeps the first terminal record.
    if (attempt.completedAt !== null) {
      return attempt;
    }
    const completedAt = input.completedAt ?? this.now();
    for (const [value, label] of [
      [input.meteredCostMicros, 'Metered cost'],
      [input.apiEquivalentCostMicros, 'API-equivalent cost'],
    ] as const) {
      if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error(`${label} must be a non-negative integer micro-unit value.`);
      }
    }
    const timing = this.attemptTiming.get(attemptId);
    if (input.usage) {
      this.repository.putModelCallAttemptUsage({ attemptId, ...input.usage });
    }
    const pricing = input.usage ? this.resolvePricing(attempt, attempt.startedAt) : null;
    const configured = input.usage && pricing ? calculateApiEquivalentCost(input.usage, pricing) : null;
    let equivalentMicros: number | null = configured?.amountMicros ?? null;
    let equivalentCurrency: string | null = configured?.currency ?? null;
    let equivalentSource = configured ? `configured_pricing:${configured.source}` : null;
    let pricingSnapshotId = configured?.pricingSnapshotId ?? null;
    if (
      configured === null &&
      input.apiEquivalentCostMicros !== undefined &&
      input.apiEquivalentCostMicros !== null
    ) {
      equivalentMicros = input.apiEquivalentCostMicros;
      equivalentCurrency = input.apiEquivalentCurrency ?? 'USD';
      equivalentSource = input.apiEquivalentCostSource ?? 'external_fallback';
      pricingSnapshotId = null;
    }
    const next: ModelCallAttemptRecord = {
      ...attempt,
      firstTokenAt: attempt.firstTokenAt ?? timing?.firstTokenAt ?? null,
      lastTokenAt: timing?.lastTokenAt ?? attempt.lastTokenAt,
      completedAt,
      latencyMs: Math.max(0, completedAt - attempt.startedAt),
      providerRequestId: input.providerRequestId ?? attempt.providerRequestId,
      status: input.status,
      errorType: input.errorType ?? null,
      errorCode: input.errorCode ?? null,
      failureStage: input.failureStage ?? null,
      pricingSnapshotId,
      meteredCostMicros: input.meteredCostMicros ?? null,
      meteredCurrency: input.meteredCurrency ?? null,
      meteredCostSource: input.meteredCostSource ?? null,
      apiEquivalentCostMicros: equivalentMicros,
      apiEquivalentCurrency: equivalentCurrency,
      apiEquivalentCostSource: equivalentSource,
      rawMetadataJson: input.rawMetadata === undefined ? attempt.rawMetadataJson : json(input.rawMetadata),
    };
    this.repository.updateModelCallAttempt(next);
    this.attemptTiming.delete(attemptId);
    return next;
  }

  completeModelCall(
    callId: string,
    input: {
      status: Extract<TelemetryStatus, 'completed' | 'failed' | 'cancelled' | 'interrupted'>;
      completedAt?: number;
      finishReason?: string | null;
      errorType?: string | null;
      errorCode?: string | null;
      failureStage?: string | null;
      rawMetadata?: unknown;
    },
  ): ModelCallRecord | null {
    const call = this.repository.getModelCall(callId);
    if (!call) {
      return null;
    }
    // Idempotent: finalizing a call twice keeps the first terminal record.
    if (call.completedAt !== null) {
      return call;
    }
    const attempts = this.repository.listModelCallAttempts(callId);
    const usages = attempts.map((attempt) => this.repository.getModelCallAttemptUsage(attempt.id));
    const aggregateUsage = aggregateTokenUsage(usages);
    if (aggregateUsage) {
      this.repository.putModelCallUsage({ callId, ...aggregateUsage });
    }
    const completedAt = input.completedAt ?? this.now();
    // Timing and output speed describe the user-visible result: prefer the
    // successful attempt; otherwise use the last attempt's partial progress.
    // Mixing spans across attempts would include retry waits in TTFT and
    // generation duration, corrupting output tokens/sec.
    const successful = [...attempts].reverse().find((attempt) => attempt.status === 'completed');
    const timed = successful ?? attempts.at(-1) ?? null;
    const firstTokenAt = timed?.firstTokenAt ?? null;
    const lastTokenAt = timed?.lastTokenAt ?? null;
    const generationDurationMs =
      firstTokenAt === null ? null : Math.max(0, (lastTokenAt ?? timed?.completedAt ?? completedAt) - firstTokenAt);
    const timedUsage = timed ? usages[attempts.indexOf(timed)] : null;
    const outputTokens = timedUsage?.reportedOutputTokens ?? timedUsage?.estimatedOutputTokens ?? null;
    const equivalent = sameKnownCurrency(
      attempts.map((attempt) => ({
        amount: attempt.apiEquivalentCostMicros,
        currency: attempt.apiEquivalentCurrency,
      })),
    );
    const metered = sameKnownCurrency(
      attempts.map((attempt) => ({ amount: attempt.meteredCostMicros, currency: attempt.meteredCurrency })),
    );
    const pricingIds = new Set(attempts.map((attempt) => attempt.pricingSnapshotId).filter(Boolean));
    const next: ModelCallRecord = {
      ...call,
      providerRequestId: successful?.providerRequestId ?? attempts.at(-1)?.providerRequestId ?? null,
      firstTokenAt,
      lastTokenAt,
      completedAt,
      ttftMs: firstTokenAt === null ? null : Math.max(0, firstTokenAt - call.requestedAt),
      generationDurationMs,
      totalLatencyMs: Math.max(0, completedAt - call.requestedAt),
      outputTokensPerSecondMilli:
        outputTokens === null || !generationDurationMs
          ? null
          : Math.round((outputTokens * 1_000_000) / generationDurationMs),
      status: input.status,
      finishReason: input.finishReason ?? null,
      errorType: input.errorType ?? null,
      errorCode: input.errorCode ?? null,
      failureStage: input.failureStage ?? null,
      cancelledAt: input.status === 'cancelled' ? completedAt : null,
      pricingSnapshotId: pricingIds.size === 1 ? ([...pricingIds][0] as string) : null,
      meteredCostMicros: metered?.amount ?? null,
      meteredCurrency: metered?.currency ?? null,
      meteredCostSource: metered ? 'attempt_aggregate' : null,
      apiEquivalentCostMicros: equivalent?.amount ?? null,
      apiEquivalentCurrency: equivalent?.currency ?? null,
      apiEquivalentCostSource: equivalent ? 'attempt_aggregate' : null,
      rawMetadataJson: input.rawMetadata === undefined ? call.rawMetadataJson : json(input.rawMetadata),
    };
    this.repository.updateModelCall(next);
    return next;
  }

  interruptGeneration(generationId: string, error: string, at = this.now()): void {
    const call = this.repository.getModelCallByGenerationId(generationId);
    if (!call || call.completedAt !== null) {
      return;
    }
    for (const attempt of this.repository.listModelCallAttempts(call.id)) {
      if (attempt.completedAt === null) {
        this.completeAttempt(attempt.id, {
          status: 'interrupted',
          completedAt: at,
          errorType: 'ProcessInterrupted',
          failureStage: 'process_restart',
        });
      }
    }
    this.completeModelCall(call.id, {
      status: 'interrupted',
      completedAt: at,
      errorType: 'ProcessInterrupted',
      failureStage: 'process_restart',
      rawMetadata: { error },
    });
    if (call.ownsAgentRun) {
      this.completeAgentRun(call.agentRunId, 'interrupted', at);
    }
    if (call.ownsTurn && call.turnId !== null) {
      this.completeTurn(call.turnId, 'interrupted', at);
    }
  }

  recoverOrphans(at = this.now()): void {
    for (const call of this.repository.listModelCallsByStatus(['queued', 'running', 'streaming'])) {
      for (const attempt of this.repository.listModelCallAttempts(call.id)) {
        if (attempt.completedAt === null) {
          this.completeAttempt(attempt.id, {
            status: 'interrupted',
            completedAt: at,
            errorType: 'ProcessInterrupted',
            failureStage: 'process_restart',
          });
        }
      }
      this.completeModelCall(call.id, {
        status: 'interrupted',
        completedAt: at,
        errorType: 'ProcessInterrupted',
        failureStage: 'process_restart',
      });
    }
    for (const run of this.repository.listAgentRunsByStatus(['queued', 'running', 'streaming'])) {
      this.completeAgentRun(run.id, 'interrupted', at);
    }
    for (const turn of this.repository.listTurnsByStatus(['queued', 'running', 'streaming'])) {
      this.completeTurn(turn.id, 'interrupted', at);
    }
  }

  allocateSubscriptionCost(input: Omit<CostAllocationRecord, 'id' | 'createdAt'> & {
    id?: string;
    createdAt?: number;
  }): CostAllocationRecord {
    const record: CostAllocationRecord = {
      ...input,
      id: input.id ?? id('allocation'),
      createdAt: input.createdAt ?? this.now(),
    };
    this.repository.insertCostAllocation(record);
    return record;
  }

  getTurnAttribution(turnId: string): AgentRunAttribution[] {
    const runs = this.repository.listAgentRunsByTurn(turnId);
    const calls = this.repository.listModelCallsByTurn(turnId);
    const callsByRun = new Map<string, ModelCallRecord[]>();
    for (const call of calls) {
      callsByRun.set(call.agentRunId, [...(callsByRun.get(call.agentRunId) ?? []), call]);
    }
    const childrenByParent = new Map<string | null, AgentRunRecord[]>();
    for (const run of runs) {
      const key = run.parentAgentRunId;
      childrenByParent.set(key, [...(childrenByParent.get(key) ?? []), run]);
    }
    const allocationsByCall = new Map<string, CostAllocationRecord[]>();
    const allocationsFor = (callId: string): CostAllocationRecord[] => {
      let allocations = allocationsByCall.get(callId);
      if (!allocations) {
        allocations = this.repository.listCostAllocations(callId);
        allocationsByCall.set(callId, allocations);
      }
      return allocations;
    };

    const build = (run: AgentRunRecord): AgentRunAttribution => {
      const ownCalls = callsByRun.get(run.id) ?? [];
      const children = (childrenByParent.get(run.id) ?? []).map(build);

      const rollup = (
        pick: (call: ModelCallRecord) => MoneyComponent[],
        pickChild: (child: AgentRunAttribution) => CostRollup,
      ): CostRollup => {
        // `pick` emits one component per call for metered/API-equivalent costs
        // (null amount = value unknown), and one component per allocation row
        // for subscription costs (no rows = nothing allocated yet, not unknown).
        const selfComponents = ownCalls.flatMap(pick);
        const self =
          selfComponents.length > 0
            ? sumKnown(selfComponents)
            : ownCalls.length === 0
              ? { amount: 0 as number | null, currency: null, hasUnknown: false }
              : { amount: null, currency: null, hasUnknown: false };
        // Descendants: child runs contribute through their recursive totals only,
        // so nested costs are never counted twice.
        const descendantComponents = children.map((child) => {
          const childRollup = pickChild(child);
          return { amount: childRollup.totalMicros, currency: childRollup.currency };
        });
        const descendant = children.length
          ? sumKnown(descendantComponents)
          : { amount: null, currency: null, hasUnknown: false };
        const totalComponents = [
          // Skip a null "nothing recorded" self (e.g. unallocated subscription)
          // so it is not mistaken for an unknown metered value.
          ...(selfComponents.length > 0 || ownCalls.length === 0
            ? [{ amount: self.amount, currency: self.currency }]
            : []),
          ...descendantComponents,
        ];
        const total = totalComponents.length
          ? sumKnown(totalComponents)
          : { amount: null, currency: null, hasUnknown: false };
        return {
          selfMicros: self.amount,
          descendantMicros: descendant.amount,
          totalMicros: total.amount,
          hasUnknown: self.hasUnknown || descendant.hasUnknown,
          currency: total.currency ?? self.currency ?? descendant.currency,
        };
      };

      return {
        agentRun: run,
        apiEquivalent: rollup(
          (call) => [{ amount: call.apiEquivalentCostMicros, currency: call.apiEquivalentCurrency }],
          (child) => child.apiEquivalent,
        ),
        metered: rollup(
          (call) => [{ amount: call.meteredCostMicros, currency: call.meteredCurrency }],
          (child) => child.metered,
        ),
        // Absence of allocations means "not allocated yet", not "unknown".
        subscriptionAllocated: rollup(
          (call) =>
            allocationsFor(call.id).map((allocation) => ({
              amount: allocation.amountMicros,
              currency: allocation.currency,
            })),
          (child) => child.subscriptionAllocated,
        ),
        children,
      };
    };

    return (childrenByParent.get(null) ?? []).map(build);
  }

  private resolvePricing(
    attempt: Pick<ModelCallAttemptRecord, 'provider' | 'providerAccountId' | 'model'>,
    at: number,
  ): PricingSnapshotRecord | null {
    const candidates = this.repository
      .listPricingSnapshots(attempt.provider, attempt.model, at)
      .filter(
        (pricing) =>
          pricing.effectiveFrom <= at &&
          (pricing.effectiveTo === null || pricing.effectiveTo > at) &&
          (pricing.providerAccountId === null || pricing.providerAccountId === attempt.providerAccountId),
      )
      .sort((a, b) => {
        const accountDifference = Number(b.providerAccountId !== null) - Number(a.providerAccountId !== null);
        return accountDifference || b.effectiveFrom - a.effectiveFrom || b.createdAt - a.createdAt;
      });
    return candidates[0] ?? null;
  }
}
