import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PullByteQueue } from './byte-queue.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

test('read waits until a chunk is pushed', async () => {
  const queue = new PullByteQueue();
  const pending = queue.getReader().read();
  queue.push(enc.encode('ab'));
  const result = await pending;
  assert.equal(result.done, false);
  assert.equal(dec.decode(result.value), 'ab');
});

test('buffered chunks then close', async () => {
  const queue = new PullByteQueue();
  queue.push(enc.encode('a'));
  queue.push(enc.encode('b'));
  queue.close();
  const reader = queue.getReader();
  assert.equal(dec.decode((await reader.read()).value), 'a');
  assert.equal(dec.decode((await reader.read()).value), 'b');
  assert.equal((await reader.read()).done, true);
});

test('fail rejects in-flight reads', async () => {
  const queue = new PullByteQueue();
  const pending = queue.getReader().read();
  queue.fail(new Error('boom'));
  await assert.rejects(pending, /boom/);
});
