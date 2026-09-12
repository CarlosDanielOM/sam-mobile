import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import { MemoryStore } from '../persistence/memory-store.ts';
import { SessionEngine } from '../sessions/session-engine.ts';
import type { SessionEvent } from '../sessions/types.ts';
import { TelemetryService } from '../telemetry/telemetry.service.ts';
import { GenerationController } from './controller.ts';
import { DEFAULT_CONVERSATION_ID } from './ids.ts';
import type {
  BackgroundGenerationPort, ForegroundState, ForegroundThinking, GenerationState, StreamSimpleFn,
} from './types.ts';

const model: Model<'openai-completions'> = {
  id: 'session-model', name: 'Session Model', api: 'openai-completions', provider: 'xai',
  baseUrl: 'https://example.invalid', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192, maxTokens: 1024,
};

function assistant(text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant', content: [{ type: 'text', text }], api: model.api,
    provider: model.provider, model: model.id, stopReason, timestamp: 1000,
    usage: {
      input: 3, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 6,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
type StreamEvent = { type: string; delta?: string; partial?: AssistantMessage };

class ControlledStream {
  private readonly events: StreamEvent[] = [];
  private wake = deferred<void>();
  private ended = false;
  readonly final = deferred<AssistantMessage>();

  push(delta: string): void {
    this.events.push({ type: 'text_delta', delta, partial: assistant(delta, 'pending') });
    this.wake.resolve();
  }

  end(): void {
    this.ended = true;
    this.wake.resolve();
  }

  complete(text: string): void {
    this.final.resolve(assistant(text));
    this.end();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    while (this.events.length || !this.ended) {
      const event = this.events.shift();
      if (event) {
        yield event;
      } else {
        await this.wake.promise;
        this.wake = deferred<void>();
      }
    }
  }

  result(): Promise<AssistantMessage> { return this.final.promise; }
}

class RecordingForeground implements BackgroundGenerationPort {
  readonly calls: { method: 'start' | 'update' | 'stop'; state: ForegroundState }[] = [];
  start(state: ForegroundThinking): void { this.calls.push({ method: 'start', state }); }
  update(state: ForegroundState): void { this.calls.push({ method: 'update', state }); }
  stop(): void { this.calls.push({ method: 'stop', state: { kind: 'idle' } }); }
  setCancelHandler(_handler: (generationId: string) => void): void {}
}

function setup(t: TestContext, store = new MemoryStore()) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let at = 1000;
  let id = 0;
  const now = () => at++;
  const visibility = { value: true };
  const foreground = new RecordingForeground();
  const telemetry = new TelemetryService(store, now);
  const sessions = new SessionEngine(store, { clock: now, id: () => `session-${++id}` });
  const requests: {
    model: Model<Api>; context: Parameters<StreamSimpleFn>[1];
    signal: AbortSignal; stream: ControlledStream;
  }[] = [];
  const controller = new GenerationController({
    store, sessions, telemetry, foreground, now, isAppVisible: () => visibility.value,
    flushEveryMs: 500, flushEveryChars: 400,
    streamSimple: (requestModel, context, options) => {
      const stream = new ControlledStream();
      requests.push({ model: requestModel, context, signal: options.signal, stream });
      return stream;
    },
  });
  const events: SessionEvent[] = [];
  const unsubscribe = controller.sessions.subscribe((event) => events.push(event));
  t.after(async () => {
    for (const request of requests) request.stream.complete('cleanup');
    await settle();
    unsubscribe();
  });
  async function send(sessionId: string, text: string) {
    const generation = await controller.start({
      conversationId: sessionId, text, model, providerId: model.provider,
      systemPrompt: `System for ${sessionId}`,
    });
    const request = requests.at(-1)!;
    request.stream.push(`partial:${text}`);
    await settle();
    return { generation, ...request };
  }
  return { store, controller, sessions: controller.sessions, telemetry, foreground, visibility, requests, events, send };
}

function records(store: MemoryStore, generation: GenerationState) {
  const call = store.getModelCallByGenerationId(generation.id);
  assert.ok(call);
  assert.ok(call.turnId);
  const turn = store.getTurn(call.turnId);
  const run = store.getAgentRun(call.agentRunId);
  assert.ok(turn);
  assert.ok(run);
  assert.equal(store.getGeneration(generation.id)?.conversationId, generation.conversationId);
  assert.equal(store.getMessage(generation.messageId)?.conversationId, generation.conversationId);
  assert.equal(call.sessionId, generation.conversationId);
  assert.equal(call.messageId, generation.messageId);
  assert.equal(turn.sessionId, generation.conversationId);
  assert.equal(store.getMessage(turn.userMessageId!)?.conversationId, generation.conversationId);
  assert.equal(run.sessionId, generation.conversationId);
  assert.equal(run.turnId, turn.id);
  assert.equal(run.agentId, call.agentId);
  const attempts = store.listModelCallAttempts(call.id);
  assert.equal(attempts.length, 1);
  return {
    generation: store.getGeneration(generation.id), message: store.getMessage(generation.messageId),
    call, turn, run, attempts, usage: store.getModelCallUsage(call.id),
    attemptUsage: store.getModelCallAttemptUsage(attempts[0].id),
  };
}

function assertTerminal(store: MemoryStore, generation: GenerationState, status: string, text: string) {
  const saved = records(store, generation);
  for (const record of [saved.generation, saved.message, saved.call, saved.turn, saved.run, ...saved.attempts]) {
    assert.equal(record?.status, status);
  }
  assert.equal(saved.message?.content, text);
  return saved;
}

function assertThinking(foreground: RecordingForeground, count: number, only?: GenerationState) {
  assert.deepEqual(foreground.calls.at(-1), {
    method: 'start', state: {
      kind: 'thinking', activeCount: count, generationId: only?.id,
      conversationId: only?.conversationId, modelName: only?.modelName,
    },
  });
  assert.ok(foreground.calls.every((call) => call.method === 'start'));
}

test('construction and empty recovery never create a default session; start requires an existing session', async (t) => {
  const h = setup(t);
  assert.ok(h.controller.sessions instanceof SessionEngine);
  assert.deepEqual(h.sessions.list(), []);
  h.controller.recoverOrphans();
  h.controller.recoverOrphans();
  await assert.rejects(h.send('missing', 'do not send'), /Session not found/);
  assert.deepEqual(h.sessions.list(), []);
  assert.equal(h.store.getSession(DEFAULT_CONVERSATION_ID), null);
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.controller.snapshot(), []);
  assert.equal(h.sessions.runtimes.count(), 0);
  assert.deepEqual(h.store.listModelCallsByStatus(['queued', 'running', 'streaming']), []);
  assert.deepEqual(h.store.listMessages('missing'), []);
});

test('A, B and C stream concurrently without context mixing; selected C finishes before A and B', async (t) => {
  const h = setup(t);
  const work = [];
  for (const title of ['A', 'B', 'C']) {
    const session = h.sessions.create({ title });
    work.push(await h.send(session.id, `question:${title}`));
    assert.equal(h.sessions.runtimes.count(), work.length);
    assert.equal(h.controller.snapshot().length, work.length);
    assertThinking(h.foreground, work.length, work.length === 1 ? work[0].generation : undefined);
    for (const item of work) {
      assert.equal(item.signal.aborted, false);
      assert.equal(h.sessions.runtimes.get(item.generation.conversationId)?.signal.aborted, false);
      assert.equal(h.controller.activeFor(item.generation.conversationId)[0]?.status, 'streaming');
      assert.equal(h.sessions.runtimes.count(item.generation.conversationId), 1);
      records(h.store, item.generation);
    }
  }
  assert.equal(new Set(work.map((item) => item.generation.id)).size, 3);
  assert.equal(new Set(work.map((item) => records(h.store, item.generation).turn.id)).size, 3);
  assert.equal(new Set(work.map((item) => records(h.store, item.generation).run.id)).size, 3);
  for (const [index, item] of work.entries()) {
    const text = `question:${['A', 'B', 'C'][index]}`;
    assert.equal(item.context.systemPrompt, `System for ${item.generation.conversationId}`);
    assert.deepEqual(item.context.messages.map((message) => [message.role, message.content]), [['user', text]]);
    assert.deepEqual(h.store.listMessages(item.generation.conversationId).map((message) => [message.role, message.content]), [
      ['user', text], ['assistant', `partial:${text}`],
    ]);
    assert.equal(item.model.id, model.id);
  }

  const sessionsBefore = h.sessions.list();
  const scopes = sessionsBefore.map((session) => h.sessions.runtimes.get(session.id));
  const foregroundBefore = [...h.foreground.calls];
  h.visibility.value = false;
  await settle();
  assert.deepEqual(h.sessions.list(), sessionsBefore);
  assert.deepEqual(h.foreground.calls, foregroundBefore);
  assert.equal(h.sessions.runtimes.count(), 3);

  const [a, b, c] = work;
  c.stream.complete('answer:C');
  await settle();
  assertTerminal(h.store, c.generation, 'completed', 'answer:C');
  assertThinking(h.foreground, 2);
  assert.equal(h.sessions.runtimes.count(), 2);
  assert.deepEqual(h.controller.snapshot().map((generation) => generation.id), [a.generation.id, b.generation.id]);
  a.stream.complete('answer:A');
  await settle();
  assertTerminal(h.store, a.generation, 'completed', 'answer:A');
  assertThinking(h.foreground, 1, b.generation);
  assert.equal(h.sessions.runtimes.count(), 1);
  b.stream.complete('answer:B');
  await settle();
  assertTerminal(h.store, b.generation, 'completed', 'answer:B');
  assert.equal(h.sessions.runtimes.count(), 0);
  assert.deepEqual(h.controller.snapshot(), []);
  assert.deepEqual(h.foreground.calls.at(-1), {
    method: 'update', state: { kind: 'completed', generationId: b.generation.id, conversationId: b.generation.conversationId },
  });
  for (const [index, session] of sessionsBefore.entries()) {
    const current = h.sessions.get(session.id)!;
    assert.deepEqual({ ...current, updatedAt: session.updatedAt }, session);
    assert.equal(h.sessions.runtimes.get(session.id), scopes[index]);
    assert.equal(scopes[index]?.signal.aborted, false);
    assert.equal(h.controller.usageSummary(session.id)?.costMicros, 3000);
  }
  assert.ok(work.every((item) => !item.signal.aborted));
  assert.ok(!h.events.some((event) => event.type === 'runtime_cancelled' || event.type === 'archived'));
  assert.equal(h.requests.length, 3);
});

test('archiving A cancels nested R/W but preserves messages, telemetry and foreground for unrelated B/C', async (t) => {
  const h = setup(t);
  const a = h.sessions.create({ title: 'A' });
  const r = h.sessions.create({ title: 'R', kind: 'read', parentSessionId: a.id });
  const w = h.sessions.create({ title: 'W', kind: 'write', parentSessionId: r.id });
  const b = h.sessions.create({ title: 'B' });
  const c = h.sessions.create({ title: 'C' });
  const subtree = [a, r, w];
  const work = [];
  for (const session of [...subtree, b, c]) work.push(await h.send(session.id, session.title!));
  const cancellations: string[] = [];
  const registrations = [r, w].map((session) => h.sessions.registerWork(session.id, {
    id: session.kind, kind: session.kind,
    cancel: () => {
      assert.ok(subtree.every((item) => h.sessions.get(item.id)?.state === 'archived'));
      cancellations.push(session.id);
    },
  }));
  const before = work.map((item) => records(h.store, item.generation));
  const userMessages = work.map((item) => h.store.listMessages(item.generation.conversationId)[0]);
  const unrelatedSessions = [h.sessions.get(b.id), h.sessions.get(c.id)];
  h.sessions.archive(a.id);
  h.sessions.archive(a.id);
  assert.deepEqual(cancellations, [r.id, w.id]);
  assert.equal(h.sessions.runtimes.count(), 7, 'cancelled work counts until it finishes');
  assertThinking(h.foreground, 5);
  assert.deepEqual(work.map((item) => records(h.store, item.generation)), before);
  for (const [index, item] of work.entries()) {
    assert.equal(item.signal.aborted, index < 3);
    assert.equal(h.sessions.runtimes.get(item.generation.conversationId)?.signal.aborted, index < 3);
  }
  for (const registration of registrations) assert.equal(registration.signal.aborted, true);
  for (const session of subtree) await assert.rejects(h.send(session.id, 'blocked'), /archived/);
  assert.equal(h.requests.length, 5);

  t.mock.timers.tick(1000);
  await settle();
  for (const item of work.slice(0, 3)) {
    const saved = assertTerminal(h.store, item.generation, 'cancelled', `partial:${h.sessions.get(item.generation.conversationId)?.title}`);
    assert.equal(saved.usage?.reportedOutputTokens, 2);
    assert.equal(saved.attemptUsage?.reportedOutputTokens, 2);
    assert.equal(saved.call.apiEquivalentCostMicros, 3000);
    assert.equal(saved.generation?.usage?.outputTokens, 2);
    assert.ok(saved.message?.payloadJson);
  }
  assert.equal(h.sessions.runtimes.count(), 4);
  assertThinking(h.foreground, 2);
  for (const registration of registrations) { registration.finish(); registration.finish(); }
  assert.equal(h.sessions.runtimes.count(), 2);
  assert.deepEqual(work.map((item) => h.store.listMessages(item.generation.conversationId)[0]), userMessages);
  assert.deepEqual(work.slice(3).map((item) => records(h.store, item.generation)), before.slice(3));
  assert.deepEqual([h.sessions.get(b.id), h.sessions.get(c.id)], unrelatedSessions);
  assert.deepEqual(new Set(h.sessions.list('archived').map((session) => session.id)), new Set(subtree.map((session) => session.id)));

  const terminal = work.slice(0, 3).map((item) => records(h.store, item.generation));
  const calls = [...h.foreground.calls];
  for (const item of work.slice(0, 3)) item.stream.complete('late archived answer');
  await settle();
  t.mock.timers.tick(5000);
  await settle();
  assert.deepEqual(work.slice(0, 3).map((item) => records(h.store, item.generation)), terminal);
  assert.deepEqual(h.foreground.calls, calls);
  assert.equal(h.sessions.runtimes.count(), 2);
  work[4].stream.complete('C done');
  await settle();
  assertThinking(h.foreground, 1, work[3].generation);
  work[3].stream.complete('B done');
  await settle();
  assertTerminal(h.store, work[4].generation, 'completed', 'C done');
  assertTerminal(h.store, work[3].generation, 'completed', 'B done');
  assert.equal(h.sessions.runtimes.count(), 0);
  assert.equal(h.foreground.calls.filter((call) => call.method === 'stop').length, 1);
});

test('restore before cancellation drains creates a fresh scope; duplicate and late finishes cannot remove new work', async (t) => {
  const h = setup(t);
  const a = h.sessions.create({ title: 'A' });
  const old = await h.send(a.id, 'old');
  let cancelled = 0;
  const oldRegistration = h.sessions.registerWork(a.id, { id: 'write', kind: 'write', cancel() { cancelled++; } });
  const oldScope = h.sessions.runtimes.get(a.id)!;
  old.stream.push('+buffered');
  await settle();
  assert.equal(h.store.getMessage(old.generation.messageId)?.content, 'partial:old');
  h.sessions.archive(a.id);
  h.sessions.restore(a.id);
  const freshScope = h.sessions.runtimes.get(a.id)!;
  assert.notEqual(freshScope, oldScope);
  assert.equal(oldScope.signal.aborted, true);
  assert.equal(freshScope.signal.aborted, false);
  const freshRegistration = h.sessions.registerWork(a.id, { id: 'write', kind: 'write', cancel() { cancelled++; } });
  const fresh = await h.send(a.id, 'fresh');
  const sibling = await h.send(a.id, 'sibling');
  assert.equal(h.controller.activeFor(a.id).length, 3);
  assert.equal(h.sessions.runtimes.count(a.id), 5);
  assertThinking(h.foreground, 3);

  t.mock.timers.tick(1000);
  await settle();
  const saved = assertTerminal(h.store, old.generation, 'cancelled', 'partial:old+buffered');
  oldRegistration.finish();
  oldRegistration.finish();
  assert.equal(h.sessions.runtimes.count(a.id), 3);
  assert.equal(h.sessions.runtimes.get(a.id), freshScope);
  assert.equal(freshRegistration.signal, freshScope.signal);
  assertThinking(h.foreground, 2);
  const calls = [...h.foreground.calls];
  old.stream.push('late delta');
  old.stream.complete('late final');
  old.stream.complete('duplicate final');
  h.controller.cancel(old.generation.id);
  await settle();
  t.mock.timers.tick(5000);
  await settle();
  assert.deepEqual(records(h.store, old.generation), saved);
  assert.deepEqual(h.foreground.calls, calls);
  assert.equal(h.sessions.runtimes.count(a.id), 3);
  assert.equal(freshScope.signal.aborted, false);
  assert.equal(fresh.signal.aborted, false);
  assert.equal(sibling.signal.aborted, false);
  assert.equal(h.events.filter((event) => event.type === 'work_finished' && event.workId === old.generation.id).length, 1);
  assert.equal(h.events.filter((event) => event.type === 'work_finished' && event.workId === 'write').length, 1);

  h.sessions.archive(a.id);
  assert.equal(cancelled, 2, 'new registration with the reused ID is still registered');
  assert.equal(fresh.signal.aborted, true);
  assert.equal(sibling.signal.aborted, true);
  freshRegistration.finish();
  freshRegistration.finish();
  t.mock.timers.tick(1000);
  await settle();
  assertTerminal(h.store, fresh.generation, 'cancelled', 'partial:fresh');
  assertTerminal(h.store, sibling.generation, 'cancelled', 'partial:sibling');
  assert.equal(h.sessions.runtimes.count(), 0);
  assert.equal(h.foreground.calls.filter((call) => call.method === 'stop').length, 1);
});

test('cancelling one same-session generation leaves its session and sibling running, including a late result rejection', async (t) => {
  const h = setup(t);
  const session = h.sessions.create({ title: 'shared' });
  const first = await h.send(session.id, 'first');
  const sibling = await h.send(session.id, 'sibling');
  const scope = h.sessions.runtimes.get(session.id)!;
  first.stream.end();
  await settle();
  h.controller.cancel(first.generation.id);
  h.controller.cancel(first.generation.id);
  h.controller.cancel('missing');
  assert.equal(first.signal.aborted, true);
  assert.equal(sibling.signal.aborted, false);
  assert.equal(scope.signal.aborted, false);
  assert.equal(h.sessions.runtimes.count(session.id), 2);
  assertThinking(h.foreground, 2);
  t.mock.timers.tick(999);
  await settle();
  assert.equal(h.sessions.runtimes.count(session.id), 2);
  t.mock.timers.tick(1);
  await settle();
  const saved = assertTerminal(h.store, first.generation, 'cancelled', 'partial:first');
  assert.equal(h.sessions.runtimes.count(session.id), 1);
  assertThinking(h.foreground, 1, sibling.generation);
  const calls = [...h.foreground.calls];
  first.stream.final.reject(new Error('late provider rejection'));
  await settle();
  t.mock.timers.tick(5000);
  await settle();
  assert.deepEqual(records(h.store, first.generation), saved);
  assert.deepEqual(h.foreground.calls, calls);
  assert.equal(h.sessions.runtimes.get(session.id), scope);
  assert.equal(scope.signal.aborted, false);
  sibling.stream.push('+still running');
  await settle();
  assert.equal(h.controller.activeFor(session.id)[0]?.text, 'partial:sibling+still running');
  sibling.stream.complete('sibling done');
  await settle();
  assertTerminal(h.store, sibling.generation, 'completed', 'sibling done');
  assert.equal(h.sessions.get(session.id)?.state, 'active');
  assert.equal(h.sessions.runtimes.count(), 0);
  assert.ok(!h.events.some((event) => event.type === 'runtime_cancelled'));
});

async function persistedOrphans(t: TestContext) {
  const old = setup(t);
  const generations = [];
  for (const title of ['orphan A', 'orphan B']) {
    const session = old.sessions.create({ title });
    generations.push(await old.send(session.id, title));
  }
  const idle = old.sessions.create({ title: 'idle active session' });
  // Copy persisted rows only: a restarted process has no old controllers or scopes.
  const store = new MemoryStore();
  for (const session of old.sessions.list()) {
    store.createSession(session);
    for (const message of old.store.listMessages(session.id)) store.insertMessage(message);
  }
  for (const { generation } of generations) {
    const saved = records(old.store, generation);
    store.insertGeneration(saved.generation!);
    store.insertAgent(old.store.getAgent(saved.call.agentId)!);
    store.insertProviderAccount(old.store.getProviderAccount(saved.call.providerAccountId)!);
    store.insertTurn(saved.turn);
    store.insertAgentRun(saved.run);
    store.insertModelCall(saved.call);
    for (const attempt of saved.attempts) store.insertModelCallAttempt(attempt);
  }
  for (const item of generations) item.stream.complete('old process cleanup');
  await settle();
  return { store, generations: generations.map((item) => item.generation), idle };
}

test('process recovery interrupts multiple orphan sessions without archiving, default creation or resends', async (t) => {
  const { store, generations, idle } = await persistedOrphans(t);
  const foreground = new RecordingForeground();
  let sends = 0;
  const controller = new GenerationController({
    store, telemetry: new TelemetryService(store, () => 5000), foreground, now: () => 5000,
    streamSimple: () => { sends++; throw new Error('Recovery must not resend'); },
  });
  const before = controller.sessions.list();
  const users = generations.map((generation) => store.listMessages(generation.conversationId)[0]);
  controller.recoverOrphans();
  const recovered = generations.map((generation, index) =>
    assertTerminal(store, generation, 'interrupted', `partial:orphan ${index === 0 ? 'A' : 'B'}`));
  controller.recoverOrphans();
  await settle();
  assert.equal(sends, 0);
  assert.deepEqual(generations.map((generation) => records(store, generation)), recovered);
  assert.deepEqual(generations.map((generation) => store.listMessages(generation.conversationId)[0]), users);
  assert.deepEqual(controller.snapshot(), []);
  assert.equal(controller.sessions.runtimes.count(), 0);
  assert.equal(controller.sessions.list().length, 3);
  assert.equal(store.getSession(DEFAULT_CONVERSATION_ID), null);
  assert.deepEqual(store.getSession(idle.id), idle);
  for (const session of before) {
    const current = controller.sessions.get(session.id)!;
    assert.deepEqual({ ...current, updatedAt: session.updatedAt }, session);
    assert.equal(current.state, 'active');
    assert.equal(controller.sessions.runtimes.get(session.id), undefined);
  }
  assert.ok(foreground.calls.every((call) => call.method === 'stop'));
});

test('recovery while live cannot stop global foreground or interrupt live generation telemetry', async (t) => {
  const { store, generations, idle } = await persistedOrphans(t);
  const foreground = new RecordingForeground();
  const streams: ControlledStream[] = [];
  const signals: AbortSignal[] = [];
  const controller = new GenerationController({
    store, telemetry: new TelemetryService(store, () => 5000), foreground, now: () => 5000,
    streamSimple: (_model, _context, options) => {
      const stream = new ControlledStream();
      streams.push(stream);
      signals.push(options.signal);
      return stream;
    },
  });
  t.after(async () => { for (const stream of streams) stream.complete('cleanup'); await settle(); });
  const live = [];
  for (const sessionId of [idle.id, generations[0].conversationId]) {
    live.push(await controller.start({ conversationId: sessionId, text: 'live', model, providerId: model.provider }));
    streams.at(-1)!.push('live partial');
  }
  await settle();
  const before = live.map((generation) => records(store, generation));
  controller.recoverOrphans();
  controller.recoverOrphans();
  assertThinking(foreground, 2);
  assert.equal(controller.sessions.runtimes.count(), 2);
  assert.deepEqual(controller.snapshot().map((generation) => generation.id), live.map((generation) => generation.id));
  assert.equal(streams.length, 2, 'orphan work was not resent');
  assert.ok(signals.every((signal) => !signal.aborted));
  for (const generation of live) {
    assert.equal(controller.sessions.runtimes.get(generation.conversationId)?.signal.aborted, false);
    assert.equal(store.getGeneration(generation.id)?.status, 'streaming');
    assert.equal(store.getMessage(generation.messageId)?.status, 'streaming');
  }
  for (const generation of generations) assert.equal(store.getGeneration(generation.id)?.status, 'interrupted');
  const afterRecovery = live.map((generation) => records(store, generation));
  streams[1].complete('second done');
  await settle();
  assertThinking(foreground, 1, live[0]);
  assert.equal(controller.sessions.runtimes.count(), 1);
  streams[0].complete('first done');
  await settle();
  assert.equal(controller.sessions.runtimes.count(), 0);
  assert.deepEqual(controller.snapshot(), []);
  assert.equal(foreground.calls.filter((call) => call.method === 'stop').length, 1);
  assert.deepEqual(foreground.calls.at(-1), { method: 'stop', state: { kind: 'idle' } });
  assert.equal(controller.sessions.list('active').length, 3);
  assert.equal(store.getSession(DEFAULT_CONVERSATION_ID), null);
  assert.deepEqual(afterRecovery, before, 'recovery must skip live telemetry as well as live generations');
  assertTerminal(store, live[1], 'completed', 'second done');
  assertTerminal(store, live[0], 'completed', 'first done');
});
