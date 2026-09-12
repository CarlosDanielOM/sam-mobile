import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWarmWindowContentResolver } from './window-content-resolver.ts';

test('first window falls through to the NativeScript launch bridge', () => {
  const resolver = createWarmWindowContentResolver(() => ({ id: 'warm' }));
  assert.equal(resolver({}), undefined);
});

test('later windows in a living process re-bootstrap instead of returning empty content', () => {
  const resolver = createWarmWindowContentResolver((request: { id: string }) => ({ from: request.id }));
  resolver({ id: 'first' });
  assert.deepEqual(resolver({ id: 'warm' }), { from: 'warm' });
});

test('a missing warm root becomes null so setContentView is not skipped silently as undefined', () => {
  const resolver = createWarmWindowContentResolver(() => undefined);
  resolver({});
  assert.equal(resolver({}), null);
});
