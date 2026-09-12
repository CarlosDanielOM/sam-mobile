import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStore } from '../persistence/memory-store.ts';
import { GenerationController } from '../generation/controller.ts';
import { SessionEngine } from './session-engine.ts';
import type { SessionEvent } from './types.ts';

function setup() {
  const repository = new MemoryStore();
  let at = 100;
  let id = 0;
  const engine = new SessionEngine(repository, { clock: () => at++, id: () => `s${++id}` });
  return { repository, engine };
}

test('construction is empty; create/get/list/update preserve identity and nullable fields', () => {
  const { repository, engine } = setup();
  assert.deepEqual(engine.list(), []);
  assert.equal(engine.runtimes.count(), 0);
  assert.equal(engine.get('missing'), null);
  const session = engine.create();
  assert.deepEqual(session, {
    id: 's1', title: null, kind: 'chat', state: 'active', ownerAgentId: null,
    parentSessionId: null, createdAt: 100, updatedAt: 100, archivedAt: null,
  });
  assert.deepEqual(repository.getConversation(session.id), session);
  const updated = engine.update(session.id, { title: 'Research', kind: 'background', ownerAgentId: 'opaque:not-an-agent-row' });
  assert.deepEqual(updated, { ...session, title: 'Research', kind: 'background', ownerAgentId: 'opaque:not-an-agent-row', updatedAt: 101 });
  updated.title = 'mutated';
  assert.equal(engine.get(session.id)?.title, 'Research');
  engine.update(session.id, { title: null, ownerAgentId: null });
  assert.equal(engine.get(session.id)?.title, null);
  const child = engine.create({ parentSessionId: session.id, kind: 'custom-kind' });
  assert.equal(child.parentSessionId, session.id);
  assert.deepEqual(repository.listSessionChildren(session.id), [child]);
  assert.deepEqual(engine.list('active').map((s) => s.id), [child.id, session.id]);
  assert.throws(() => engine.create({ parentSessionId: 'missing' }), /not found/);
  assert.throws(() => engine.update('missing', {}), /not found/);
});

test('default IDs are unique across engines, and collisions never overwrite a session', () => {
  const repository = new MemoryStore();
  const engines = [new SessionEngine(repository), new SessionEngine(repository)];
  const ids = Array.from({ length: 1000 }, (_, i) => engines[i % 2].create().id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(repository.listSessions().length, ids.length);
  const engine = new SessionEngine(repository, { id: () => ids[0] });
  const original = repository.getSession(ids[0]);
  assert.throws(() => engine.create({ title: 'overwrite' }), /already exists/);
  assert.deepEqual(repository.getSession(ids[0]), original);
});

test('concurrent work is tracked independently across kinds and sessions', () => {
  const { engine } = setup();
  const a = engine.create();
  const b = engine.create();
  const work = [
    engine.registerWork(a.id, { id: 'read', kind: 'read', cancel() {} }),
    engine.registerWork(a.id, { id: 'write', kind: 'write', cancel() {} }),
    engine.registerWork(b.id, { id: 'read', kind: 'read', cancel() {} }),
  ];
  assert.equal(engine.runtimes.count(), 3);
  assert.equal(engine.runtimes.count(a.id), 2);
  assert.equal(work[0].signal, engine.runtimes.get(a.id)?.signal);
  assert.throws(() => engine.registerWork(a.id, { id: 'read', kind: 'other', cancel() {} }), /already registered/);
  work[0].finish();
  work[0].finish();
  assert.equal(engine.runtimes.count(), 2);
  assert.equal(work[1].signal.aborted, false);
  work[1].finish();
  work[2].finish();
  assert.equal(engine.runtimes.count(), 0);
});

test('archive atomically marks nested read/write work before cancelling only its subtree', () => {
  const { engine } = setup();
  const parent = engine.create();
  const root = engine.create({ parentSessionId: parent.id });
  const child = engine.create({ parentSessionId: root.id });
  const grandchild = engine.create({ parentSessionId: child.id });
  const sibling = engine.create({ parentSessionId: parent.id });
  const unrelated = engine.create();
  const cancelled: string[] = [];
  const targets = [root, child, grandchild];
  const registrations = [parent, ...targets, sibling, unrelated].flatMap((session) =>
    ['read', 'write'].map((kind) => ({ session, registration: engine.registerWork(session.id, {
      id: kind, kind,
      cancel() {
        assert.ok(targets.every((target) => engine.get(target.id)?.state === 'archived'));
        cancelled.push(`${session.id}:${kind}`);
      },
    }) })));
  const archived = engine.archive(root.id);
  assert.equal(archived.archivedAt, 106);
  assert.equal(cancelled.length, 6);
  assert.equal(engine.runtimes.count(), 12);
  assert.deepEqual(new Set(engine.list('archived').map((s) => s.id)), new Set(targets.map((s) => s.id)));
  for (const { session, registration } of registrations) {
    assert.equal(registration.signal.aborted, targets.includes(session));
    registration.finish();
  }
  assert.equal(engine.list().length, 6);
  assert.equal(engine.runtimes.count(), 0);
  engine.archive(root.id);
  assert.equal(cancelled.length, 6);
  assert.equal(engine.get(root.id)?.archivedAt, archived.archivedAt);
});

test('restore refreshes only target scope; draining registrations can finish after ID reuse', () => {
  const { engine } = setup();
  const root = engine.create();
  const child = engine.create({ parentSessionId: root.id });
  let cancellations = 0;
  const old = engine.registerWork(root.id, { id: 'work', kind: 'write', cancel() { cancellations++; } });
  const oldRootScope = engine.runtimes.get(root.id);
  const oldChildScope = engine.runtimes.get(child.id);
  engine.archive(root.id);
  assert.throws(() => engine.restore(child.id), /archived/);
  assert.throws(() => engine.create({ parentSessionId: child.id }), /archived/);
  assert.throws(() => engine.registerWork(child.id, { id: 'x', kind: 'read', cancel() {} }), /archived/);
  const restored = engine.restore(root.id);
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.createdAt, root.createdAt);
  assert.equal(engine.get(child.id)?.state, 'archived');
  assert.notEqual(engine.runtimes.get(root.id), oldRootScope);
  assert.equal(old.signal.aborted, true);
  assert.equal(engine.runtimes.get(root.id)?.signal.aborted, false);
  const fresh = engine.registerWork(root.id, { id: 'work', kind: 'write', cancel() { cancellations++; } });
  assert.equal(engine.runtimes.count(root.id), 2);
  old.finish();
  old.finish();
  assert.equal(engine.runtimes.count(root.id), 1);
  assert.equal(fresh.signal.aborted, false);
  engine.restore(child.id);
  assert.notEqual(engine.runtimes.get(child.id), oldChildScope);
  engine.archive(root.id);
  assert.equal(cancellations, 2);
  assert.equal(fresh.signal.aborted, true);
  fresh.finish();
  assert.equal(engine.runtimes.count(), 0);
});

test('active descendants cannot work, create children, or restore beneath an archived ancestor', () => {
  const { repository, engine } = setup();
  const root = engine.create();
  const child = engine.create({ parentSessionId: root.id });
  repository.archiveSessions([root.id], 200);
  assert.throws(() => engine.requireActive(child.id), /archived/);
  assert.throws(() => engine.restore(child.id), /archived/);
  assert.throws(() => engine.create({ parentSessionId: child.id }), /archived/);
  assert.throws(() => engine.registerWork(child.id, { id: 'x', kind: 'read', cancel() {} }), /archived/);
});

test('observers and cancellation exceptions are isolated, including reentrant archive registration', () => {
  const { engine } = setup();
  const events: SessionEvent[] = [];
  engine.subscribe(() => { throw new Error('observer'); });
  const unsubscribe = engine.subscribe((event) => events.push(event));
  const root = engine.create();
  const child = engine.create({ parentSessionId: root.id });
  const rejected: string[] = [];
  let lastCancelled = false;
  const attempt = () => {
    for (const session of [root, child]) {
      try { engine.registerWork(session.id, { id: 'reentrant', kind: 'write', cancel() {} }); }
      catch { rejected.push(session.id); }
      assert.throws(() => engine.restore(session.id), /archived/);
    }
  };
  const first = engine.registerWork(root.id, { id: 'a', kind: 'read', cancel() { attempt(); throw new Error('cancel'); } });
  const last = engine.registerWork(child.id, { id: 'b', kind: 'write', cancel() { lastCancelled = true; } });
  engine.subscribe((event) => { if (event.type === 'archived') attempt(); });
  engine.archive(root.id);
  assert.equal(lastCancelled, true);
  assert.equal(rejected.length, 6);
  assert.equal(engine.runtimes.count(), 2);
  first.finish();
  last.finish();
  engine.restore(root.id);
  engine.update(root.id, { title: 'new' });
  assert.deepEqual(new Set(events.map((e) => e.type)), new Set([
    'created', 'updated', 'archived', 'restored', 'work_started', 'work_finished', 'runtime_cancelled',
  ]));
  const count = events.length;
  unsubscribe();
  engine.create();
  assert.equal(events.length, count);
});

test('archive persistence failure leaves all runtime scopes running and releases guards', () => {
  const { repository, engine } = setup();
  const root = engine.create();
  const archive = repository.archiveSessions.bind(repository);
  repository.archiveSessions = () => { throw new Error('write failed'); };
  const work = engine.registerWork(root.id, { id: 'a', kind: 'read', cancel() { assert.fail('cancelled'); } });
  assert.throws(() => engine.archive(root.id), /write failed/);
  assert.equal(work.signal.aborted, false);
  assert.equal(engine.requireActive(root.id).state, 'active');
  repository.archiveSessions = archive;
  work.finish();
  engine.archive(root.id);
  assert.equal(engine.get(root.id)?.state, 'archived');
});

test('archive preserves history and startup recovery changes work status, not session lifecycle', () => {
  const { repository, engine } = setup();
  const root = engine.create({ title: 'history' });
  repository.insertMessage({ id: 'm', conversationId: root.id, role: 'assistant', content: 'partial',
    status: 'streaming', provider: 'p', model: 'm', createdAt: 1, updatedAt: 1, error: null, payloadJson: '{"saved":true}' });
  repository.insertGeneration({ id: 'g', conversationId: root.id, messageId: 'm', status: 'streaming',
    provider: 'p', model: 'm', startedAt: 1, completedAt: null, error: null, usage: { outputTokens: 7 } });
  const message = repository.getMessage('m');
  const generation = repository.getGeneration('g');
  const archived = engine.archive(root.id);
  assert.deepEqual(repository.getMessage('m'), message);
  assert.deepEqual(repository.getGeneration('g'), generation);
  assert.deepEqual(repository.ensureConversation(root.id, 'ignored'), archived);
  const reopened = new SessionEngine(repository);
  assert.deepEqual(reopened.get(root.id), archived);
  assert.equal(reopened.runtimes.get(root.id), undefined);
  const controller = new GenerationController({ store: repository, streamSimple: () => { throw new Error('not used'); },
    foreground: { start() {}, stop() {}, update() {}, setCancelHandler() {} }, now: () => 500 });
  controller.recoverOrphans();
  assert.equal(repository.getGeneration('g')?.status, 'interrupted');
  assert.equal(repository.getGeneration('g')?.usage?.outputTokens, 7);
  assert.equal(repository.getMessage('m')?.content, 'partial');
  assert.equal(repository.getMessage('m')?.payloadJson, message?.payloadJson);
  assert.equal(reopened.get(root.id)?.state, 'archived');
  assert.equal(reopened.get(root.id)?.archivedAt, archived.archivedAt);
  assert.equal(reopened.get(root.id)?.createdAt, root.createdAt);
  reopened.restore(root.id);
  assert.equal(repository.listMessages(root.id).length, 1);
  assert.equal(repository.getGeneration('g')?.conversationId, root.id);
});
