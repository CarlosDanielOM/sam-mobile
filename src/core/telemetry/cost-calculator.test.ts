import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateApiEquivalentCost } from './cost-calculator.ts';
import type { PricingSnapshotRecord, TokenUsage } from './types.ts';
import { emptyTokenUsage } from './usage.ts';

function pricing(overrides: Partial<PricingSnapshotRecord> = {}): PricingSnapshotRecord {
  return {
    id: 'price_1',
    provider: 'test',
    providerAccountId: null,
    model: 'model',
    inputPerMillionMicros: 1_000_000,
    cacheReadPerMillionMicros: 500_000,
    cacheWritePerMillionMicros: 2_000_000,
    outputPerMillionMicros: 4_000_000,
    reasoningPerMillionMicros: null,
    modalityRatesJson: null,
    currency: 'USD',
    effectiveFrom: 0,
    effectiveTo: null,
    source: 'manual',
    notes: null,
    createdAt: 0,
    ...overrides,
  };
}

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    ...emptyTokenUsage('provider_reported'),
    reportedUncachedInputTokens: 1_000,
    reportedCacheReadTokens: 200,
    reportedCacheWriteTokens: 100,
    reportedOutputTokens: 500,
    reportedReasoningTokens: 0,
    reportedTotalTokens: 1_800,
    ...overrides,
  };
}

test('manual pricing calculates uncached, cache read/write, and output independently', () => {
  const cost = calculateApiEquivalentCost(usage(), pricing());
  assert.deepEqual(cost, {
    amountMicros: 3_300,
    currency: 'USD',
    pricingSnapshotId: 'price_1',
    source: 'provider_reported',
  });
});

test('reasoning pricing replaces the reasoning subset of output pricing', () => {
  const cost = calculateApiEquivalentCost(
    usage({ reportedOutputTokens: 500, reportedReasoningTokens: 100 }),
    pricing({ reasoningPerMillionMicros: 10_000_000 }),
  );
  assert.equal(cost?.amountMicros, 3_900);
});

test('missing billable usage or pricing remains unknown', () => {
  assert.equal(
    calculateApiEquivalentCost(
      usage({ reportedCacheWriteTokens: null }),
      pricing(),
    ),
    null,
  );
  assert.equal(
    calculateApiEquivalentCost(usage(), pricing({ cacheWritePerMillionMicros: null })),
    null,
  );
});

test('estimates fill gaps per dimension and mark the cost as mixed provenance', () => {
  // Provider reported output only; input comes from a local estimate.
  const cost = calculateApiEquivalentCost(
    usage({
      reportedUncachedInputTokens: null,
      reportedCacheReadTokens: null,
      reportedCacheWriteTokens: null,
      reportedOutputTokens: 500,
      reportedReasoningTokens: null,
      reportedTotalTokens: null,
      estimatedInputTokens: 1_000,
      estimatedCacheReadTokens: 200,
      estimatedCacheWriteTokens: 100,
      source: 'mixed',
    }),
    pricing(),
  );
  // 1000 in + 200 cache-read + 100 cache-write + 500 out = 3300 micros.
  assert.equal(cost?.amountMicros, 3_300);
  assert.equal(cost?.source, 'mixed');
});

test('purely estimated usage prices with locally_estimated provenance', () => {
  const cost = calculateApiEquivalentCost(
    usage({
      reportedUncachedInputTokens: null,
      reportedCacheReadTokens: null,
      reportedCacheWriteTokens: null,
      reportedOutputTokens: null,
      reportedReasoningTokens: null,
      reportedTotalTokens: null,
      estimatedUncachedInputTokens: 1_000,
      estimatedCacheReadTokens: 200,
      estimatedCacheWriteTokens: 100,
      estimatedOutputTokens: 500,
      estimatedReasoningTokens: 0,
      source: 'locally_estimated',
    }),
    pricing(),
  );
  assert.equal(cost?.amountMicros, 3_300);
  assert.equal(cost?.source, 'locally_estimated');
});

test('unknown reasoning tokens stay unknown and do not become zero', () => {
  // Reasoning has its own rate but the provider did not report a reasoning
  // split: the cost cannot be computed instead of assuming zero reasoning.
  assert.equal(
    calculateApiEquivalentCost(
      usage({ reportedReasoningTokens: null }),
      pricing({ reasoningPerMillionMicros: 10_000_000 }),
    ),
    null,
  );
  // Zero reported reasoning is known and prices the full output at output rate.
  const known = calculateApiEquivalentCost(
    usage({ reportedReasoningTokens: 0 }),
    pricing({ reasoningPerMillionMicros: 10_000_000 }),
  );
  assert.equal(known?.amountMicros, 3_300);
});

test('integer micro-unit math has no binary floating point accumulation', () => {
  const oneToken = usage({
    reportedUncachedInputTokens: 1,
    reportedCacheReadTokens: 0,
    reportedCacheWriteTokens: 0,
    reportedOutputTokens: 0,
    reportedReasoningTokens: 0,
    reportedTotalTokens: 1,
  });
  const costs = Array.from({ length: 10_000 }, () =>
    calculateApiEquivalentCost(oneToken, pricing())!.amountMicros,
  );
  assert.equal(costs.reduce((sum, amount) => sum + amount, 0), 10_000);
});
