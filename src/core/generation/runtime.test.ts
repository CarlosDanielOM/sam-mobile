import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import { MemoryStore } from '../persistence/memory-store.ts';
import { NoopForegroundService } from './noop-foreground.ts';
import { obtainGenerationRuntime, resetGenerationRuntimeForTests } from './runtime.ts';
import type { StreamSimpleFn } from './types.ts';
import { DEFAULT_CONVERSATION_ID } from './ids.ts';

const model = { id: 'grok', name: 'Grok', provider: 'xai' } as unknown as Model;

function assistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'xai',
    model: 'grok',
    usage: {
      input: 3,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    responseId: 'req_1',
    timestamp: 1,
  };
}

function delay(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('warm UI relaunch reuses the live generation instead of marking it interrupted', async () => {
  resetGenerationRuntimeForTests();
  const store = new MemoryStore();
  store.ensureConversation(DEFAULT_CONVERSATION_ID, 'SAM');
  let release: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = assistant('Hello');
  const stream: StreamSimpleFn = ((modelArg, context, options) => {
    const inner = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text_delta', delta: 'Hel' };
        await gate;
        yield { type: 'text_delta', delta: 'lo' };
      },
      result: async () => result,
    };
    return inner;
  }) as StreamSimpleFn;
  const first = obtainGenerationRuntime({
    store,
    streamSimple: stream,
    foreground: new NoopForegroundService(),
  });
  await first.start({
    conversationId: DEFAULT_CONVERSATION_ID,
    text: 'Hi',
    providerId: 'xai',
    model,
  });
  await delay(10);
  const second = obtainGenerationRuntime({
    store,
    streamSimple: stream,
    foreground: new NoopForegroundService(),
  });
  assert.equal(second, first);
  const live = second.snapshot()[0];
  assert.equal(live.status, 'streaming');
  assert.equal(live.text, 'Hel');
  assert.equal(store.listGenerationsByStatus(['streaming']).length, 1);
  release();
  await delay(20);
  assert.equal(store.listGenerationsByStatus(['completed']).length, 1);
  resetGenerationRuntimeForTests();
});
