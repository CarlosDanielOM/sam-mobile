import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionRuntimeRegistry } from './runtime-registry.ts';

test('registry keeps cancelled entries until finish across multiple restored scopes', () => {
  const registry = new SessionRuntimeRegistry();
  const events: string[] = [];
  assert.equal(registry.get('s'), undefined);
  const firstScope = registry.ensure('s');
  assert.equal(registry.ensure('s'), firstScope);
  const first = registry.register('s', { id: 'same', kind: 'read', cancel() { events.push('cancel:first'); } }, () => events.push('finish:first'));
  registry.cancel(['s'], (id) => events.push(`cancelled:${id}`));
  registry.cancel(['s'], () => assert.fail('cancelled twice'));
  assert.equal(firstScope.signal.aborted, true);
  assert.equal(registry.count(), 1);
  const second = registry.register('s', { id: 'same', kind: 'write', cancel() { events.push('cancel:second'); } }, () => events.push('finish:second'));
  assert.notEqual(second.signal, first.signal);
  registry.cancel(['s'], () => {});
  const third = registry.register('s', { id: 'same', kind: 'read', cancel() {} }, () => events.push('finish:third'));
  assert.equal(registry.count('s'), 3);
  second.finish();
  first.finish();
  first.finish();
  assert.equal(registry.count('s'), 1);
  assert.equal(third.signal.aborted, false);
  third.finish();
  assert.equal(registry.count(), 0);
  assert.deepEqual(events, ['cancel:first', 'cancelled:s', 'cancel:second', 'finish:second', 'finish:first', 'finish:third']);
});

test('all scopes abort before cancellation callbacks; throwing callbacks cannot block peers', () => {
  const registry = new SessionRuntimeRegistry();
  let cancelled = false;
  let sawAllAborted = false;
  registry.register('a', { id: 'a', kind: 'read', cancel() {
    sawAllAborted = registry.get('a')!.signal.aborted && registry.get('b')!.signal.aborted;
    throw new Error('consumer');
  } }, () => {});
  registry.register('b', { id: 'b', kind: 'write', cancel() { cancelled = true; } }, () => {});
  registry.ensure('idle');
  registry.ensure('unrelated');
  registry.cancel(['a', 'b', 'idle'], () => {});
  assert.equal(sawAllAborted, true);
  assert.equal(cancelled, true);
  assert.equal(registry.get('idle')?.signal.aborted, true);
  assert.equal(registry.get('unrelated')?.signal.aborted, false);
  assert.equal(registry.count(), 2);
});
