export type BillingMode =
  | 'api'
  | 'subscription'
  | 'token_plan'
  | 'free'
  | 'local'
  | 'unknown'
  | (string & {});

export type TelemetryStatus =
  | 'queued'
  | 'running'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | (string & {});

export type UsageSource = 'provider_reported' | 'locally_estimated' | 'mixed' | 'unknown';

export type AgentRecord = {
  id: string;
  name: string;
  kind: string;
  persistent: boolean;
  ownerAgentId: string | null;
  defaultModelPolicyId: string | null;
  metadataJson: string | null;
  createdAt: number;
  deletedAt: number | null;
};

export type TurnRecord = {
  id: string;
  sessionId: string;
  userMessageId: string | null;
  status: TelemetryStatus;
  startedAt: number;
  completedAt: number | null;
  metadataJson: string | null;
};

export type AgentRunRecord = {
  id: string;
  agentId: string;
  parentAgentRunId: string | null;
  spawnedByAgentId: string | null;
  spawnedByRunId: string | null;
  sessionId: string;
  /** Optional context: null for runs that did not originate from a chat turn. */
  turnId: string | null;
  purpose: string | null;
  spawnReason: string | null;
  status: TelemetryStatus;
  startedAt: number;
  completedAt: number | null;
  agentNameSnapshot: string;
  agentKindSnapshot: string;
  metadataJson: string | null;
};

export type ProviderAccountRecord = {
  id: string;
  provider: string;
  displayLabel: string;
  billingMode: BillingMode;
  planReference: string | null;
  active: boolean;
  metadataJson: string | null;
  createdAt: number;
  updatedAt: number;
};

export type SubscriptionPlanRecord = {
  id: string;
  providerAccountId: string;
  name: string;
  billingMode: BillingMode;
  currency: string;
  priceMicros: number;
  periodStart: number;
  periodEnd: number;
  metadataJson: string | null;
  createdAt: number;
};

export type PricingSnapshotRecord = {
  id: string;
  provider: string;
  providerAccountId: string | null;
  model: string;
  inputPerMillionMicros: number | null;
  cacheReadPerMillionMicros: number | null;
  cacheWritePerMillionMicros: number | null;
  outputPerMillionMicros: number | null;
  reasoningPerMillionMicros: number | null;
  modalityRatesJson: string | null;
  currency: string;
  effectiveFrom: number;
  effectiveTo: number | null;
  source: string;
  notes: string | null;
  createdAt: number;
};

export type ModelCallRecord = {
  id: string;
  sessionId: string;
  /** Optional context: null for calls that did not originate from a chat turn. */
  turnId: string | null;
  messageId: string | null;
  generationId: string | null;
  agentId: string;
  agentRunId: string;
  ownsTurn: boolean;
  ownsAgentRun: boolean;
  parentCallId: string | null;
  providerAccountId: string;
  provider: string;
  model: string;
  providerRequestId: string | null;
  routeReason: string | null;
  routePolicyId: string | null;
  fallbackFromCallId: string | null;
  requestedAt: number;
  firstTokenAt: number | null;
  lastTokenAt: number | null;
  completedAt: number | null;
  ttftMs: number | null;
  generationDurationMs: number | null;
  totalLatencyMs: number | null;
  outputTokensPerSecondMilli: number | null;
  status: TelemetryStatus;
  finishReason: string | null;
  errorType: string | null;
  errorCode: string | null;
  failureStage: string | null;
  cancelledAt: number | null;
  modelContextLimit: number | null;
  contextTokens: number | null;
  contextUtilizationBps: number | null;
  requestedMaxOutputTokens: number | null;
  pricingSnapshotId: string | null;
  meteredCostMicros: number | null;
  meteredCurrency: string | null;
  meteredCostSource: string | null;
  apiEquivalentCostMicros: number | null;
  apiEquivalentCurrency: string | null;
  apiEquivalentCostSource: string | null;
  rawMetadataJson: string | null;
};

export type ModelCallAttemptRecord = {
  id: string;
  callId: string;
  attemptNumber: number;
  providerAccountId: string;
  provider: string;
  model: string;
  startedAt: number;
  responseReceivedAt: number | null;
  firstTokenAt: number | null;
  lastTokenAt: number | null;
  completedAt: number | null;
  latencyMs: number | null;
  providerRequestId: string | null;
  httpStatus: number | null;
  status: TelemetryStatus;
  errorType: string | null;
  errorCode: string | null;
  failureStage: string | null;
  pricingSnapshotId: string | null;
  meteredCostMicros: number | null;
  meteredCurrency: string | null;
  meteredCostSource: string | null;
  apiEquivalentCostMicros: number | null;
  apiEquivalentCurrency: string | null;
  apiEquivalentCostSource: string | null;
  rawMetadataJson: string | null;
};

export type TokenUsage = {
  reportedInputTokens: number | null;
  reportedUncachedInputTokens: number | null;
  reportedCacheReadTokens: number | null;
  reportedCacheWriteTokens: number | null;
  reportedOutputTokens: number | null;
  reportedReasoningTokens: number | null;
  reportedTotalTokens: number | null;
  estimatedInputTokens: number | null;
  estimatedUncachedInputTokens: number | null;
  estimatedCacheReadTokens: number | null;
  estimatedCacheWriteTokens: number | null;
  estimatedOutputTokens: number | null;
  estimatedReasoningTokens: number | null;
  estimatedTotalTokens: number | null;
  source: UsageSource;
  provenanceJson: string | null;
  providerUsageJson: string | null;
  contextComponentsJson: string | null;
  modalityUsageJson: string | null;
};

export type ModelCallUsageRecord = TokenUsage & { callId: string };
export type ModelCallAttemptUsageRecord = TokenUsage & { attemptId: string };

export type CostAllocationRecord = {
  id: string;
  callId: string;
  subscriptionPlanId: string;
  periodStart: number;
  periodEnd: number;
  amountMicros: number;
  currency: string;
  method: string;
  batchId: string | null;
  createdAt: number;
};

/**
 * Cost rollup for one agent run within an attribution tree.
 *
 * - `selfMicros`: known sum over the run's own model calls only (0 when the run
 *   made no calls or none of them have a known value).
 * - `descendantMicros`: known sum over child runs' recursive totals; null when
 *   the run has no children.
 * - `totalMicros`: `selfMicros + descendantMicros` over the known parts. Never
 *   double-counts: children contribute through their own `totalMicros` only.
 *   Null only when currencies are mixed within the subtree.
 * - `hasUnknown`: true when any contributing call/descendant has an unknown
 *   value or currencies are mixed, meaning the sums cover known parts only.
 * - `currency`: the single currency of the known parts, or null.
 */
export type CostRollup = {
  selfMicros: number | null;
  descendantMicros: number | null;
  totalMicros: number | null;
  hasUnknown: boolean;
  currency: string | null;
};

export type AgentRunAttribution = {
  agentRun: AgentRunRecord;
  /** What the usage would have cost at configured/registry API pricing. */
  apiEquivalent: CostRollup;
  /** What the provider actually charged per call, where known. */
  metered: CostRollup;
  /** Post-hoc subscription fee allocations attached to the run's calls. */
  subscriptionAllocated: CostRollup;
  children: AgentRunAttribution[];
};

export interface TelemetryRepository {
  insertAgent(record: AgentRecord): void;
  getAgent(id: string): AgentRecord | null;
  updateAgent(record: AgentRecord): void;
  insertTurn(record: TurnRecord): void;
  getTurn(id: string): TurnRecord | null;
  updateTurn(record: TurnRecord): void;
  insertAgentRun(record: AgentRunRecord): void;
  getAgentRun(id: string): AgentRunRecord | null;
  updateAgentRun(record: AgentRunRecord): void;
  listAgentRunsByTurn(turnId: string): AgentRunRecord[];
  listAgentRunsByStatus(statuses: TelemetryStatus[]): AgentRunRecord[];
  insertProviderAccount(record: ProviderAccountRecord): void;
  getProviderAccount(id: string): ProviderAccountRecord | null;
  updateProviderAccount(record: ProviderAccountRecord): void;
  insertSubscriptionPlan(record: SubscriptionPlanRecord): void;
  getSubscriptionPlan(id: string): SubscriptionPlanRecord | null;
  insertPricingSnapshot(record: PricingSnapshotRecord): void;
  getPricingSnapshot(id: string): PricingSnapshotRecord | null;
  listPricingSnapshots(provider: string, model: string, at: number): PricingSnapshotRecord[];
  insertModelCall(record: ModelCallRecord): void;
  getModelCall(id: string): ModelCallRecord | null;
  getModelCallByMessageId(messageId: string): ModelCallRecord | null;
  getModelCallByGenerationId(generationId: string): ModelCallRecord | null;
  updateModelCall(record: ModelCallRecord): void;
  listModelCallsBySession(sessionId: string): ModelCallRecord[];
  listModelCallsByTurn(turnId: string): ModelCallRecord[];
  listModelCallsByAgentRun(agentRunId: string): ModelCallRecord[];
  listModelCallsByAgent(agentId: string): ModelCallRecord[];
  listModelCallsByFallbackFrom(callId: string): ModelCallRecord[];
  listModelCallsByStatus(statuses: TelemetryStatus[]): ModelCallRecord[];
  insertModelCallAttempt(record: ModelCallAttemptRecord): void;
  getModelCallAttempt(id: string): ModelCallAttemptRecord | null;
  updateModelCallAttempt(record: ModelCallAttemptRecord): void;
  listModelCallAttempts(callId: string): ModelCallAttemptRecord[];
  putModelCallUsage(record: ModelCallUsageRecord): void;
  getModelCallUsage(callId: string): ModelCallUsageRecord | null;
  putModelCallAttemptUsage(record: ModelCallAttemptUsageRecord): void;
  getModelCallAttemptUsage(attemptId: string): ModelCallAttemptUsageRecord | null;
  insertCostAllocation(record: CostAllocationRecord): void;
  listCostAllocations(callId: string): CostAllocationRecord[];
  listTurnsByStatus(statuses: TelemetryStatus[]): TurnRecord[];
}
