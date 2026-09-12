import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStore } from '../persistence/memory-store.ts';
import { TelemetryService } from './telemetry.service.ts';
import type { PricingSnapshotRecord, TokenUsage } from './types.ts';
import { emptyTokenUsage } from './usage.ts';

function fullUsage(input = 100, output = 20): TokenUsage {
  return {
    ...emptyTokenUsage('provider_reported'),
    reportedUncachedInputTokens: input,
    reportedCacheReadTokens: 0,
    reportedCacheWriteTokens: 0,
    reportedOutputTokens: output,
    reportedReasoningTokens: 0,
    reportedTotalTokens: input + output,
  };
}

function price(id: string, provider: string, model: string, effectiveFrom = 0): PricingSnapshotRecord {
  return {
    id,
    provider,
    providerAccountId: null,
    model,
    inputPerMillionMicros: 1_000_000,
    cacheReadPerMillionMicros: 500_000,
    cacheWritePerMillionMicros: 2_000_000,
    outputPerMillionMicros: 4_000_000,
    reasoningPerMillionMicros: null,
    modalityRatesJson: null,
    currency: 'USD',
    effectiveFrom,
    effectiveTo: null,
    source: 'manual',
    notes: null,
    createdAt: effectiveFrom,
  };
}

function setup(now = 1_000) {
  const store = new MemoryStore();
  const telemetry = new TelemetryService(store, () => now);
  store.ensureConversation('session', 'SAM');
  telemetry.ensureAgent({ id: 'sam', name: 'SAM', kind: 'orchestrator', persistent: true, createdAt: now });
  telemetry.ensureProviderAccount({
    id: 'account_a',
    provider: 'provider_a',
    displayLabel: 'Provider A',
    billingMode: 'api',
    at: now,
  });
  const turn = telemetry.startTurn({ sessionId: 'session', startedAt: now });
  const run = telemetry.startAgentRun({
    agentId: 'sam',
    sessionId: 'session',
    turnId: turn.id,
    startedAt: now,
  });
  return { store, telemetry, turn, run };
}

function startCall(harness: ReturnType<typeof setup>, provider = 'provider_a', model = 'model_a') {
  return harness.telemetry.startModelCall({
    sessionId: 'session',
    turnId: harness.turn.id,
    agentId: 'sam',
    agentRunId: harness.run.id,
    providerAccountId: provider === 'provider_a' ? 'account_a' : 'account_b',
    provider,
    model,
    requestedAt: 1_000,
  });
}

test('successful call records timing, usage, request id, and configured API-equivalent cost', () => {
  const harness = setup();
  harness.telemetry.savePricingSnapshot(price('price_a', 'provider_a', 'model_a'));
  const call = startCall(harness);
  const attempt = harness.telemetry.startAttempt({
    callId: call.id,
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
    startedAt: 1_000,
  });
  harness.telemetry.recordResponse(attempt.id, { at: 1_050, httpStatus: 200 });
  harness.telemetry.recordToken(call.id, attempt.id, 1_100);
  harness.telemetry.recordToken(call.id, attempt.id, 1_200);
  harness.telemetry.completeAttempt(attempt.id, {
    status: 'completed',
    completedAt: 1_250,
    providerRequestId: 'req_1',
    usage: fullUsage(),
  });
  const completed = harness.telemetry.completeModelCall(call.id, {
    status: 'completed',
    completedAt: 1_250,
    finishReason: 'stop',
  });
  assert.equal(completed?.ttftMs, 100);
  assert.equal(completed?.generationDurationMs, 100);
  assert.equal(completed?.totalLatencyMs, 250);
  assert.equal(completed?.providerRequestId, 'req_1');
  assert.equal(completed?.apiEquivalentCostMicros, 180);
  assert.equal(harness.store.getModelCallUsage(call.id)?.reportedOutputTokens, 20);
});

test('subscription coverage keeps metered and API-equivalent costs separate', () => {
  const harness = setup();
  harness.telemetry.saveProviderAccount({
    ...harness.store.getProviderAccount('account_a')!,
    billingMode: 'subscription',
  });
  harness.telemetry.savePricingSnapshot(price('price_a', 'provider_a', 'model_a'));
  const call = startCall(harness);
  const attempt = harness.telemetry.startAttempt({
    callId: call.id,
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
  });
  harness.telemetry.completeAttempt(attempt.id, {
    status: 'completed',
    usage: fullUsage(),
    meteredCostMicros: 0,
    meteredCurrency: 'USD',
    meteredCostSource: 'provider_reported',
  });
  const completed = harness.telemetry.completeModelCall(call.id, { status: 'completed' });
  assert.equal(completed?.meteredCostMicros, 0);
  assert.equal(completed?.apiEquivalentCostMicros, 180);
});

test('retry attempts preserve failures and aggregate consumed usage and cost', () => {
  const harness = setup();
  harness.telemetry.savePricingSnapshot(price('price_a', 'provider_a', 'model_a'));
  const call = startCall(harness);
  const first = harness.telemetry.startAttempt({
    callId: call.id,
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
  });
  harness.telemetry.completeAttempt(first.id, {
    status: 'failed',
    usage: fullUsage(10, 2),
    errorType: 'TimeoutError',
    failureStage: 'stream',
    meteredCostMicros: 10_000,
    meteredCurrency: 'USD',
    meteredCostSource: 'provider_reported',
  });
  const second = harness.telemetry.startAttempt({
    callId: call.id,
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
  });
  harness.telemetry.completeAttempt(second.id, {
    status: 'completed',
    usage: fullUsage(20, 4),
    meteredCostMicros: 40_000,
    meteredCurrency: 'USD',
    meteredCostSource: 'provider_reported',
  });
  const completed = harness.telemetry.completeModelCall(call.id, { status: 'completed' });
  assert.equal(harness.store.listModelCallAttempts(call.id).length, 2);
  assert.equal(harness.store.getModelCallAttempt(first.id)?.errorType, 'TimeoutError');
  // Failed-attempt usage and cost are not overwritten by the successful retry.
  assert.equal(harness.store.getModelCallUsage(call.id)?.reportedUncachedInputTokens, 30);
  assert.equal(completed?.apiEquivalentCostMicros, 54);
  assert.equal(completed?.meteredCostMicros, 50_000);
});

test('provider/model fallback is a separate model call linked by lineage', () => {
  const harness = setup();
  harness.telemetry.ensureProviderAccount({
    id: 'account_b',
    provider: 'provider_b',
    displayLabel: 'Provider B',
    billingMode: 'api',
  });
  harness.telemetry.savePricingSnapshot(price('price_a', 'provider_a', 'model_a'));
  harness.telemetry.savePricingSnapshot(price('price_b', 'provider_b', 'model_b'));
  const grok = startCall(harness);
  const grokAttempt = harness.telemetry.startAttempt({
    callId: grok.id,
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
  });
  harness.telemetry.completeAttempt(grokAttempt.id, {
    status: 'failed',
    usage: fullUsage(10, 2),
    meteredCostMicros: 20_000,
    meteredCurrency: 'USD',
    meteredCostSource: 'provider_reported',
  });
  harness.telemetry.completeModelCall(grok.id, { status: 'failed', failureStage: 'stream' });

  const qwen = harness.telemetry.startModelCall({
    sessionId: 'session',
    turnId: harness.turn.id,
    agentId: 'sam',
    agentRunId: harness.run.id,
    providerAccountId: 'account_b',
    provider: 'provider_b',
    model: 'model_b',
    routeReason: 'fallback',
    fallbackFromCallId: grok.id,
    requestedAt: 2_000,
  });
  const qwenAttempt = harness.telemetry.startAttempt({
    callId: qwen.id,
    providerAccountId: 'account_b',
    provider: 'provider_b',
    model: 'model_b',
  });
  harness.telemetry.completeAttempt(qwenAttempt.id, {
    status: 'completed',
    usage: fullUsage(20, 4),
    meteredCostMicros: 40_000,
    meteredCurrency: 'USD',
    meteredCostSource: 'provider_reported',
  });
  harness.telemetry.completeModelCall(qwen.id, { status: 'completed' });

  // Both calls stay independently queryable, connected by fallback lineage.
  assert.equal(harness.store.getModelCall(grok.id)?.status, 'failed');
  assert.equal(harness.store.getModelCall(grok.id)?.meteredCostMicros, 20_000);
  assert.equal(harness.store.getModelCall(qwen.id)?.meteredCostMicros, 40_000);
  assert.deepEqual(
    harness.store.listModelCallsByFallbackFrom(grok.id).map((call) => call.id),
    [qwen.id],
  );
  // Both roll up to the originating agent run.
  const attribution = harness.telemetry.getTurnAttribution(harness.turn.id)[0];
  assert.equal(attribution.apiEquivalent.totalMicros, 54);
  assert.equal(attribution.metered.totalMicros, 60_000);

  assert.throws(
    () =>
      harness.telemetry.startModelCall({
        sessionId: 'session',
        turnId: harness.turn.id,
        agentId: 'sam',
        agentRunId: harness.run.id,
        providerAccountId: 'account_a',
        provider: 'provider_a',
        model: 'model_a',
        fallbackFromCallId: 'missing_call',
      }),
    /Unknown fallback origin/,
  );
});

test('parent and child agent-run costs roll up recursively', () => {
  const harness = setup();
  harness.telemetry.ensureAgent({
    id: 'worker',
    name: 'Research worker',
    kind: 'research',
    persistent: false,
  });
  harness.telemetry.savePricingSnapshot(price('price_a', 'provider_a', 'model_a'));
  const childRun = harness.telemetry.startAgentRun({
    agentId: 'worker',
    parentAgentRunId: harness.run.id,
    spawnedByAgentId: 'sam',
    spawnedByRunId: harness.run.id,
    sessionId: 'session',
    turnId: harness.turn.id,
  });
  for (const [agentId, runId, input, output] of [
    ['sam', harness.run.id, 100, 20],
    ['worker', childRun.id, 50, 10],
  ] as const) {
    const call = harness.telemetry.startModelCall({
      sessionId: 'session',
      turnId: harness.turn.id,
      agentId,
      agentRunId: runId,
      providerAccountId: 'account_a',
      provider: 'provider_a',
      model: 'model_a',
    });
    const attempt = harness.telemetry.startAttempt({
      callId: call.id,
      providerAccountId: 'account_a',
      provider: 'provider_a',
      model: 'model_a',
    });
    harness.telemetry.completeAttempt(attempt.id, { status: 'completed', usage: fullUsage(input, output) });
    harness.telemetry.completeModelCall(call.id, { status: 'completed' });
  }
  const root = harness.telemetry.getTurnAttribution(harness.turn.id)[0];
  assert.equal(root.apiEquivalent.selfMicros, 180);
  assert.equal(root.children[0].apiEquivalent.selfMicros, 90);
  assert.equal(root.children[0].apiEquivalent.descendantMicros, null);
  assert.equal(root.apiEquivalent.descendantMicros, 90);
  assert.equal(root.apiEquivalent.totalMicros, 270);
  assert.equal(root.apiEquivalent.hasUnknown, false);
});

test('temporary agent soft deletion preserves historical runs and calls', () => {
  const harness = setup();
  harness.telemetry.ensureAgent({ id: 'temp', name: 'Temp worker', kind: 'temporary', persistent: false });
  const run = harness.telemetry.startAgentRun({
    agentId: 'temp',
    sessionId: 'session',
    turnId: harness.turn.id,
  });
  harness.telemetry.deleteAgent('temp', 2_000);
  assert.equal(harness.store.getAgent('temp')?.deletedAt, 2_000);
  assert.equal(harness.store.getAgentRun(run.id)?.agentNameSnapshot, 'Temp worker');
  assert.throws(
    () =>
      harness.telemetry.startAgentRun({
        agentId: 'temp',
        sessionId: 'session',
        turnId: harness.turn.id,
      }),
    /Unknown agent/,
  );
});

test('agent-run parents must belong to the same session and turn', () => {
  const harness = setup();
  const otherTurn = harness.telemetry.startTurn({ sessionId: 'session' });
  assert.throws(
    () =>
      harness.telemetry.startAgentRun({
        agentId: 'sam',
        parentAgentRunId: harness.run.id,
        sessionId: 'session',
        turnId: otherTurn.id,
      }),
    /same session and turn/,
  );
});

test('historical pricing remains attached after a later pricing update', () => {
  const harness = setup();
  harness.telemetry.savePricingSnapshot(price('old', 'provider_a', 'model_a', 0));
  const call = startCall(harness);
  const attempt = harness.telemetry.startAttempt({
    callId: call.id,
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
    startedAt: 1_000,
  });
  harness.telemetry.completeAttempt(attempt.id, { status: 'completed', usage: fullUsage() });
  harness.telemetry.completeModelCall(call.id, { status: 'completed' });
  harness.telemetry.savePricingSnapshot({
    ...price('new', 'provider_a', 'model_a', 2_000),
    inputPerMillionMicros: 99_000_000,
  });
  assert.equal(harness.store.getModelCall(call.id)?.pricingSnapshotId, 'old');
  assert.equal(harness.store.getModelCall(call.id)?.apiEquivalentCostMicros, 180);
});

test('unknown failed-attempt usage prevents a misleading zero aggregate cost', () => {
  const harness = setup();
  harness.telemetry.savePricingSnapshot(price('price_a', 'provider_a', 'model_a'));
  const call = startCall(harness);
  const failed = harness.telemetry.startAttempt({
    callId: call.id,
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
  });
  harness.telemetry.completeAttempt(failed.id, { status: 'failed', failureStage: 'request' });
  const success = harness.telemetry.startAttempt({
    callId: call.id,
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
  });
  harness.telemetry.completeAttempt(success.id, { status: 'completed', usage: fullUsage() });
  const completed = harness.telemetry.completeModelCall(call.id, { status: 'completed' });
  assert.equal(completed?.apiEquivalentCostMicros, null);
  assert.equal(harness.store.getModelCallUsage(call.id)?.reportedOutputTokens, null);
});

test('individual orphan interruption respects shared run ownership', () => {
  const harness = setup();
  const call = startCall(harness);
  const attempt = harness.telemetry.startAttempt({
    callId: call.id,
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
  });
  harness.telemetry.interruptGeneration(call.generationId ?? 'missing', 'restart', 2_000);
  assert.equal(harness.store.getModelCallAttempt(attempt.id)?.status, 'running');

  const owned = harness.telemetry.startModelCall({
    sessionId: 'session',
    turnId: harness.turn.id,
    agentId: 'sam',
    agentRunId: harness.run.id,
    ownsTurn: false,
    ownsAgentRun: false,
    generationId: 'generation_1',
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
  });
  harness.telemetry.startAttempt({
    callId: owned.id,
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
  });
  harness.telemetry.interruptGeneration('generation_1', 'restart', 2_000);
  assert.equal(harness.store.getModelCall(owned.id)?.status, 'interrupted');
  assert.equal(harness.store.getAgentRun(harness.run.id)?.status, 'running');
  assert.equal(harness.store.getTurn(harness.turn.id)?.status, 'running');
});

test('startup recovery closes partial calls, runs, and turns left before a model call was inserted', () => {
  const harness = setup();
  harness.telemetry.recoverOrphans(2_000);
  assert.equal(harness.store.getAgentRun(harness.run.id)?.status, 'interrupted');
  assert.equal(harness.store.getTurn(harness.turn.id)?.status, 'interrupted');
});

test('invalid negative or fractional pricing is rejected before use', () => {
  const harness = setup();
  assert.throws(
    () =>
      harness.telemetry.savePricingSnapshot({
        ...price('bad', 'provider_a', 'model_a'),
        inputPerMillionMicros: -1,
      }),
    /non-negative integer/,
  );
  assert.throws(
    () =>
      harness.telemetry.savePricingSnapshot({
        ...price('fractional', 'provider_a', 'model_a'),
        outputPerMillionMicros: 1.5,
      }),
    /non-negative integer/,
  );
});

type RunHandle = { agentId: string; runId: string };

function completedCallWithApiEquivalent(
  harness: ReturnType<typeof setup>,
  handle: RunHandle,
  apiEquivalentMicros: number,
  requestedAt: number,
): void {
  const call = harness.telemetry.startModelCall({
    sessionId: 'session',
    turnId: harness.turn.id,
    agentId: handle.agentId,
    agentRunId: handle.runId,
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
    requestedAt,
  });
  const attempt = harness.telemetry.startAttempt({
    callId: call.id,
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
  });
  harness.telemetry.completeAttempt(attempt.id, {
    status: 'completed',
    usage: fullUsage(),
    apiEquivalentCostMicros: apiEquivalentMicros,
    apiEquivalentCurrency: 'USD',
    apiEquivalentCostSource: 'test',
  });
  harness.telemetry.completeModelCall(call.id, { status: 'completed' });
}

test('nested agents roll up self, descendant, and total cost without double-counting', () => {
  const harness = setup();
  for (const agent of [
    { id: 'finn', name: 'Finn', kind: 'finance_specialist', persistent: true },
    { id: 'research', name: 'Research Worker', kind: 'research_worker', persistent: false },
    { id: 'web', name: 'Web Worker', kind: 'web_worker', persistent: false },
    { id: 'security', name: 'Security Worker', kind: 'security_worker', persistent: false },
  ]) {
    harness.telemetry.ensureAgent(agent);
  }
  const run = (agentId: string, parentAgentRunId: string | null, startedAt: number) =>
    harness.telemetry.startAgentRun({
      agentId,
      parentAgentRunId,
      spawnedByAgentId: parentAgentRunId ? 'sam' : null,
      spawnedByRunId: parentAgentRunId,
      sessionId: 'session',
      turnId: harness.turn.id,
      startedAt,
    }).id;

  const samRun = harness.run.id;
  const finnRun = run('finn', samRun, 1_010);
  const researchRun = run('research', samRun, 1_020);
  const webARun = run('web', researchRun, 1_030);
  const webBRun = run('web', researchRun, 1_040);
  const securityRun = run('security', samRun, 1_050);

  completedCallWithApiEquivalent(harness, { agentId: 'sam', runId: samRun }, 500_000, 1_100);
  completedCallWithApiEquivalent(harness, { agentId: 'finn', runId: finnRun }, 250_000, 1_110);
  completedCallWithApiEquivalent(harness, { agentId: 'research', runId: researchRun }, 310_000, 1_120);
  completedCallWithApiEquivalent(harness, { agentId: 'web', runId: webARun }, 520_000, 1_130);
  completedCallWithApiEquivalent(harness, { agentId: 'web', runId: webBRun }, 420_000, 1_140);
  completedCallWithApiEquivalent(harness, { agentId: 'security', runId: securityRun }, 1_000_000, 1_150);

  const roots = harness.telemetry.getTurnAttribution(harness.turn.id);
  assert.equal(roots.length, 1);
  const sam = roots[0];
  const byAgent = new Map(
    [sam, ...sam.children.flatMap((child) => [child, ...child.children])].map((node) => [
      node.agentRun.agentId,
      node,
    ]),
  );
  assert.equal(sam.apiEquivalent.selfMicros, 500_000);
  assert.equal(byAgent.get('finn')?.apiEquivalent.totalMicros, 250_000);
  const research = byAgent.get('research')!;
  assert.equal(research.apiEquivalent.selfMicros, 310_000);
  assert.equal(research.apiEquivalent.descendantMicros, 940_000);
  assert.equal(research.apiEquivalent.totalMicros, 1_250_000);
  assert.equal(byAgent.get('security')?.apiEquivalent.totalMicros, 1_000_000);

  // Turn total: $0.50 + $0.25 + $0.31 + $0.52 + $0.42 + $1.00 = $3.00.
  // Research's recursive total already contains Web A and Web B; the turn total
  // must not add those descendants a second time.
  const turnTotal = roots.reduce((sum, node) => sum + (node.apiEquivalent.totalMicros ?? 0), 0);
  assert.equal(turnTotal, 3_000_000);
  const selfSum = [sam, ...sam.children, ...research.children].reduce(
    (sum, node) => sum + (node.apiEquivalent.selfMicros ?? 0),
    0,
  );
  assert.equal(selfSum, 3_000_000);
  assert.equal(sam.apiEquivalent.hasUnknown, false);
});

test('subscription calls keep metered, API-equivalent, and allocated costs distinct', () => {
  const harness = setup();
  harness.telemetry.saveProviderAccount({
    ...harness.store.getProviderAccount('account_a')!,
    billingMode: 'subscription',
  });
  harness.telemetry.saveSubscriptionPlan({
    id: 'plan_a',
    providerAccountId: 'account_a',
    name: 'ChatGPT Plus',
    billingMode: 'subscription',
    currency: 'USD',
    priceMicros: 20_000_000,
    periodStart: 0,
    periodEnd: 2_592_000_000,
    metadataJson: null,
    createdAt: 0,
  });
  harness.telemetry.savePricingSnapshot(price('price_a', 'provider_a', 'model_a'));
  const call = startCall(harness);
  const attempt = harness.telemetry.startAttempt({
    callId: call.id,
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
  });
  harness.telemetry.completeAttempt(attempt.id, {
    status: 'completed',
    // API-equivalent value of this usage at configured pricing: $0.00018.
    usage: fullUsage(),
    // The subscription provider charged nothing per call: explicitly zero.
    meteredCostMicros: 0,
    meteredCurrency: 'USD',
    meteredCostSource: 'provider_reported',
  });
  harness.telemetry.completeModelCall(call.id, { status: 'completed' });

  let attribution = harness.telemetry.getTurnAttribution(harness.turn.id)[0];
  assert.equal(attribution.apiEquivalent.totalMicros, 180);
  assert.equal(attribution.metered.totalMicros, 0);
  assert.equal(attribution.metered.hasUnknown, false);
  // Not allocated yet: absence of allocations is neither "zero" nor "unknown".
  assert.equal(attribution.subscriptionAllocated.selfMicros, null);
  assert.equal(attribution.subscriptionAllocated.totalMicros, null);
  assert.equal(attribution.subscriptionAllocated.hasUnknown, false);

  harness.telemetry.allocateSubscriptionCost({
    callId: call.id,
    subscriptionPlanId: 'plan_a',
    periodStart: 0,
    periodEnd: 2_592_000_000,
    amountMicros: 180,
    currency: 'USD',
    method: 'api_equivalent_proportional',
    batchId: 'batch_1',
  });
  attribution = harness.telemetry.getTurnAttribution(harness.turn.id)[0];
  assert.equal(attribution.subscriptionAllocated.selfMicros, 180);
  assert.equal(attribution.subscriptionAllocated.totalMicros, 180);
  // The API-equivalent value is still not reported as actual spend.
  assert.equal(attribution.metered.totalMicros, 0);
});

test('runs and calls without a chat turn are first-class (background work)', () => {
  const harness = setup();
  harness.telemetry.ensureAgent({ id: 'cron', name: 'Scheduler worker', kind: 'temporary', persistent: false });
  const run = harness.telemetry.startAgentRun({
    agentId: 'cron',
    sessionId: 'session',
    purpose: 'Nightly summary',
    spawnReason: 'scheduled_job',
  });
  assert.equal(run.turnId, null);
  const child = harness.telemetry.startAgentRun({
    agentId: 'sam',
    parentAgentRunId: run.id,
    sessionId: 'session',
  });
  assert.equal(child.turnId, null);
  const call = harness.telemetry.startModelCall({
    sessionId: 'session',
    agentId: 'cron',
    agentRunId: run.id,
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
    routeReason: 'cheap_background',
  });
  assert.equal(call.turnId, null);
  assert.throws(
    () =>
      harness.telemetry.startAgentRun({
        agentId: 'sam',
        parentAgentRunId: run.id,
        sessionId: 'session',
        turnId: harness.turn.id,
      }),
    /same session and turn/,
  );
  harness.telemetry.recoverOrphans(5_000);
  assert.equal(harness.store.getAgentRun(run.id)?.status, 'interrupted');
  assert.equal(harness.store.getModelCall(call.id)?.status, 'interrupted');
});

test('model calls are validated against their agent run and lineage', () => {
  const harness = setup();
  assert.throws(
    () =>
      harness.telemetry.startModelCall({
        sessionId: 'session',
        turnId: harness.turn.id,
        agentId: 'sam',
        agentRunId: 'missing_run',
        providerAccountId: 'account_a',
        provider: 'provider_a',
        model: 'model_a',
      }),
    /Unknown agent run/,
  );
  assert.throws(
    () =>
      harness.telemetry.startModelCall({
        sessionId: 'session',
        turnId: harness.turn.id,
        agentId: 'sam',
        agentRunId: harness.run.id,
        parentCallId: 'missing_call',
        providerAccountId: 'account_a',
        provider: 'provider_a',
        model: 'model_a',
      }),
    /Unknown parent model call/,
  );
});

test('finalization is idempotent and closed calls reject new attempts', () => {
  const harness = setup();
  harness.telemetry.savePricingSnapshot(price('price_a', 'provider_a', 'model_a'));
  const call = startCall(harness);
  const attempt = harness.telemetry.startAttempt({
    callId: call.id,
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
    startedAt: 1_000,
  });
  harness.telemetry.completeAttempt(attempt.id, {
    status: 'completed',
    completedAt: 1_200,
    usage: fullUsage(),
  });
  // Duplicate attempt finalization keeps the first terminal record.
  const again = harness.telemetry.completeAttempt(attempt.id, {
    status: 'failed',
    completedAt: 9_999,
    errorType: 'LateError',
  });
  assert.equal(again?.status, 'completed');
  assert.equal(again?.completedAt, 1_200);

  const completed = harness.telemetry.completeModelCall(call.id, { status: 'completed', completedAt: 1_250 });
  assert.equal(completed?.apiEquivalentCostMicros, 180);
  const repeated = harness.telemetry.completeModelCall(call.id, { status: 'failed', completedAt: 9_999 });
  assert.equal(repeated?.status, 'completed');
  assert.equal(repeated?.apiEquivalentCostMicros, 180);
  assert.equal(harness.store.listModelCallAttempts(call.id).length, 1);
  assert.throws(
    () =>
      harness.telemetry.startAttempt({
        callId: call.id,
        providerAccountId: 'account_a',
        provider: 'provider_a',
        model: 'model_a',
      }),
    /already finalized/,
  );

  harness.telemetry.completeTurn(harness.turn.id, 'completed', 1_300);
  harness.telemetry.completeTurn(harness.turn.id, 'failed', 9_999);
  assert.equal(harness.store.getTurn(harness.turn.id)?.status, 'completed');
  harness.telemetry.completeAgentRun(harness.run.id, 'completed', 1_300);
  harness.telemetry.completeAgentRun(harness.run.id, 'failed', 9_999);
  assert.equal(harness.store.getAgentRun(harness.run.id)?.status, 'completed');
});

test('fallback API-equivalent cost applies only without configured pricing', () => {
  const harness = setup();
  const call = startCall(harness);
  const attempt = harness.telemetry.startAttempt({
    callId: call.id,
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
  });
  harness.telemetry.completeAttempt(attempt.id, {
    status: 'completed',
    usage: fullUsage(),
    apiEquivalentCostMicros: 740_000,
    apiEquivalentCurrency: 'USD',
    apiEquivalentCostSource: 'pi_registry_pricing',
  });
  let completed = harness.telemetry.completeModelCall(call.id, { status: 'completed' });
  assert.equal(completed?.apiEquivalentCostMicros, 740_000);
  assert.equal(completed?.apiEquivalentCostSource, 'attempt_aggregate');
  assert.equal(harness.store.getModelCallAttempt(attempt.id)?.apiEquivalentCostSource, 'pi_registry_pricing');
  assert.equal(harness.store.getModelCallAttempt(attempt.id)?.pricingSnapshotId, null);

  // Configured pricing snapshots win over the external fallback.
  const harness2 = setup();
  harness2.telemetry.savePricingSnapshot(price('price_a', 'provider_a', 'model_a'));
  const call2 = startCall(harness2);
  const attempt2 = harness2.telemetry.startAttempt({
    callId: call2.id,
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
  });
  harness2.telemetry.completeAttempt(attempt2.id, {
    status: 'completed',
    usage: fullUsage(),
    apiEquivalentCostMicros: 740_000,
    apiEquivalentCurrency: 'USD',
    apiEquivalentCostSource: 'pi_registry_pricing',
  });
  completed = harness2.telemetry.completeModelCall(call2.id, { status: 'completed' });
  assert.equal(completed?.apiEquivalentCostMicros, 180);
  assert.equal(harness2.store.getModelCallAttempt(attempt2.id)?.pricingSnapshotId, 'price_a');
});

test('timing and output speed come from the successful attempt, not retry spans', () => {
  const harness = setup();
  const call = startCall(harness);
  const first = harness.telemetry.startAttempt({
    callId: call.id,
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
    startedAt: 1_000,
  });
  harness.telemetry.recordToken(call.id, first.id, 1_100);
  harness.telemetry.recordToken(call.id, first.id, 1_200);
  harness.telemetry.completeAttempt(first.id, { status: 'failed', completedAt: 1_300, failureStage: 'stream' });
  const second = harness.telemetry.startAttempt({
    callId: call.id,
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
    startedAt: 2_000,
  });
  harness.telemetry.recordToken(call.id, second.id, 2_500);
  harness.telemetry.recordToken(call.id, second.id, 2_600);
  harness.telemetry.completeAttempt(second.id, {
    status: 'completed',
    completedAt: 2_650,
    usage: { ...emptyTokenUsage('provider_reported'), reportedOutputTokens: 50 },
  });
  const completed = harness.telemetry.completeModelCall(call.id, { status: 'completed', completedAt: 2_700 });
  assert.equal(completed?.firstTokenAt, 2_500);
  assert.equal(completed?.lastTokenAt, 2_600);
  assert.equal(completed?.ttftMs, 1_500);
  assert.equal(completed?.generationDurationMs, 100);
  assert.equal(completed?.totalLatencyMs, 1_700);
  assert.equal(completed?.outputTokensPerSecondMilli, 500_000);
});

test('deleted temporary agents keep attributable history', () => {
  const harness = setup();
  harness.telemetry.ensureAgent({ id: 'temp', name: 'One-off worker', kind: 'temporary', persistent: false });
  const run = harness.telemetry.startAgentRun({
    agentId: 'temp',
    parentAgentRunId: harness.run.id,
    sessionId: 'session',
    turnId: harness.turn.id,
  });
  completedCallWithApiEquivalent(harness, { agentId: 'temp', runId: run.id }, 125_000, 1_100);
  harness.telemetry.deleteAgent('temp', 2_000);
  const attribution = harness.telemetry.getTurnAttribution(harness.turn.id)[0];
  assert.equal(attribution.children[0].apiEquivalent.totalMicros, 125_000);
  assert.equal(attribution.children[0].agentRun.agentNameSnapshot, 'One-off worker');
  assert.equal(harness.store.listModelCallsByAgent('temp').length, 1);
});

test('session usage summary aggregates tokens and cost across calls', () => {
  const harness = setup();
  completedCallWithApiEquivalent(harness, { agentId: 'sam', runId: harness.run.id }, 180, 1_100);
  completedCallWithApiEquivalent(harness, { agentId: 'sam', runId: harness.run.id }, 460, 1_200);
  const summary = harness.telemetry.getSessionUsageSummary('session');
  assert.equal(summary?.inputTokens, 200);
  assert.equal(summary?.cacheReadTokens, 0);
  assert.equal(summary?.outputTokens, 40);
  assert.equal(summary?.costMicros, 640);
  assert.equal(summary?.currency, 'USD');
  assert.equal(summary?.hasUnknownCost, false);
});

test('session usage summary reports context fullness from the latest call', () => {
  const harness = setup();
  const call = harness.telemetry.startModelCall({
    sessionId: 'session',
    turnId: harness.turn.id,
    agentId: 'sam',
    agentRunId: harness.run.id,
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
    modelContextLimit: 1_000,
    requestedAt: 1_000,
  });
  const attempt = harness.telemetry.startAttempt({
    callId: call.id,
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
    startedAt: 1_000,
  });
  harness.telemetry.completeAttempt(attempt.id, { status: 'completed', usage: fullUsage(100, 20) });
  harness.telemetry.completeModelCall(call.id, { status: 'completed' });
  const summary = harness.telemetry.getSessionUsageSummary('session');
  assert.equal(summary?.contextPercent, 12);
});

test('session usage summary flags unknown cost and skips sessions without calls', () => {
  const harness = setup();
  const call = startCall(harness);
  const attempt = harness.telemetry.startAttempt({
    callId: call.id,
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
    startedAt: 1_000,
  });
  harness.telemetry.completeAttempt(attempt.id, { status: 'completed', usage: fullUsage() });
  harness.telemetry.completeModelCall(call.id, { status: 'completed' });
  const summary = harness.telemetry.getSessionUsageSummary('session');
  assert.equal(summary?.inputTokens, 100);
  assert.equal(summary?.outputTokens, 20);
  assert.equal(summary?.costMicros, null);
  assert.equal(summary?.hasUnknownCost, true);
  assert.equal(harness.telemetry.getSessionUsageSummary('empty'), null);
});

test('turn usage detail reports the latest turn call and agent tree', () => {
  const harness = setup();
  harness.telemetry.savePricingSnapshot(price('price_a', 'provider_a', 'model_a'));
  const call = startCall(harness);
  const attempt = harness.telemetry.startAttempt({
    callId: call.id,
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
    startedAt: 1_000,
  });
  harness.telemetry.recordToken(call.id, attempt.id, 1_410);
  harness.telemetry.completeAttempt(attempt.id, {
    status: 'completed',
    completedAt: 3_800,
    usage: fullUsage(324, 188),
  });
  harness.telemetry.completeModelCall(call.id, { status: 'completed', completedAt: 3_800 });
  const detail = harness.telemetry.getTurnUsageDetail('session');
  assert.equal(detail?.agentName, 'SAM');
  assert.equal(detail?.uncachedInputTokens, 324);
  assert.equal(detail?.outputTokens, 188);
  assert.equal(detail?.ttftMs, 410);
  assert.equal(detail?.latencyMs, 2_800);
  assert.equal(detail?.attribution[0]?.agentRun.agentNameSnapshot, 'SAM');
});

test('user model pricing overrides provider-reported registry cost', () => {
  const harness = setup();
  const snapshot = harness.telemetry.saveUserModelPricing({
    provider: 'provider_a',
    model: 'model_a',
    inputPerMillionMicros: 300_000,
    outputPerMillionMicros: 1_200_000,
  });
  assert.equal(snapshot.source, 'user_override');
  assert.equal(harness.telemetry.currentPricing('provider_a', 'model_a')?.id, snapshot.id);
  const call = startCall(harness);
  const attempt = harness.telemetry.startAttempt({
    callId: call.id,
    providerAccountId: 'account_a',
    provider: 'provider_a',
    model: 'model_a',
    startedAt: 1_000,
  });
  harness.telemetry.completeAttempt(attempt.id, {
    status: 'completed',
    usage: fullUsage(),
    apiEquivalentCostMicros: 999_999,
    apiEquivalentCurrency: 'USD',
    apiEquivalentCostSource: 'pi_registry_pricing',
  });
  const completed = harness.telemetry.completeModelCall(call.id, { status: 'completed' });
  assert.equal(completed?.pricingSnapshotId, snapshot.id);
  assert.equal(completed?.apiEquivalentCostMicros, 54);
  assert.equal(harness.store.getModelCallAttempt(attempt.id)?.pricingSnapshotId, snapshot.id);
  assert.equal(harness.store.getModelCallAttempt(attempt.id)?.apiEquivalentCostSource, 'configured_pricing:provider_reported');
});
