import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { tokenUsageFromAssistant } from './usage.ts';

function message(usage: unknown, responseId?: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    api: 'openai-responses',
    provider: 'openai',
    model: 'model',
    usage,
    stopReason: 'stop',
    responseId,
    timestamp: 1,
  } as AssistantMessage;
}

test('provider full usage preserves cache read, cache write, reasoning, and raw Pi metadata', () => {
  const result = tokenUsageFromAssistant(
    message(
      {
        input: 10,
        output: 8,
        cacheRead: 4,
        cacheWrite: 2,
        reasoning: 3,
        totalTokens: 24,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
      'req_1',
    ),
  );
  assert.equal(result?.reportedUncachedInputTokens, 10);
  assert.equal(result?.reportedCacheReadTokens, 4);
  assert.equal(result?.reportedCacheWriteTokens, 2);
  assert.equal(result?.reportedReasoningTokens, 3);
  assert.match(result?.providerUsageJson ?? '', /"cost"/);
});

test('provider partial usage leaves omitted dimensions null', () => {
  const result = tokenUsageFromAssistant(message({ output: 8, totalTokens: 8 }, 'req_2'));
  assert.equal(result?.reportedOutputTokens, 8);
  assert.equal(result?.reportedUncachedInputTokens, null);
  assert.equal(result?.reportedCacheWriteTokens, null);
});

test('missing usage and Pi placeholder zero usage remain unknown', () => {
  assert.equal(tokenUsageFromAssistant(message(undefined)), null);
  assert.equal(
    tokenUsageFromAssistant(
      message({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }),
    ),
    null,
  );
});

test('a response id does not turn placeholder zeros into measured usage', () => {
  assert.equal(
    tokenUsageFromAssistant(
      message({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, 'req_3'),
    ),
    null,
  );
});

test('zero dimensions within measured usage remain zero', () => {
  const result = tokenUsageFromAssistant(
    message({ input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10 }),
  );
  assert.equal(result?.reportedUncachedInputTokens, 10);
  assert.equal(result?.reportedOutputTokens, 0);
  assert.equal(result?.reportedCacheReadTokens, 0);
});
