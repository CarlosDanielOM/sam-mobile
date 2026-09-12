import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { MessageRecord } from '../persistence/types.ts';
import { messagesToContext } from './history.ts';

function record(partial: Partial<MessageRecord> & Pick<MessageRecord, 'id' | 'role' | 'content' | 'status'>): MessageRecord {
  return {
    conversationId: 'c1',
    provider: 'xai',
    model: 'grok',
    createdAt: 1,
    updatedAt: 1,
    error: null,
    payloadJson: null,
    ...partial,
  };
}

test('cancelled assistant text is replayed as a normal turn, not an error', () => {
  const history = messagesToContext([
    record({ id: 'u1', role: 'user', content: 'write me a book', status: 'completed' }),
    record({ id: 'a1', role: 'assistant', content: 'Chapter 1', status: 'cancelled' }),
    record({ id: 'u2', role: 'user', content: 'damn', status: 'completed' }),
  ]);
  const assistantMsg = history.find((message) => message.role === 'assistant') as AssistantMessage | undefined;
  assert.equal(assistantMsg?.content[0]?.type, 'text');
  assert.equal(assistantMsg?.content[0]?.type === 'text' ? assistantMsg.content[0].text : null, 'Chapter 1');
  assert.equal(assistantMsg?.stopReason, 'stop');
  assert.deepEqual(
    history.map((message) => message.role),
    ['user', 'assistant', 'user'],
  );
});

test('aborted payloadJson is not replayed as an error turn', () => {
  const payload: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Chapter 1' }],
    api: 'openai-completions',
    provider: 'xai',
    model: 'grok',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'aborted',
    timestamp: 1,
  };
  const history = messagesToContext([
    record({
      id: 'a1',
      role: 'assistant',
      content: 'Chapter 1',
      status: 'cancelled',
      payloadJson: JSON.stringify(payload),
    }),
  ]);
  const assistantMsg = history[0] as AssistantMessage;
  assert.equal(assistantMsg.stopReason, 'stop');
  assert.equal(assistantMsg.content[0]?.type === 'text' ? assistantMsg.content[0].text : null, 'Chapter 1');
});

test('interrupted assistant text is replayed', () => {
  const history = messagesToContext([
    record({ id: 'a1', role: 'assistant', content: 'partial', status: 'interrupted' }),
  ]);
  assert.equal((history[0] as AssistantMessage).stopReason, 'stop');
});
