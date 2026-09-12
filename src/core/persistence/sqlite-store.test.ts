import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mock, test } from 'node:test';
import { MemoryStore } from './memory-store.ts';
import { SCHEMA_VERSION } from './schema.ts';
import { SessionEngine } from '../sessions/session-engine.ts';
import type { SessionRepository } from '../sessions/types.ts';

// Exercise the actual Android adapter SQL/migration runner against ephemeral SQLite.
let connection: ReturnType<typeof androidDatabase>;
mock.module('@nativescript/core', { namedExports: { Utils: { android: {
  getApplicationContext: () => ({ openOrCreateDatabase: () => connection }),
} } } });
(globalThis as any).android = { content: { Context: { MODE_PRIVATE: 0 } } };
const { SqliteStore } = await import('./sqlite-store.ts');

function androidDatabase(db: DatabaseSync) {
  let successful = false;
  return {
    execSQL(sql: string, args?: SQLInputValue[]) {
      if (args) db.prepare(sql).run(...args);
      else db.exec(sql);
    },
    rawQuery(sql: string, args: SQLInputValue[]) {
      const statement = db.prepare(sql);
      const columns = statement.columns().map((column) => column.name);
      const rows = statement.all(...args);
      let index = -1;
      return {
        moveToFirst: () => { index = 0; return rows.length > 0; },
        moveToNext: () => ++index < rows.length,
        getColumnIndex: (column: string) => columns.indexOf(column),
        getString: (column: number) => rows[index][columns[column]],
        getLong: (column: number) => rows[index][columns[column]],
        isNull: (column: number) => rows[index][columns[column]] === null,
        close() {},
      };
    },
    beginTransaction() { db.exec('BEGIN'); successful = false; },
    setTransactionSuccessful() { successful = true; },
    endTransaction() { db.exec(successful ? 'COMMIT' : 'ROLLBACK'); },
  };
}

for (const adapter of ['memory', 'sqlite']) {
  test(`${adapter} implements the session repository contract with atomic archive and preserved history`, () => {
    const db = new DatabaseSync(':memory:');
    connection = androidDatabase(db);
    const store = adapter === 'memory' ? new MemoryStore() : new SqliteStore();
    const repository: SessionRepository = store;
    let id = 0;
    let at = 10;
    const engine = new SessionEngine(repository, { id: () => `s${++id}`, clock: () => at++ });
    try {
      assert.deepEqual(repository.listSessions(), []);
      const root = engine.create({ title: 'Saved', ownerAgentId: 'opaque-owner' });
      const child = engine.create({ parentSessionId: root.id, kind: 'worker' });
      assert.deepEqual(store.getConversation(root.id), root);
      assert.deepEqual(store.ensureConversation(root.id, 'ignored'), root);
      assert.deepEqual(repository.listSessionChildren(root.id), [child]);
      assert.equal(repository.getSession('missing'), null);
      assert.throws(() => repository.createSession(root));
      assert.throws(() => repository.createSession({ ...root, id: 'bad', parentSessionId: 'missing' }));
      const patched = repository.updateSession(root.id, { title: null, ownerAgentId: null, kind: 'custom', updatedAt: 20 });
      assert.deepEqual(patched, { ...root, title: null, ownerAgentId: null, kind: 'custom', updatedAt: 20 });
      assert.deepEqual(repository.listSessions().map((session) => session.id), [root.id, child.id]);
      assert.throws(() => repository.updateSession('missing', {}), /not found/);
      store.insertMessage({ id: 'm', conversationId: child.id, role: 'assistant', content: 'Saved content',
        status: 'completed', provider: 'p', model: 'model', createdAt: 1, updatedAt: 2, error: null, payloadJson: '{"saved":true}' });
      store.insertGeneration({ id: 'g', conversationId: child.id, messageId: 'm', status: 'completed',
        provider: 'p', model: 'model', startedAt: 1, completedAt: 2, error: null, usage: { outputTokens: 7 } });
      const message = store.getMessage('m');
      const generation = store.getGeneration('g');
      repository.archiveSessions([], 30);
      assert.throws(() => repository.archiveSessions([root.id, child.id, 'missing'], 30), /not found/);
      assert.deepEqual(repository.getSession(root.id), patched);
      assert.deepEqual(repository.getSession(child.id), child);
      repository.archiveSessions([root.id, child.id], 40);
      assert.deepEqual(repository.listSessions('active'), []);
      assert.equal(repository.listSessions('archived').length, 2);
      repository.archiveSessions([root.id], 41);
      assert.equal(repository.getSession(root.id)?.archivedAt, 40);
      assert.equal(store.ensureConversation(root.id).state, 'archived');
      const restored = repository.restoreSession(root.id, 50);
      assert.deepEqual(restored, { ...patched, updatedAt: 50 });
      assert.equal(repository.getSession(child.id)?.state, 'archived');
      assert.deepEqual(repository.restoreSession(root.id, 51), restored);
      assert.throws(() => repository.restoreSession('missing', 50), /not found/);
      assert.deepEqual(store.listMessages(child.id), [message]);
      assert.deepEqual(store.getGeneration('g'), generation);
      if (adapter === 'sqlite') {
        assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()!.version, SCHEMA_VERSION);
        assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      }
    } finally {
      db.close();
    }
  });
}
