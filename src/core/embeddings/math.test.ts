import assert from 'node:assert/strict';
import test from 'node:test';
import { cosine, norm, statistics } from './math';

test('norm and cosine validate dimensions, finite values and nonzero cosine inputs', () => {
  assert.equal(norm([3, 4]), 5);
  assert.equal(norm([0, 0]), 0);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1, 0], [-1, 0]), -1);
  assert.ok(Math.abs(cosine([3, 4], [6, 8]) - 1) < 1e-15);
  for (const vector of [[], [NaN], [Infinity], [-Infinity], Array(2)]) assert.throws(() => norm(vector), RangeError);
  for (const [a, b] of [[[1], [1, 2]], [[], []], [[0], [1]], [[1], [0]], [[NaN], [1]], [[1], [Infinity]]]) {
    assert.throws(() => cosine(a, b), RangeError);
  }
});

test('scaled numerical utilities do not overflow intermediate arithmetic', () => {
  assert.ok(Math.abs(norm([3e200, 4e200]) / 5e200 - 1) < 1e-15);
  assert.ok(Math.abs(norm([3e-200, 4e-200]) / 5e-200 - 1) < 1e-15);
  assert.ok(Math.abs(cosine([Number.MAX_VALUE, Number.MAX_VALUE], [1, 1]) - 1) < 1e-15);
  assert.equal(cosine([Number.MIN_VALUE], [Number.MIN_VALUE]), 1);
  assert.throws(() => cosine(Array(2), [1, 2]), RangeError);
});

test('statistics reports total, mean, even/odd median and nearest-rank P95 without mutation', () => {
  const values = [4, 1, 3, 2];
  assert.deepEqual(statistics(values), { count: 4, total: 10, mean: 2.5, median: 2.5, p95: 4 });
  assert.deepEqual(values, [4, 1, 3, 2]);
  assert.equal(statistics([9, 1, 5]).median, 5);
  assert.equal(statistics(Array.from({ length: 100 }, (_, i) => i + 1)).p95, 95);
  assert.deepEqual(statistics([]), { count: 0, total: 0, mean: null, median: null, p95: null });
  assert.deepEqual(statistics([0]), { count: 1, total: 0, mean: 0, median: 0, p95: 0 });
  for (const values of [[-1], [NaN], [Infinity], Array(2), [Number.MAX_VALUE, Number.MAX_VALUE]]) {
    assert.throws(() => statistics(values), RangeError);
  }
});
