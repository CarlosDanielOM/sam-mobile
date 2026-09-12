import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PullByteQueue } from './byte-queue.ts';
import { formBody } from './form-body.ts';
import { copyJavaBytes } from './java-bytes.ts';
import { StreamResponse } from './stream-response.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('formBody stringifies URLSearchParams', () => {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: 'x' });
  const encoded = formBody(body);
  assert.ok(encoded?.includes('grant_type=authorization_code'));
  assert.ok(encoded?.includes('code=x'));
});

test('copyJavaBytes treats Java signed bytes as unsigned', () => {
  assert.deepEqual(copyJavaBytes([-1, 0, 127], 3), new Uint8Array([255, 0, 127]));
});

test('StreamResponse yields chunks before the body completes', async () => {
  const queue = new PullByteQueue();
  const response = new StreamResponse({
    status: 200,
    statusText: 'OK',
    url: 'https://example.test/sse',
    headers: { 'content-type': 'text/event-stream' },
    body: queue,
    abort() {},
  });
  if (!response.body) {
    throw new Error('No response body');
  }
  const reader = response.body.getReader();
  queue.push(enc.encode('data: one\n\n'));
  const first = await reader.read();
  assert.equal(dec.decode(first.value), 'data: one\n\n');
  await delay(10);
  queue.push(enc.encode('data: two\n\n'));
  queue.close();
  const second = await reader.read();
  assert.equal(dec.decode(second.value), 'data: two\n\n');
  assert.equal((await reader.read()).done, true);
});

test('StreamResponse.text reads the full stream', async () => {
  const queue = new PullByteQueue();
  queue.push(enc.encode('{"ok":'));
  queue.push(enc.encode('true}'));
  queue.close();
  const response = new StreamResponse({
    status: 200,
    statusText: 'OK',
    url: 'https://example.test/json',
    headers: { 'content-type': 'application/json' },
    body: queue,
    abort() {},
  });
  assert.equal(await response.text(), '{"ok":true}');
});
