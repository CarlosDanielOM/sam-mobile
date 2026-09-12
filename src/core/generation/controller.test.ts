import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import { MemoryStore } from '../persistence/memory-store.ts';
import { GenerationController } from './controller.ts';
import { DEFAULT_CONVERSATION_ID } from './ids.ts';
import { NoopForegroundService } from './noop-foreground.ts';
import type { BackgroundGenerationPort, ForegroundState, StreamSimpleFn } from './types.ts';
import { TelemetryService } from '../telemetry/telemetry.service.ts';

const model = { id: 'grok', name: 'Grok', provider: 'xai' } as unknown as Model<Api>;

function assistant(text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
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
    stopReason,
    responseId: 'req_1',
    timestamp: 1,
  };
}

function delay(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function streamOf(deltas: string[], result: AssistantMessage, wait?: Promise<void>): StreamSimpleFn {
  return async function* () {
    for (const delta of deltas) {
      yield { type: 'text_delta', delta };
      if (wait) {
        await wait;
      } else {
        await delay(0);
      }
    }
  } as unknown as StreamSimpleFn;
}

function attachResult(fn: StreamSimpleFn, result: AssistantMessage | Promise<AssistantMessage>): StreamSimpleFn {
  return ((modelArg, context, options) => {
    const stream = fn(modelArg, context, options) as AsyncIterable<{ type: string; delta?: string }> & {
      result?: () => Promise<AssistantMessage>;
    };
    return Object.assign(stream, {
      result: () => Promise.resolve(result),
    });
  }) as StreamSimpleFn;
}

class RecordingForeground implements BackgroundGenerationPort {
  readonly calls: ForegroundState[] = [];
  start(state: ForegroundState): void {
    this.calls.push(state);
  }
  update(state: ForegroundState): void {
    this.calls.push(state);
  }
  stop(): void {
    this.calls.push({ kind: 'idle' });
  }
  setCancelHandler(): void {}
}

function controller(opts: {
  store?: MemoryStore;
  stream?: StreamSimpleFn;
  foreground?: BackgroundGenerationPort;
  visible?: boolean;
  now?: () => number;
  flushEveryMs?: number;
  telemetry?: TelemetryService;
}) {
  const result = assistant('Hello');
  const store = opts.store ?? new MemoryStore();
  store.ensureConversation(DEFAULT_CONVERSATION_ID, 'SAM');
  return new GenerationController({
    store,
    streamSimple: opts.stream ?? attachResult(streamOf(['Hel', 'lo'], result), result),
    foreground: opts.foreground ?? new NoopForegroundService(),
    isAppVisible: () => opts.visible ?? true,
    now: opts.now,
    flushEveryMs: opts.flushEveryMs ?? 10,
    flushEveryChars: 400,
    telemetry: opts.telemetry,
  });
}

test('Test A — foreground generation streams and persists the final response', async () => {
  const store = new MemoryStore();
  const mgr = controller({ store });
  await mgr.start({
    conversationId: DEFAULT_CONVERSATION_ID,
    text: 'Hi',
    providerId: 'xai',
    model,
  });
  await delay(30);
  const messages = store.listMessages(DEFAULT_CONVERSATION_ID);
  const assistantMsg = messages.find((message) => message.role === 'assistant');
  assert.equal(assistantMsg?.content, 'Hello');
  assert.equal(assistantMsg?.status, 'completed');
  const generation = store.listGenerationsByStatus(['completed'])[0];
  assert.equal(generation.usage?.outputTokens, 2);
  assert.equal(generation.usage?.requestId, 'req_1');
  assert.equal(mgr.snapshot().length, 0);
});

test('Test B — live snapshot keeps streaming text for UI reattach', async () => {
  let release: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = assistant('Hello');
  const mgr = controller({
    stream: attachResult(streamOf(['Hel', 'lo'], result, gate), result),
  });
  await mgr.start({
    conversationId: DEFAULT_CONVERSATION_ID,
    text: 'Hi',
    providerId: 'xai',
    model,
  });
  await delay(10);
  const live = mgr.snapshot()[0];
  assert.equal(live.status, 'streaming');
  assert.equal(live.text, 'Hel');
  release();
  await delay(20);
  assert.equal(mgr.snapshot().length, 0);
});

test('Test C — completion while backgrounded posts a completion notification', async () => {
  const foreground = new RecordingForeground();
  const mgr = controller({ foreground, visible: false });
  await mgr.start({
    conversationId: DEFAULT_CONVERSATION_ID,
    text: 'Hi',
    providerId: 'xai',
    model,
  });
  await delay(30);
  const kinds = foreground.calls.map((call) => call.kind);
  assert.ok(kinds.includes('thinking'));
  assert.equal(kinds.at(-1), 'completed');
});

test('Test D — cancel keeps partial text and status cancelled', async () => {
  const store = new MemoryStore();
  const telemetry = new TelemetryService(store);
  let release: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = assistant('Hello', 'aborted');
  result.usage.cost.total = 0.003;
  const mgr = controller({
    store,
    telemetry,
    stream: attachResult(streamOf(['Hel', 'lo'], result, gate), result),
  });
  const started = await mgr.start({
    conversationId: DEFAULT_CONVERSATION_ID,
    text: 'Hi',
    providerId: 'xai',
    model,
  });
  await delay(10);
  mgr.cancel(started.id);
  release();
  await delay(20);
  const assistantMsg = store.listMessages(DEFAULT_CONVERSATION_ID).find((message) => message.role === 'assistant');
  assert.equal(assistantMsg?.content, 'Hel');
  assert.equal(assistantMsg?.status, 'cancelled');
  assert.equal(store.getGeneration(started.id)?.status, 'cancelled');
  assert.equal(store.getGeneration(started.id)?.usage?.outputTokens, 2);
  const call = store.getModelCallByGenerationId(started.id)!;
  assert.equal(store.getModelCallUsage(call.id)?.reportedOutputTokens, 2);
  assert.equal(call.apiEquivalentCostMicros, 3_000);
});

test('cancel is bounded when the stream stalls and preserves the last usage snapshot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new MemoryStore();
  const telemetry = new TelemetryService(store);
  let release: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const partial = assistant('Hel', 'pending');
  partial.usage.cost.total = 0.003;
  const stream: StreamSimpleFn = () => Object.assign(
    (async function* () {
      yield { type: 'text_delta', delta: 'Hel', partial };
      await gate;
      yield { type: 'text_delta', delta: 'late' };
    })(),
    { result: () => gate.then(() => assistant('Hello')) },
  );
  const mgr = controller({ store, telemetry, stream });
  const started = await mgr.start({ conversationId: DEFAULT_CONVERSATION_ID, text: 'Hi', providerId: 'xai', model });
  await new Promise<void>((resolve) => setImmediate(resolve));
  mgr.cancel(started.id);
  t.mock.timers.tick(1_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(mgr.snapshot().length, 0);
  const call = store.getModelCallByGenerationId(started.id)!;
  assert.equal(call.status, 'cancelled');
  assert.equal(store.getModelCallUsage(call.id)?.reportedOutputTokens, 2);
  assert.equal(call.apiEquivalentCostMicros, 3_000);
  const completedAt = call.completedAt;
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(store.getMessage(started.messageId)?.content, 'Hel');
  assert.equal(store.getModelCallByGenerationId(started.id)?.completedAt, completedAt);
});

test('cancel bounds a pending final result and ignores its late rejection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new MemoryStore();
  const telemetry = new TelemetryService(store);
  let rejectResult: (error: Error) => void;
  const finalResult = new Promise<AssistantMessage>((_resolve, reject) => { rejectResult = reject; });
  const stream: StreamSimpleFn = () => Object.assign(
    (async function* () { yield { type: 'text_delta', delta: 'Hel' }; })(),
    { result: () => finalResult },
  );
  const mgr = controller({ store, telemetry, stream });
  const started = await mgr.start({ conversationId: DEFAULT_CONVERSATION_ID, text: 'Hi', providerId: 'xai', model });
  await new Promise<void>((resolve) => setImmediate(resolve));
  mgr.cancel(started.id);
  t.mock.timers.tick(1_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(mgr.snapshot().length, 0);
  const call = store.getModelCallByGenerationId(started.id)!;
  assert.equal(call.status, 'cancelled');
  assert.equal(store.getModelCallUsage(call.id), null);
  assert.equal(call.apiEquivalentCostMicros, null);
  const generation = store.getGeneration(started.id);
  const message = store.getMessage(started.messageId);
  rejectResult(new Error('Late provider failure'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(store.getGeneration(started.id), generation);
  assert.deepEqual(store.getMessage(started.messageId), message);
  assert.deepEqual(store.getModelCallByGenerationId(started.id), call);
});

test('a rejected stream preserves already-reported partial usage', async () => {
  const store = new MemoryStore();
  const telemetry = new TelemetryService(store);
  const partial = assistant('Hel', 'pending');
  partial.usage.cost.total = 0.003;
  const stream: StreamSimpleFn = () => Object.assign(
    (async function* () {
      yield { type: 'text_delta', delta: 'Hel', partial };
      throw new Error('Connection lost');
    })(),
    { result: () => Promise.reject(new Error('No final result')) },
  );
  const mgr = controller({ store, telemetry, stream });
  const started = await mgr.start({ conversationId: DEFAULT_CONVERSATION_ID, text: 'Hi', providerId: 'xai', model });
  await delay(20);
  const call = store.getModelCallByGenerationId(started.id)!;
  assert.equal(call.status, 'failed');
  assert.equal(store.getModelCallUsage(call.id)?.reportedOutputTokens, 2);
  assert.equal(call.apiEquivalentCostMicros, 3_000);
});

test('placeholder usage never creates a known zero fallback cost', async () => {
  for (const responseId of [undefined, 'req_placeholder']) {
    const store = new MemoryStore();
    const telemetry = new TelemetryService(store);
    const result = assistant('', 'error');
    result.responseId = responseId;
    result.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const mgr = controller({ store, telemetry, stream: attachResult(streamOf([], result), result) });
    const started = await mgr.start({ conversationId: DEFAULT_CONVERSATION_ID, text: 'Hi', providerId: 'xai', model });
    await delay(20);
    const call = store.getModelCallByGenerationId(started.id)!;
    assert.equal(store.getModelCallUsage(call.id), null);
    assert.equal(call.apiEquivalentCostMicros, null);
    assert.equal(store.getGeneration(started.id)?.usage?.outputTokens, undefined);
    assert.equal(store.getGeneration(started.id)?.usage?.piCost, undefined);
  }
});

test('measured usage can still have a legitimate zero registry cost', async () => {
  const store = new MemoryStore();
  const telemetry = new TelemetryService(store);
  const mgr = controller({ store, telemetry });
  const started = await mgr.start({ conversationId: DEFAULT_CONVERSATION_ID, text: 'Hi', providerId: 'xai', model });
  await delay(30);
  const call = store.getModelCallByGenerationId(started.id)!;
  assert.equal(call.apiEquivalentCostMicros, 0);
  assert.equal(store.getModelCallUsage(call.id)?.reportedOutputTokens, 2);
});

test('manual retry details select the new response and retain both calls in attribution', async () => {
  const store = new MemoryStore();
  const telemetry = new TelemetryService(store);
  let count = 0;
  const stream: StreamSimpleFn = (modelArg, context, options) => {
    const result = assistant('Hello', ++count === 1 ? 'error' : 'stop');
    result.model = modelArg.id;
    result.usage.output = count === 1 ? 2 : 20;
    result.usage.cost.total = 0.003;
    return attachResult(streamOf(['Hello'], result), result)(modelArg, context, options);
  };
  const mgr = controller({ store, telemetry, stream });
  const original = await mgr.start({ conversationId: DEFAULT_CONVERSATION_ID, text: 'Hi', providerId: 'xai', model });
  await delay(20);
  await mgr.retry({ conversationId: DEFAULT_CONVERSATION_ID, messageId: original.messageId, providerId: 'xai',
    model: { ...model, id: 'retry-model' } });
  await delay(20);
  const detail = mgr.turnUsage(DEFAULT_CONVERSATION_ID)!;
  assert.equal(detail.modelId, 'retry-model');
  assert.equal(detail.outputTokens, 20);
  assert.equal(detail.attribution.length, 2);
  assert.equal(mgr.usageSummary(DEFAULT_CONVERSATION_ID)?.costMicros, 6_000);
});

test('next send includes cancelled assistant text in model context', async () => {
  const store = new MemoryStore();
  const contexts: { messages: { role: string; stopReason?: string; content?: unknown }[] }[] = [];
  let release: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = assistant('Hel', 'aborted');
  const second = assistant('ok');
  const stream: StreamSimpleFn = ((modelArg, context, options) => {
    contexts.push(context);
    if (contexts.length === 1) {
      return attachResult(streamOf(['Hel'], first, gate), first)(modelArg, context, options);
    }
    return attachResult(streamOf(['ok'], second), second)(modelArg, context, options);
  }) as StreamSimpleFn;
  const mgr = controller({ store, stream });
  const started = await mgr.start({
    conversationId: DEFAULT_CONVERSATION_ID,
    text: 'write me a book',
    providerId: 'xai',
    model,
  });
  await delay(10);
  mgr.cancel(started.id);
  release();
  await delay(20);
  await mgr.start({
    conversationId: DEFAULT_CONVERSATION_ID,
    text: 'damn',
    providerId: 'xai',
    model,
  });
  await delay(20);
  const followUp = contexts[1]?.messages ?? [];
  const assistantTurn = followUp.find((message) => message.role === 'assistant') as AssistantMessage | undefined;
  assert.equal(assistantTurn?.stopReason, 'stop');
  assert.equal(assistantTurn?.content[0]?.type === 'text' ? assistantTurn.content[0].text : null, 'Hel');
  assert.deepEqual(
    followUp.map((message) => message.role),
    ['user', 'assistant', 'user'],
  );
});

test('Test E — connection failure keeps partial text', async () => {
  const store = new MemoryStore();
  const stream: StreamSimpleFn = ((modelArg, context, options) => {
    const inner = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text_delta', delta: 'Hel' };
        await delay(0);
        throw new Error('Network request failed: socket closed');
      },
      result: async () => assistant('Hel', 'error'),
    };
    return inner;
  }) as StreamSimpleFn;
  const mgr = controller({ store, stream });
  await mgr.start({
    conversationId: DEFAULT_CONVERSATION_ID,
    text: 'Hi',
    providerId: 'xai',
    model,
  });
  await delay(20);
  const assistantMsg = store.listMessages(DEFAULT_CONVERSATION_ID).find((message) => message.role === 'assistant');
  assert.equal(assistantMsg?.content, 'Hel');
  assert.equal(assistantMsg?.status, 'failed');
  assert.match(assistantMsg?.error ?? '', /socket closed|Request failed/);
});

test('Test F — process recovery marks orphans interrupted without resending', async () => {
  const store = new MemoryStore();
  store.ensureConversation(DEFAULT_CONVERSATION_ID, 'SAM');
  store.insertMessage({
    id: 'u1',
    conversationId: DEFAULT_CONVERSATION_ID,
    role: 'user',
    content: 'Hi',
    status: 'completed',
    provider: null,
    model: null,
    createdAt: 1,
    updatedAt: 1,
    error: null,
    payloadJson: null,
  });
  store.insertMessage({
    id: 'a1',
    conversationId: DEFAULT_CONVERSATION_ID,
    role: 'assistant',
    content: 'Hel',
    status: 'streaming',
    provider: 'xai',
    model: 'grok',
    createdAt: 2,
    updatedAt: 2,
    error: null,
    payloadJson: null,
  });
  store.insertGeneration({
    id: 'g1',
    conversationId: DEFAULT_CONVERSATION_ID,
    messageId: 'a1',
    status: 'streaming',
    provider: 'xai',
    model: 'grok',
    startedAt: 2,
    completedAt: null,
    error: null,
    usage: null,
  });
  let streamed = 0;
  const mgr = controller({
    store,
    stream: ((...args) => {
      streamed += 1;
      return attachResult(streamOf(['lo'], assistant('Hello')), assistant('Hello'))(...args);
    }) as StreamSimpleFn,
  });
  mgr.recoverOrphans();
  await delay(10);
  assert.equal(streamed, 0);
  assert.equal(store.getMessage('a1')?.content, 'Hel');
  assert.equal(store.getMessage('a1')?.status, 'interrupted');
  assert.equal(store.getGeneration('g1')?.status, 'interrupted');
});

test('does not notify completion when the app is visible', async () => {
  const foreground = new RecordingForeground();
  const mgr = controller({ foreground, visible: true });
  await mgr.start({
    conversationId: DEFAULT_CONVERSATION_ID,
    text: 'Hi',
    providerId: 'xai',
    model,
  });
  await delay(30);
  assert.equal(foreground.calls.at(-1)?.kind, 'idle');
  assert.ok(!foreground.calls.some((call) => call.kind === 'completed'));
});

test('coalesces persistence instead of writing every token', async () => {
  const store = new MemoryStore();
  let now = 1_000;
  const result = assistant('abcdefghij');
  const mgr = controller({
    store,
    now: () => now,
    flushEveryMs: 500,
    stream: attachResult(streamOf(['abcd', 'efgh', 'ij'], result), result),
  });
  const original = store.updateMessage.bind(store);
  let writes = 0;
  store.updateMessage = (id, patch) => {
    writes += 1;
    original(id, patch);
  };
  await mgr.start({
    conversationId: DEFAULT_CONVERSATION_ID,
    text: 'Hi',
    providerId: 'xai',
    model,
  });
  await delay(20);
  assert.ok(writes < 5);
  const assistantMsg = store.listMessages(DEFAULT_CONVERSATION_ID).find((message) => message.role === 'assistant');
  assert.equal(assistantMsg?.content, 'abcdefghij');
});

test('active Pi stream lifecycle persists one logical call and one physical attempt', async () => {
  const store = new MemoryStore();
  const telemetry = new TelemetryService(store);
  telemetry.savePricingSnapshot({
    id: 'xai-grok-price',
    provider: 'xai',
    providerAccountId: null,
    model: 'grok',
    inputPerMillionMicros: 1_000_000,
    cacheReadPerMillionMicros: 500_000,
    cacheWritePerMillionMicros: 2_000_000,
    outputPerMillionMicros: 4_000_000,
    reasoningPerMillionMicros: null,
    modalityRatesJson: null,
    currency: 'USD',
    effectiveFrom: 0,
    effectiveTo: null,
    source: 'test',
    notes: null,
    createdAt: 0,
  });
  const mgr = controller({ store, telemetry });
  await mgr.start({
    conversationId: DEFAULT_CONVERSATION_ID,
    text: 'Hi',
    providerId: 'xai',
    providerAccountId: 'xai-default',
    providerAccountLabel: 'xAI',
    billingMode: 'subscription',
    model,
  });
  await delay(30);
  const assistantMessage = store
    .listMessages(DEFAULT_CONVERSATION_ID)
    .find((message) => message.role === 'assistant');
  const call = store.getModelCallByMessageId(assistantMessage!.id)!;
  const attempts = store.listModelCallAttempts(call.id);
  assert.equal(call.status, 'completed');
  assert.equal(call.apiEquivalentCostMicros, 12);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].providerRequestId, 'req_1');
  assert.equal(store.getModelCallUsage(call.id)?.reportedCacheReadTokens, 1);
  assert.equal(store.getModelCallUsage(call.id)?.reportedCacheWriteTokens, 0);
});

test('uses the provided system prompt for the request', async () => {
  let prompt: string | undefined;
  const result = assistant('Hello');
  const stream: StreamSimpleFn = ((modelArg, context, options) => {
    prompt = context.systemPrompt;
    return attachResult(streamOf(['Hello'], result), result)(modelArg, context, options);
  }) as StreamSimpleFn;
  const mgr = controller({ stream });
  await mgr.start({
    conversationId: DEFAULT_CONVERSATION_ID,
    text: 'Hi',
    providerId: 'xai',
    model,
    systemPrompt: 'Be a pirate.',
  });
  await delay(30);
  assert.equal(prompt, 'Be a pirate.');
});

test('falls back to the default system prompt when none is provided', async () => {
  let prompt: string | undefined;
  const result = assistant('Hello');
  const stream: StreamSimpleFn = ((modelArg, context, options) => {
    prompt = context.systemPrompt;
    return attachResult(streamOf(['Hello'], result), result)(modelArg, context, options);
  }) as StreamSimpleFn;
  const mgr = controller({ stream });
  await mgr.start({
    conversationId: DEFAULT_CONVERSATION_ID,
    text: 'Hi',
    providerId: 'xai',
    model,
  });
  await delay(30);
  assert.equal(prompt, "You are SAM, a concise personal assistant on the user's phone.");
});

test('retry rejects live and completed messages without creating duplicate work', async () => {
  const store = new MemoryStore();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const result = assistant('Hello');
  const mgr = controller({ store, stream: attachResult(streamOf(['Hello'], result, gate), result) });
  const generation = await mgr.start({ conversationId: DEFAULT_CONVERSATION_ID, text: 'Hi', providerId: 'xai', model });
  const retry = () => mgr.retry({ conversationId: DEFAULT_CONVERSATION_ID, messageId: generation.messageId, providerId: 'xai', model });
  assert.equal(await retry(), null);
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(store.getGeneration(generation.id)?.status, 'completed');
  assert.equal(await retry(), null);
  assert.equal(store.listMessages(DEFAULT_CONVERSATION_ID).length, 2);
  assert.equal(mgr.sessions.runtimes.count(), 0);
});

test('setup failures finalize durable work instead of leaving an unowned streaming message', async () => {
  const store = new MemoryStore();
  const foreground = new RecordingForeground();
  const telemetry = new TelemetryService(store);
  let requests = 0;
  const mgr = controller({ store, foreground, telemetry,
    stream: () => { requests++; throw new Error('Must not dispatch'); } });
  const generation = await mgr.start({ conversationId: DEFAULT_CONVERSATION_ID, text: 'Hi', providerId: 'xai', model,
    telemetryContext: { turnId: 'missing', agentId: 'missing', agentRunId: 'missing' } });
  assert.equal(requests, 0);
  assert.equal(store.getGeneration(generation.id)?.status, 'failed');
  assert.equal(store.getMessage(generation.messageId)?.status, 'failed');
  assert.match(store.getMessage(generation.messageId)?.error ?? '', /Unknown agent run/);
  assert.equal(mgr.sessions.runtimes.count(), 0);
  assert.equal(mgr.sessions.get(DEFAULT_CONVERSATION_ID)?.state, 'active');
  assert.equal(foreground.calls.at(-1)?.kind, 'idle');
});
