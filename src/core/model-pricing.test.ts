import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  catalogHasPrice,
  formatCachePrice,
  formatDraft,
  formatModelPrice,
  formatUsd,
  microsToUsd,
  parseOptionalUsdPerMillion,
  parseUsdPerMillion,
  pricedRate,
  usdToMicros,
} from './model-pricing.ts';

test('parses dollar and cent input rates', () => {
  assert.equal(parseUsdPerMillion('0.30'), 0.3);
  assert.equal(parseUsdPerMillion('$1.20'), 1.2);
  assert.equal(parseUsdPerMillion('20c'), 0.2);
  assert.equal(parseUsdPerMillion('30¢'), 0.3);
  assert.equal(parseUsdPerMillion('1.20usd'), 1.2);
  assert.equal(parseUsdPerMillion(''), null);
  assert.equal(parseUsdPerMillion('nope'), null);
});

test('converts usd per million to integer micros', () => {
  assert.equal(usdToMicros(0.3), 300_000);
  assert.equal(usdToMicros(1.2), 1_200_000);
  assert.equal(microsToUsd(300_000), 0.3);
});

test('formats model prices for the provider menu', () => {
  assert.equal(formatUsd(0.3), '$0.30');
  assert.equal(formatUsd(1.2), '$1.20');
  assert.equal(formatModelPrice(0.3, 1.2), '$0.30 in · $1.20 out');
  assert.equal(formatModelPrice(null, null), 'No price yet');
  assert.equal(formatCachePrice(0.03, null), '$0.03 cache read');
  assert.equal(formatCachePrice(0.1, 1.25), '$0.10 cache read · $1.25 cache write');
  assert.equal(formatCachePrice(0, 0), null);
  assert.equal(formatDraft(0.3), '0.3');
  assert.equal(pricedRate(0), null);
  assert.equal(pricedRate(0.06), 0.06);
  assert.deepEqual(parseOptionalUsdPerMillion(''), { ok: true, value: null });
  assert.deepEqual(parseOptionalUsdPerMillion('0.03'), { ok: true, value: 0.03 });
});

test('catalog prices are present only when a rate is set', () => {
  assert.equal(catalogHasPrice({ input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 }), true);
  assert.equal(catalogHasPrice({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), false);
  assert.equal(catalogHasPrice(null), false);
});
