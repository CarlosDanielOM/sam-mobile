import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentRunAttribution } from './telemetry/types.ts';
import type { TurnUsageDetail } from './telemetry/telemetry.service.ts';
import { flattenAgentCosts, formatDuration, formatMoney, formatSpeed, formatTokens, formatTurnUsage } from './turn-usage.ts';

function run(name: string, total: number, children: AgentRunAttribution[] = []): AgentRunAttribution {
  return {
    agentRun: {
      id: name,
      agentId: name,
      parentAgentRunId: null,
      spawnedByAgentId: null,
      spawnedByRunId: null,
      sessionId: 'session',
      turnId: 'turn',
      purpose: null,
      spawnReason: null,
      status: 'completed',
      startedAt: 0,
      completedAt: 1,
      agentNameSnapshot: name,
      agentKindSnapshot: 'worker',
      metadataJson: null,
    },
    apiEquivalent: {
      selfMicros: total,
      descendantMicros: children.length ? children.reduce((sum, child) => sum + (child.apiEquivalent.totalMicros ?? 0), 0) : null,
      totalMicros: total,
      hasUnknown: false,
      currency: 'USD',
    },
    metered: { selfMicros: 0, descendantMicros: null, totalMicros: 0, hasUnknown: false, currency: 'USD' },
    subscriptionAllocated: { selfMicros: 0, descendantMicros: null, totalMicros: 0, hasUnknown: false, currency: 'USD' },
    children,
  };
}

test('formats money, duration, and speed for the usage panel', () => {
  assert.equal(formatMoney(400), '$0.0004');
  assert.equal(formatMoney(0), '$0.0000');
  assert.equal(formatMoney(null), '—');
  assert.equal(formatDuration(410), '410 ms');
  assert.equal(formatDuration(2800), '2.8 s');
  assert.equal(formatSpeed(67_142), '67 tok/s');
});

test('compact session tokens distinguish unknown from zero', () => {
  assert.equal(formatTokens(null), '—');
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(20), '20');
  assert.equal(formatTokens(1_200), '1.2k');
  assert.equal(formatTokens(1_200_000), '1.2M');
});

test('flattens nested agent costs for future multi-agent turns', () => {
  const tree = flattenAgentCosts([
    {
      ...run('SAM', 6_100, [run('Finn', 4_800), run('Research', 20_300)]),
      apiEquivalent: {
        selfMicros: 6_100,
        descendantMicros: 25_100,
        totalMicros: 31_200,
        hasUnknown: false,
        currency: 'USD',
      },
      children: [run('Finn', 4_800), run('Research', 20_300)],
    },
  ]);
  assert.deepEqual(
    tree.map((row) => `${row.label} ${row.cost}`),
    ['SAM $0.0061', '├─ Finn $0.0048', '└─ Research $0.0203'],
  );
});

function usageDetail(overrides: Partial<TurnUsageDetail> = {}): TurnUsageDetail {
  return {
    turnId: 'turn',
    agentName: 'SAM',
    providerId: 'minimax',
    modelId: 'MiniMax-M3',
    accountLabel: 'MiniMax',
    billingMode: 'subscription',
    apiEquivalentMicros: 400,
    apiEquivalentCurrency: 'USD',
    meteredMicros: 0,
    meteredCurrency: 'USD',
    uncachedInputTokens: 324,
    cacheReadTokens: 606,
    cacheWriteTokens: null,
    outputTokens: 188,
    reasoningTokens: null,
    ttftMs: 410,
    latencyMs: 2800,
    tokensPerSecondMilli: 67_142,
    attribution: [run('SAM', 400)],
    ...overrides,
  };
}

test('single-agent turn hides the agent tree', () => {
  const view = formatTurnUsage(usageDetail());
  assert.equal(view.title, 'SAM turn');
  assert.equal(view.showAgents, false);
  assert.equal(view.apiEquivalent, '$0.0004');
  assert.equal(view.metered, '$0.0000 / subscription');
  assert.equal(view.rows.find((row) => row.label === 'cache write')?.value, '—');
  assert.equal(view.rows.find((row) => row.label === 'Provider')?.value, 'MiniMax');
  assert.equal(view.rows.find((row) => row.label === 'Account')?.value, 'MiniMax subscription');
});

test('turn total sums all retry roots, without counting descendants twice', () => {
  const original = run('original', 3_000, [run('child', 1_000)]);
  original.apiEquivalent.selfMicros = 2_000;
  const detail = usageDetail({ attribution: [original, run('retry', 3_000)] });
  assert.equal(formatTurnUsage(detail).turnTotal, '$0.0060');
});

test('turn totals distinguish partial, unknown, mixed-currency, and zero costs', () => {
  const known = run('known', 3_000);
  const unknown = run('unknown', 0);
  unknown.apiEquivalent = { selfMicros: null, descendantMicros: null, totalMicros: null, currency: null, hasUnknown: true };
  const view = (roots: AgentRunAttribution[]) => formatTurnUsage(usageDetail({ attribution: roots }));
  assert.equal(view([known, unknown]).turnTotal, '$0.0030+');
  assert.equal(view([unknown, unknown]).turnTotal, '—');
  const euro = run('euro', 3_000);
  euro.apiEquivalent.currency = 'EUR';
  assert.equal(view([known, euro]).turnTotal, '—');
  assert.equal(view([run('free1', 0), run('free2', 0)]).turnTotal, '$0.0000');
});

test('unknown metered amounts are not displayed as free for any billing mode', () => {
  for (const billingMode of ['api', 'subscription', 'token_plan', 'free', 'local', 'unknown']) {
    const detail = usageDetail({ attribution: [], meteredMicros: null, meteredCurrency: null, billingMode });
    assert.ok(formatTurnUsage(detail).metered.startsWith('—'), billingMode);
    detail.meteredMicros = 0;
    detail.meteredCurrency = 'USD';
    assert.ok(formatTurnUsage(detail).metered.startsWith('$0.0000'), billingMode);
  }
});
