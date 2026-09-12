import { Utils } from '@nativescript/core';
import type { Session, SessionRecordPatch, SessionState } from '../sessions/types';
import { MIGRATIONS, SCHEMA_VERSION } from './schema';
import { SqliteTelemetryRepository } from './sqlite-telemetry-repository';
import type { TelemetryRepository } from '../telemetry/types';
import type {
  ConversationRecord,
  GenerationPatch,
  GenerationRecord,
  GenerationStatus,
  GenerationUsage,
  MessagePatch,
  MessageRecord,
  PersistenceApi,
} from './types';

declare const android: any;

const DB_NAME = 'sam.db';

function context(): any {
  return Utils.android.getApplicationContext();
}

function parseUsage(raw: string | null): GenerationUsage | null {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as GenerationUsage;
  } catch {
    return null;
  }
}

function str(cursor: any, column: string): string {
  const index = cursor.getColumnIndex(column);
  return index >= 0 ? String(cursor.getString(index) ?? '') : '';
}

function nullable(cursor: any, column: string): string | null {
  const index = cursor.getColumnIndex(column);
  if (index < 0 || cursor.isNull(index)) {
    return null;
  }
  return String(cursor.getString(index));
}

function num(cursor: any, column: string): number {
  const index = cursor.getColumnIndex(column);
  return index >= 0 ? Number(cursor.getLong(index)) : 0;
}

function nullableNum(cursor: any, column: string): number | null {
  const index = cursor.getColumnIndex(column);
  if (index < 0 || cursor.isNull(index)) {
    return null;
  }
  return Number(cursor.getLong(index));
}

function readConversation(cursor: any): ConversationRecord {
  return {
    id: str(cursor, 'id'),
    title: nullable(cursor, 'title'),
    kind: str(cursor, 'kind'),
    state: str(cursor, 'state') as SessionState,
    ownerAgentId: nullable(cursor, 'owner_agent_id'),
    parentSessionId: nullable(cursor, 'parent_session_id'),
    archivedAt: nullableNum(cursor, 'archived_at'),
    createdAt: num(cursor, 'created_at'),
    updatedAt: num(cursor, 'updated_at'),
  };
}

function readMessage(cursor: any): MessageRecord {
  return {
    id: str(cursor, 'id'),
    conversationId: str(cursor, 'conversation_id'),
    role: str(cursor, 'role') as MessageRecord['role'],
    content: str(cursor, 'content'),
    status: str(cursor, 'status') as MessageRecord['status'],
    provider: nullable(cursor, 'provider'),
    model: nullable(cursor, 'model'),
    createdAt: num(cursor, 'created_at'),
    updatedAt: num(cursor, 'updated_at'),
    error: nullable(cursor, 'error'),
    payloadJson: nullable(cursor, 'payload_json'),
  };
}

function readGeneration(cursor: any): GenerationRecord {
  return {
    id: str(cursor, 'id'),
    conversationId: str(cursor, 'conversation_id'),
    messageId: str(cursor, 'message_id'),
    status: str(cursor, 'status') as GenerationRecord['status'],
    provider: str(cursor, 'provider'),
    model: str(cursor, 'model'),
    startedAt: num(cursor, 'started_at'),
    completedAt: nullableNum(cursor, 'completed_at'),
    error: nullable(cursor, 'error'),
    usage: parseUsage(nullable(cursor, 'usage_json')),
  };
}

function queryOne<T>(db: any, sql: string, args: string[], read: (cursor: any) => T): T | null {
  const cursor = db.rawQuery(sql, args);
  try {
    if (!cursor.moveToFirst()) {
      return null;
    }
    return read(cursor);
  } finally {
    cursor.close();
  }
}

function queryAll<T>(db: any, sql: string, args: string[], read: (cursor: any) => T): T[] {
  const cursor = db.rawQuery(sql, args);
  const rows: T[] = [];
  try {
    while (cursor.moveToNext()) {
      rows.push(read(cursor));
    }
  } finally {
    cursor.close();
  }
  return rows;
}

export class SqliteStore implements PersistenceApi {
  private db: any;
  readonly telemetry: TelemetryRepository = new SqliteTelemetryRepository(() => this.conn());

  private conn(): any {
    if (!this.db) {
      this.db = context().openOrCreateDatabase(DB_NAME, android.content.Context.MODE_PRIVATE, null);
      this.migrate(this.db);
      this.db.execSQL('PRAGMA foreign_keys = ON');
    }
    return this.db;
  }

  private migrate(db: any): void {
    // Table-rebuild migrations (v3+) require foreign key enforcement to be off.
    // The pragma cannot change inside a transaction, so it is toggled around the
    // whole migration run instead of per migration.
    db.execSQL('PRAGMA foreign_keys = OFF');
    try {
      db.execSQL(
        'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL)',
      );
      const current =
        queryOne(db, 'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations', [], (cursor) =>
          num(cursor, 'version'),
        ) ?? 0;
      for (const migration of MIGRATIONS) {
        if (migration.version <= current) {
          continue;
        }
        db.beginTransaction();
        try {
          for (const statement of migration.statements) {
            db.execSQL(statement);
          }
          db.execSQL('INSERT INTO schema_migrations (version) VALUES (?)', [migration.version]);
          db.setTransactionSuccessful();
        } finally {
          db.endTransaction();
        }
      }
    } finally {
      db.execSQL('PRAGMA foreign_keys = ON');
    }
  }

  ensureConversation(id: string, title?: string | null): ConversationRecord {
    const existing = this.getConversation(id);
    if (existing) {
      return existing;
    }
    const now = Date.now();
    this.conn().execSQL('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', [
      id,
      title ?? null,
      now,
      now,
    ]);
    return this.getSession(id)!;
  }

  getConversation(id: string): ConversationRecord | null {
    return queryOne(
      this.conn(),
      'SELECT * FROM conversations WHERE id = ?',
      [id],
      readConversation,
    );
  }

  updateConversationTitle(id: string, title: string, at: number): void {
    this.conn().execSQL('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?', [title, at, id]);
  }

  createSession(record: Session): Session {
    this.conn().execSQL(
      `INSERT INTO conversations (id, title, kind, state, owner_agent_id, parent_session_id,
        created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.title, record.kind, record.state, record.ownerAgentId,
        record.parentSessionId, record.createdAt, record.updatedAt, record.archivedAt],
    );
    return this.getSession(record.id)!;
  }

  getSession(id: string): Session | null { return this.getConversation(id); }

  listSessions(state?: SessionState): Session[] {
    return queryAll(this.conn(),
      `SELECT * FROM conversations${state === undefined ? '' : ' WHERE state = ?'} ORDER BY updated_at DESC, id ASC`,
      state === undefined ? [] : [state], readConversation);
  }

  updateSession(id: string, patch: SessionRecordPatch): Session {
    const record = this.getSession(id);
    if (!record) throw new Error(`Session not found: ${id}`);
    this.conn().execSQL(
      'UPDATE conversations SET title = ?, kind = ?, owner_agent_id = ?, updated_at = ? WHERE id = ?',
      [patch.title === undefined ? record.title : patch.title, patch.kind ?? record.kind,
        patch.ownerAgentId === undefined ? record.ownerAgentId : patch.ownerAgentId,
        patch.updatedAt ?? record.updatedAt, id],
    );
    return this.getSession(id)!;
  }

  listSessionChildren(id: string): Session[] {
    return queryAll(this.conn(),
      'SELECT * FROM conversations WHERE parent_session_id = ? ORDER BY updated_at DESC, id ASC',
      [id], readConversation);
  }

  archiveSessions(ids: string[], at: number): void {
    if (!ids.length) return;
    const db = this.conn();
    db.beginTransaction();
    try {
      for (const id of ids) {
        if (!this.getSession(id)) throw new Error(`Session not found: ${id}`);
        db.execSQL(
          "UPDATE conversations SET state = 'archived', archived_at = ?, updated_at = ? WHERE id = ? AND state = 'active'",
          [at, at, id],
        );
      }
      db.setTransactionSuccessful();
    } finally {
      db.endTransaction();
    }
  }

  restoreSession(id: string, at: number): Session {
    if (!this.getSession(id)) throw new Error(`Session not found: ${id}`);
    this.conn().execSQL(
      "UPDATE conversations SET state = 'active', archived_at = NULL, updated_at = ? WHERE id = ? AND state = 'archived'",
      [at, id],
    );
    return this.getSession(id)!;
  }

  touchConversation(id: string, at: number): void {
    this.conn().execSQL('UPDATE conversations SET updated_at = ? WHERE id = ?', [at, id]);
  }

  insertMessage(message: MessageRecord): void {
    this.conn().execSQL(
      `INSERT INTO messages (
        id, conversation_id, role, content, status, provider, model, created_at, updated_at, error, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.id,
        message.conversationId,
        message.role,
        message.content,
        message.status,
        message.provider,
        message.model,
        message.createdAt,
        message.updatedAt,
        message.error,
        message.payloadJson,
      ],
    );
  }

  updateMessage(id: string, patch: MessagePatch): void {
    const record = this.getMessage(id);
    if (!record) {
      return;
    }
    const next = { ...record, ...patch };
    this.conn().execSQL(
      `UPDATE messages SET content = ?, status = ?, error = ?, payload_json = ?, updated_at = ? WHERE id = ?`,
      [next.content, next.status, next.error, next.payloadJson, next.updatedAt, id],
    );
  }

  getMessage(id: string): MessageRecord | null {
    return queryOne(this.conn(), 'SELECT * FROM messages WHERE id = ?', [id], readMessage);
  }

  listMessages(conversationId: string): MessageRecord[] {
    return queryAll(
      this.conn(),
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC',
      [conversationId],
      readMessage,
    );
  }

  insertGeneration(generation: GenerationRecord): void {
    this.conn().execSQL(
      `INSERT INTO generations (
        id, conversation_id, message_id, status, provider, model, started_at, completed_at, error, usage_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generation.id,
        generation.conversationId,
        generation.messageId,
        generation.status,
        generation.provider,
        generation.model,
        generation.startedAt,
        generation.completedAt,
        generation.error,
        generation.usage ? JSON.stringify(generation.usage) : null,
      ],
    );
  }

  updateGeneration(id: string, patch: GenerationPatch): void {
    const record = this.getGeneration(id);
    if (!record) {
      return;
    }
    const next = { ...record, ...patch };
    this.conn().execSQL(
      `UPDATE generations SET status = ?, completed_at = ?, error = ?, usage_json = ? WHERE id = ?`,
      [
        next.status,
        next.completedAt,
        next.error,
        next.usage ? JSON.stringify(next.usage) : null,
        id,
      ],
    );
  }

  getGeneration(id: string): GenerationRecord | null {
    return queryOne(this.conn(), 'SELECT * FROM generations WHERE id = ?', [id], readGeneration);
  }

  listGenerationsByStatus(statuses: GenerationStatus[]): GenerationRecord[] {
    if (!statuses.length) {
      return [];
    }
    const placeholders = statuses.map(() => '?').join(', ');
    return queryAll(
      this.conn(),
      `SELECT * FROM generations WHERE status IN (${placeholders})`,
      statuses,
      readGeneration,
    );
  }
}
