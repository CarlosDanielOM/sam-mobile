import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { mock, test } from 'node:test';
import { Injector, signal } from '@angular/core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import ts from 'typescript';
import { MemoryStore } from '../persistence/memory-store.ts';
import { GenerationController } from '../generation/controller.ts';
import type { ForegroundState, ForegroundThinking, GenerationState, StartGenerationInput, StreamSimpleFn } from '../generation/types.ts';
import { SessionEngine } from './session-engine.ts';

// Node strips types but not Angular decorators. Compile only the two UI facades;
// keep real Angular signals/DI and the engine, mocking native/service boundaries.
registerHooks({
  load(url, context, nextLoad) {
    if (/\/(session-store|chat\.store)\.ts$/.test(url)) {
      return {
        format: 'module', shortCircuit: true,
        source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, experimentalDecorators: true },
        }).outputText,
      };
    }
    return nextLoad(url, context);
  },
});

const settings = new Map<string, string>();
let repository: MemoryStore;
class GenerationManager {}
class ProviderService {}
class AgentPromptService {}
mock.module('@nativescript/core', { namedExports: { ApplicationSettings: {
  getString: (key: string, fallback: string) => settings.get(key) ?? fallback,
  setString: (key: string, value: string) => settings.set(key, value),
} } });
mock.module('../generation/generation-manager.ts', { namedExports: { GenerationManager } });
mock.module('../provider.service.ts', { namedExports: { ProviderService } });
mock.module('../agent-prompt.service.ts', { namedExports: { AgentPromptService } });
mock.module('../persistence/store.ts', { namedExports: { persistence: () => repository } });
const { SessionStore } = await import('./session-store.ts');
const { ChatStore } = await import('../chat.store.ts');

function setup() {
  settings.clear();
  repository = new MemoryStore();
  let sequence = 0;
  const engine = new SessionEngine(repository, { id: () => `s${++sequence}`, clock: () => sequence });
  const calls: StartGenerationInput[] = [];
  const active = signal<any>({ providerId: 'provider', model: { id: 'model' }, billingMode: 'metered' });
  const manager = {
    sessions: engine,
    snapshot: signal<GenerationState[]>([]),
    revision: signal(0),
    start: async (input: StartGenerationInput) => { calls.push(input); },
    retry: mock.fn(async (_input: unknown) => {}),
    cancel: mock.fn(),
    activeFor: (id: string) => manager.snapshot().filter((item) => item.conversationId === id),
    usageSummary: mock.fn((_id: string) => null),
    turnUsage: mock.fn((_id: string) => null),
  };
  function mount(generations: typeof manager | GenerationController = manager) {
    const injector = Injector.create({ providers: [
      { provide: GenerationManager, useValue: generations },
      { provide: ProviderService, useValue: { active, runtime: { getModel: () => null } } },
      { provide: AgentPromptService, useValue: { get: () => 'SAM prompt' } },
      { provide: SessionStore, useFactory: () => new SessionStore() },
      { provide: ChatStore, useFactory: () => new ChatStore() },
    ] });
    return { injector, sessions: injector.get(SessionStore), chat: injector.get(ChatStore) };
  }
  function message(sessionId: string, id: string, text: string) {
    repository.insertMessage({ id, conversationId: sessionId, role: 'assistant', content: text,
      status: 'interrupted', provider: 'provider', model: 'model', createdAt: 1, updatedAt: 1,
      error: null, payloadJson: null });
  }
  return { engine, manager, active, calls, mount, message };
}

test('initial selection creates SAM once; recreation reuses it and unsubscribes the old facade', () => {
  const { engine, mount } = setup();
  const first = mount();
  const id = first.sessions.selectedSessionId();
  assert.equal(engine.list().length, 1);
  assert.equal(engine.get(id!)?.title, 'SAM');
  first.injector.destroy();
  const second = mount();
  assert.equal(second.sessions.selectedSessionId(), id);
  assert.equal(engine.list().length, 1);
  engine.create();
  assert.equal(first.sessions.activeSessions().length, 1);
  assert.equal(second.sessions.activeSessions().length, 2);
  second.injector.destroy();
});

test('saved active selection wins; missing or archived saved IDs use existing active history', () => {
  const { engine, mount } = setup();
  const a = engine.create();
  const b = engine.create();
  settings.set('sam.selectedSessionId', a.id);
  let view = mount();
  assert.equal(view.sessions.selectedSessionId(), a.id);
  view.injector.destroy();
  engine.archive(a.id);
  for (const saved of [a.id, 'missing']) {
    settings.set('sam.selectedSessionId', saved);
    view = mount();
    assert.equal(view.sessions.selectedSessionId(), b.id);
    assert.equal(engine.list().length, 2);
    view.injector.destroy();
  }
});

test('cold history selection does not create runtime scopes or change persisted messages', () => {
  const { engine, manager, mount, message } = setup();
  const saved = engine.create();
  message(saved.id, 'saved', 'Interrupted history');
  manager.sessions = new SessionEngine(repository);
  const before = repository.listMessages(saved.id);
  const view = mount();
  assert.equal(view.sessions.selectedSessionId(), saved.id);
  assert.equal(view.chat.messages()[0].text, 'Interrupted history');
  assert.equal(view.chat.messages()[0].status, 'interrupted');
  assert.equal(manager.sessions.runtimes.get(saved.id), undefined);
  assert.deepEqual(repository.listMessages(saved.id), before);
  assert.equal(repository.listSessions().length, 1);
  view.injector.destroy();
});

test('only archived history initializes one fresh session, never restores implicitly', () => {
  const { engine, mount } = setup();
  const archived = engine.create();
  engine.archive(archived.id);
  settings.set('sam.selectedSessionId', archived.id);
  const view = mount();
  assert.equal(view.sessions.activeSessions().length, 1);
  assert.equal(view.sessions.archivedSessions().length, 1);
  assert.notEqual(view.sessions.selectedSessionId(), archived.id);
  view.injector.destroy();
  const next = mount();
  assert.equal(engine.list().length, 2);
  next.injector.destroy();
});

test('creation and archive persistence failures surface without duplicate creation or selection loss', () => {
  const { engine, mount } = setup();
  const create = mock.method(repository, 'createSession', () => { throw new Error('Create failed'); });
  const view = mount();
  assert.equal(view.sessions.selectedSessionId(), null);
  assert.equal(view.sessions.error(), 'Create failed');
  assert.equal(engine.list().length, 0);
  create.mock.restore();
  assert.equal(view.sessions.create(), true);
  const selected = view.sessions.selectedSessionId()!;
  assert.equal(engine.list().length, 1);
  const archive = mock.method(repository, 'archiveSessions', () => { throw new Error('Archive failed'); });
  assert.equal(view.sessions.archive(selected), false);
  assert.equal(view.sessions.error(), 'Archive failed');
  assert.equal(view.sessions.selectedSessionId(), selected);
  assert.equal(view.sessions.activeSessions().length, 1);
  archive.mock.restore();
  view.injector.destroy();
});

test('archive selected chooses another active session or exactly one fresh session; restore only selects history', () => {
  const { engine, manager, calls, mount, message } = setup();
  const view = mount();
  const a = view.sessions.selectedSessionId()!;
  message(a, 'saved', 'Saved answer');
  view.sessions.create();
  const b = view.sessions.selectedSessionId()!;
  const cancel = mock.fn();
  const work = engine.registerWork(b, { id: 'work', kind: 'generation', cancel });
  assert.equal(view.sessions.runningCount(), 1);
  assert.equal(view.sessions.selectedSession()?.runningCount, 1);
  view.sessions.select(a);
  assert.equal(cancel.mock.callCount(), 0);
  assert.equal(work.signal.aborted, false);
  view.sessions.archive(a);
  assert.equal(view.sessions.selectedSessionId(), b);
  view.sessions.archive(b);
  const fresh = view.sessions.selectedSessionId();
  assert.notEqual(fresh, a);
  assert.notEqual(fresh, b);
  assert.equal(engine.list().length, 3);
  assert.equal(view.sessions.activeSessions().length, 1);
  assert.equal(cancel.mock.callCount(), 1);
  work.finish();
  assert.equal(view.sessions.runningCount(), 0);
  assert.equal(view.sessions.restore(a), true);
  assert.equal(view.sessions.selectedSessionId(), a);
  assert.equal(view.chat.messages()[0].text, 'Saved answer');
  assert.equal(view.chat.messages()[0].status, 'interrupted');
  assert.deepEqual(calls, []);
  assert.equal(manager.retry.mock.callCount(), 0);
  assert.equal(manager.cancel.mock.callCount(), 0);
  view.injector.destroy();
});

test('external parent archive replaces selected child; invalid actions surface errors without selecting archives', () => {
  const { engine, mount } = setup();
  const parent = engine.create();
  const child = engine.create({ parentSessionId: parent.id });
  const view = mount();
  view.sessions.select(child.id);
  engine.archive(parent.id);
  assert.equal(view.sessions.activeSessions().length, 1);
  assert.equal(engine.list().length, 3);
  const selected = view.sessions.selectedSessionId();
  assert.equal(view.sessions.select(child.id), false);
  assert.equal(view.sessions.restore(child.id), false);
  assert.match(view.sessions.error()!, /archived/);
  assert.equal(view.sessions.selectedSessionId(), selected);
  assert.equal(view.sessions.archive('missing'), false);
  assert.match(view.sessions.error()!, /not found/);
  view.injector.destroy();
});

test('rehydration and selection immediately join only selected persisted/live messages, with no runtime changes', () => {
  const { engine, manager, calls, mount, message } = setup();
  const a = engine.create();
  const b = engine.create();
  message(a.id, 'a', 'Old checkpoint');
  message(b.id, 'b', 'Other history');
  const cancel = mock.fn();
  const work = engine.registerWork(a.id, { id: 'live', kind: 'generation', cancel });
  manager.snapshot.set([{ id: 'live', conversationId: a.id, messageId: 'a', provider: 'provider',
    model: 'model', status: 'streaming', text: 'Live answer', startedAt: 1 }]);
  settings.set('sam.selectedSessionId', a.id);
  const view = mount();
  assert.equal(view.chat.messages()[0].text, 'Live answer');
  assert.equal(view.chat.sending(), true);
  view.sessions.select(b.id);
  assert.deepEqual(view.chat.messages().map((m) => m.text), ['Other history']);
  assert.equal(view.chat.sending(), false);
  view.chat.usageSummary();
  view.chat.turnUsage();
  assert.equal(manager.usageSummary.mock.calls.at(-1)!.arguments[0], b.id);
  assert.equal(manager.turnUsage.mock.calls.at(-1)!.arguments[0], b.id);
  repository.updateMessage('b', { content: 'Updated history' });
  manager.revision.update((n) => n + 1);
  assert.equal(view.chat.messages()[0].text, 'Updated history');
  view.sessions.select(a.id);
  assert.equal(view.chat.messages()[0].text, 'Live answer');
  view.injector.destroy();
  const rehydrated = mount();
  assert.equal(rehydrated.chat.messages()[0].text, 'Live answer');
  assert.equal(engine.list().length, 2);
  assert.equal(engine.runtimes.get(a.id)?.signal, work.signal);
  assert.equal(work.signal.aborted, false);
  assert.equal(cancel.mock.callCount(), 0);
  assert.deepEqual(calls, []);
  assert.equal(manager.retry.mock.callCount(), 0);
  assert.equal(manager.cancel.mock.callCount(), 0);
  rehydrated.injector.destroy();
});

test('A/B/C real streams survive selection and UI teardown; archive cancels only A and restore never resends', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  const { mount } = setup();
  const streams = ['A', 'B', 'C'].map((label) => ({
    label,
    progress: Promise.withResolvers<void>(),
    completion: Promise.withResolvers<void>(),
    aborted: mock.fn(),
  }));
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  let requestIndex = 0;
  const streamSimple = mock.fn<StreamSimpleFn>((model, context, options) => {
    const stream = streams[requestIndex++];
    assert.ok(stream, 'selection, remount and restore must not start another request');
    assert.deepEqual(context.messages.map((message) => [message.role, message.content]), [
      ['user', `${stream.label} draft`],
    ]);
    assert.equal(context.systemPrompt, 'SAM prompt');
    options.signal.addEventListener('abort', stream.aborted, { once: true });
    const result: AssistantMessage = {
      role: 'assistant', content: [{ type: 'text', text: `${stream.label} complete` }],
      api: 'openai-completions', provider: 'provider', model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: 1_000,
    };
    return Object.assign((async function* () {
      yield { type: 'text_delta', delta: `${stream.label} partial` };
      yield { type: 'text_delta', delta: ' live' };
      await stream.progress.promise;
      yield { type: 'text_delta', delta: ' detached' };
      await stream.completion.promise;
    })(), { result: async () => result });
  });
  const foreground = {
    start: mock.fn((_state: ForegroundThinking) => {}),
    update: mock.fn((_state: ForegroundState) => {}),
    stop: mock.fn(),
    setCancelHandler: mock.fn(),
  };
  let visible = true;
  const controller = new GenerationController({
    store: repository, streamSimple, foreground, isAppVisible: () => visible,
  });
  const engine = controller.sessions;
  assert.equal(engine.list().length, 0);
  let view = mount(controller);
  let mounted = true;
  t.after(async () => {
    if (mounted) view.injector.destroy();
    for (const stream of streams) {
      stream.progress.resolve();
      stream.completion.resolve();
    }
    await settle();
  });
  assert.equal(view.injector.get(GenerationManager), controller);
  assert.equal(engine.list().length, 1);
  const a = view.sessions.selectedSessionId()!;
  view.chat.setDraft('A draft');
  assert.equal(view.chat.draft(), 'A draft');
  await view.chat.send();
  await settle();
  assert.equal(view.chat.draft(), '');
  assert.equal(view.sessions.create(), true);
  const b = view.sessions.selectedSessionId()!;
  assert.deepEqual(view.chat.messages(), []);
  assert.equal(view.chat.sending(), false);
  assert.equal(view.chat.draft(), '');
  view.chat.setDraft('B draft');
  await view.chat.send();
  await settle();
  assert.equal(view.sessions.create(), true);
  const c = view.sessions.selectedSessionId()!;
  assert.deepEqual(view.chat.messages(), []);
  assert.equal(view.chat.sending(), false);
  assert.equal(view.chat.draft(), '');
  view.chat.setDraft('C draft');
  await view.chat.send();
  await settle();
  assert.equal(new Set([a, b, c]).size, 3);
  const scopes = [a, b, c].map((id) => engine.runtimes.get(id)!);
  const generations = [a, b, c].map((id) => controller.activeFor(id)[0]);
  const requestSignals = streamSimple.mock.calls.map((call) => call.arguments[2].signal);
  assert.equal(requestSignals.length, 3);

  for (const id of [a, c, b, a, b, c]) {
    const index = [a, b, c].indexOf(id);
    const label = streams[index].label;
    assert.equal(view.sessions.select(id), true);
    assert.equal(view.chat.conversationId(), id);
    assert.deepEqual(view.chat.messages().map((message) => [message.role, message.text, message.status]), [
      ['user', `${label} draft`, 'completed'],
      ['assistant', `${label} partial live`, 'streaming'],
    ]);
    // The second delta is live-only until the coalesced persistence timer fires.
    assert.equal(repository.getMessage(generations[index].messageId)?.content, `${label} partial`);
    assert.equal(view.chat.draft(), '');
    assert.equal(view.chat.sending(), true);
    assert.equal(view.sessions.selectedSession()?.runningCount, 1);
    assert.equal(view.sessions.runningCount(), 3);
    assert.equal(controller.activeFor(id)[0].id, generations[index].id);
    assert.equal(engine.runtimes.get(id), scopes[index]);
    assert.equal(streamSimple.mock.callCount(), 3);
    assert.ok(requestSignals.every((signal) => !signal.aborted));
    assert.ok(streams.every((stream) => stream.aborted.mock.callCount() === 0));
  }
  assert.deepEqual(foreground.start.mock.calls.map((call) => call.arguments[0].activeCount), [1, 2, 3]);
  const detached = view;
  view.injector.destroy();
  mounted = false;
  visible = false;
  assert.equal(controller.snapshot().length, 3);
  assert.equal(engine.runtimes.count(), 3);
  assert.ok(requestSignals.every((signal) => !signal.aborted));
  for (const stream of streams) stream.progress.resolve();
  streams[1].completion.resolve();
  await settle();

  assert.deepEqual(controller.snapshot().map((state) => [state.conversationId, state.text, state.status]), [
    [a, 'A partial live detached', 'streaming'],
    [c, 'C partial live detached', 'streaming'],
  ]);
  assert.equal(engine.runtimes.count(), 2);
  assert.equal(detached.sessions.runningCount(), 3, 'destroyed facade no longer receives runtime events');
  assert.deepEqual(foreground.start.mock.calls.at(-1)!.arguments[0], {
    kind: 'thinking', generationId: undefined, conversationId: undefined, modelName: undefined, activeCount: 2,
  });
  assert.equal(foreground.stop.mock.callCount(), 0);
  assert.equal(foreground.update.mock.callCount(), 0);
  const completedB = repository.listMessages(b);
  assert.equal(completedB[1].content, 'B complete');
  assert.equal(completedB[1].status, 'completed');
  assert.equal(repository.getGeneration(generations[1].id)?.status, 'completed');
  assert.equal(streamSimple.mock.callCount(), 3);
  assert.ok(requestSignals.every((signal) => !signal.aborted));

  visible = true;
  view = mount(controller);
  mounted = true;
  assert.notEqual(view.sessions, detached.sessions);
  assert.notEqual(view.chat, detached.chat);
  assert.equal(view.injector.get(GenerationManager), controller);
  assert.equal(view.sessions.selectedSessionId(), c);
  assert.equal(engine.list().length, 3);
  assert.equal(view.chat.messages()[1].text, 'C partial live detached');
  assert.equal(view.chat.sending(), true);
  assert.equal(view.sessions.runningCount(), 2);
  assert.equal(view.sessions.select(b), true);
  assert.deepEqual(view.chat.messages().map((message) => [message.text, message.status]), [
    ['B draft', 'completed'], ['B complete', 'completed'],
  ]);
  assert.equal(view.chat.sending(), false);
  assert.equal(view.sessions.selectedSession()?.runningCount, 0);
  assert.deepEqual(repository.listMessages(b), completedB);
  assert.equal(view.sessions.select(c), true);
  assert.equal(streamSimple.mock.callCount(), 3);
  assert.ok(requestSignals.every((signal) => !signal.aborted));

  assert.equal(view.sessions.archive(a), true);
  assert.equal(view.sessions.selectedSessionId(), c);
  assert.deepEqual(requestSignals.map((signal) => signal.aborted), [true, false, false]);
  assert.deepEqual(streams.map((stream) => stream.aborted.mock.callCount()), [1, 0, 0]);
  assert.equal(scopes[0].signal.aborted, true);
  assert.equal(engine.runtimes.get(a), scopes[0]);
  assert.equal(engine.runtimes.get(c), scopes[2]);
  t.mock.timers.tick(1_000);
  await settle();
  const archivedA = repository.listMessages(a);
  assert.deepEqual(archivedA.map((message) => [message.content, message.status]), [
    ['A draft', 'completed'], ['A partial live detached', 'cancelled'],
  ]);
  assert.equal(repository.getGeneration(generations[0].id)?.status, 'cancelled');
  assert.deepEqual(view.sessions.archivedSessions().map((session) => session.id), [a]);
  assert.equal(view.sessions.runningCount(), 1);
  assert.equal(controller.activeFor(c)[0].id, generations[2].id);
  assert.equal(foreground.start.mock.calls.at(-1)!.arguments[0].activeCount, 1);
  assert.equal(foreground.stop.mock.callCount(), 0);

  assert.equal(view.sessions.restore(a), true);
  assert.equal(view.sessions.selectedSessionId(), a);
  assert.deepEqual(repository.listMessages(a), archivedA);
  assert.deepEqual(view.chat.messages().map((message) => [message.text, message.status]), [
    ['A draft', 'completed'], ['A partial live detached', 'cancelled'],
  ]);
  assert.equal(view.chat.sending(), false);
  assert.equal(view.sessions.selectedSession()?.runningCount, 0);
  assert.notEqual(engine.runtimes.get(a), scopes[0]);
  assert.equal(engine.runtimes.get(a)?.signal.aborted, false);
  assert.equal(engine.list().length, 3);
  assert.equal(view.sessions.activeSessions().length, 3);
  assert.equal(view.sessions.archivedSessions().length, 0);
  streams[0].completion.resolve();
  await settle();
  assert.deepEqual(repository.listMessages(a), archivedA, 'late archived stream cannot overwrite restored history');
  assert.deepEqual(repository.listMessages(b), completedB);
  assert.equal(controller.snapshot().length, 1);
  assert.equal(controller.activeFor(c)[0].id, generations[2].id);
  assert.equal(streamSimple.mock.callCount(), 3);
  assert.deepEqual(streams.map((stream) => stream.aborted.mock.callCount()), [1, 0, 0]);
});

test('drafts, pending guards and async start errors stay with the captured session and model', async () => {
  const { engine, manager, active, calls, mount } = setup();
  const view = mount();
  const a = view.sessions.selectedSessionId()!;
  const b = engine.create();
  let reject!: (error: Error) => void;
  manager.start = (input) => {
    calls.push(input);
    return new Promise<void>((_resolve, fail) => { reject = fail; });
  };
  view.chat.setDraft('A draft');
  const sending = view.chat.send();
  view.chat.setDraft('Do not send twice');
  await view.chat.send();
  assert.equal(calls.length, 1);
  view.sessions.select(b.id);
  assert.equal(view.chat.draft(), '');
  assert.equal(view.chat.sending(), false);
  view.chat.setDraft('B draft');
  active.set({ providerId: 'other', model: { id: 'other-model' } });
  reject(new Error('Start failed'));
  await sending;
  assert.equal(view.chat.error(), null);
  assert.equal(view.chat.draft(), 'B draft');
  assert.equal(calls[0].conversationId, a);
  assert.equal(calls[0].model.id, 'model');
  assert.equal(calls[0].providerId, 'provider');
  assert.equal(calls[0].billingMode, 'metered');
  assert.equal(calls[0].systemPrompt, 'SAM prompt');
  view.sessions.select(a);
  assert.equal(view.chat.error(), 'Start failed');
  assert.equal(view.chat.draft(), 'Do not send twice');
  assert.equal(view.chat.sending(), false);
  view.injector.destroy();
});

test('missing provider and retry failures are visible only in their session', async () => {
  const { engine, manager, active, mount } = setup();
  const view = mount();
  const a = view.sessions.selectedSessionId()!;
  const b = engine.create();
  active.set(null);
  view.chat.setDraft('Keep this');
  await view.chat.send();
  assert.equal(view.chat.error(), 'Connect a provider first.');
  assert.equal(view.chat.draft(), 'Keep this');
  active.set({ providerId: 'provider', model: { id: 'model' } });
  manager.retry.mock.mockImplementation(async () => { throw new Error('Retry failed'); });
  await view.chat.retry('message');
  assert.equal(view.chat.error(), 'Retry failed');
  view.sessions.select(b.id);
  assert.equal(view.chat.error(), null);
  assert.equal(view.chat.draft(), '');
  view.sessions.select(a);
  assert.equal(view.chat.error(), 'Retry failed');
  view.injector.destroy();
});
