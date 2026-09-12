import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStore } from './memory-store.ts';

test('ensureConversation is idempotent and listMessages is ordered', () => {
  const store = new MemoryStore();
  store.ensureConversation('c1', 'SAM');
  store.ensureConversation('c1', 'ignored');
  assert.equal(store.getConversation('c1')?.title, 'SAM');
  store.insertMessage({
    id: 'm2',
    conversationId: 'c1',
    role: 'assistant',
    content: 'b',
    status: 'completed',
    provider: 'xai',
    model: 'grok',
    createdAt: 2,
    updatedAt: 2,
    error: null,
    payloadJson: null,
  });
  store.insertMessage({
    id: 'm1',
    conversationId: 'c1',
    role: 'user',
    content: 'a',
    status: 'completed',
    provider: null,
    model: null,
    createdAt: 1,
    updatedAt: 1,
    error: null,
    payloadJson: null,
  });
  assert.deepEqual(
    store.listMessages('c1').map((message) => message.id),
    ['m1', 'm2'],
  );
});

test('incremental message updates keep partial content', () => {
  const store = new MemoryStore();
  store.ensureConversation('c1');
  store.insertMessage({
    id: 'a1',
    conversationId: 'c1',
    role: 'assistant',
    content: '',
    status: 'streaming',
    provider: 'xai',
    model: 'grok',
    createdAt: 1,
    updatedAt: 1,
    error: null,
    payloadJson: null,
  });
  store.updateMessage('a1', { content: 'Hel', updatedAt: 2 });
  store.updateMessage('a1', { content: 'Hello', status: 'interrupted', error: 'cut', updatedAt: 3 });
  const message = store.getMessage('a1');
  assert.equal(message?.content, 'Hello');
  assert.equal(message?.status, 'interrupted');
  assert.equal(message?.error, 'cut');
});

test('listGenerationsByStatus finds in-flight work', () => {
  const store = new MemoryStore();
  store.insertGeneration({
    id: 'g1',
    conversationId: 'c1',
    messageId: 'a1',
    status: 'streaming',
    provider: 'xai',
    model: 'grok',
    startedAt: 1,
    completedAt: null,
    error: null,
    usage: null,
  });
  store.insertGeneration({
    id: 'g2',
    conversationId: 'c1',
    messageId: 'a2',
    status: 'completed',
    provider: 'xai',
    model: 'grok',
    startedAt: 1,
    completedAt: 2,
    error: null,
    usage: { outputTokens: 4 },
  });
  assert.deepEqual(
    store.listGenerationsByStatus(['connecting', 'streaming']).map((item) => item.id),
    ['g1'],
  );
});

test('session repository shares historical conversation identity and archives atomically', () => {
  const store = new MemoryStore();
  const root = store.ensureConversation('root', 'Original');
  assert.deepEqual(store.getSession('root'), root);
  assert.equal(root.kind, 'chat');
  assert.equal(root.state, 'active');
  const child = { ...root, id: 'child', parentSessionId: root.id, ownerAgentId: 'opaque' };
  store.createSession(child);
  child.title = 'external mutation';
  assert.equal(store.getConversation('child')?.title, 'Original');
  assert.throws(() => store.createSession(child), /already exists/);
  assert.throws(() => store.createSession({ ...child, id: 'bad', parentSessionId: 'missing' }), /not found/);
  assert.throws(() => store.archiveSessions(['root', 'missing'], 10), /not found/);
  assert.equal(store.getSession('root')?.state, 'active');
  store.archiveSessions(['root', 'child'], 20);
  assert.deepEqual(store.listSessions('active'), []);
  assert.equal(store.listSessions('archived').length, 2);
  assert.equal(store.ensureConversation('root', 'ignored').archivedAt, 20);
  store.restoreSession('root', 30);
  assert.equal(store.getSession('root')?.archivedAt, null);
  assert.equal(store.getSession('root')?.createdAt, root.createdAt);
  assert.equal(store.getSession('child')?.state, 'archived');
  store.updateSession('child', { title: null, kind: 'worker', ownerAgentId: null, updatedAt: 40 });
  assert.equal(store.getSession('child')?.parentSessionId, 'root');
  assert.equal(store.getSession('child')?.ownerAgentId, null);
  assert.equal(store.getSession('child')?.updatedAt, 40);
  assert.equal(store.listSessionChildren('root').length, 1);
  assert.throws(() => store.restoreSession('missing', 50), /not found/);
});
