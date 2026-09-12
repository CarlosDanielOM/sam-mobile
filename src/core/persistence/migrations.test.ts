import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.ts';

/**
 * Executes pending migrations the same way SqliteStore.migrate() does:
 * foreign key enforcement is toggled outside the per-migration transactions
 * (SQLite cannot change it mid-transaction, and table rebuilds need it off).
 */
function migrate(db: DatabaseSync, upToVersion = SCHEMA_VERSION): void {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL)');
    const current =
      (db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as {
        version: number;
      }).version ?? 0;
    for (const migration of MIGRATIONS) {
      if (migration.version <= current || migration.version > upToVersion) {
        continue;
      }
      db.exec('BEGIN');
      try {
        for (const statement of migration.statements) {
          db.exec(statement);
        }
        db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function notNull(db: DatabaseSync, table: string, column: string): boolean {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number }[];
  const match = info.find((entry) => entry.name === column);
  assert.ok(match, `${table}.${column} must exist`);
  return match.notnull === 1;
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

test('fresh install applies all migrations to the latest schema', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const version = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
    version: number;
  };
  assert.equal(version.version, SCHEMA_VERSION);
  assert.equal(notNull(db, 'agent_runs', 'turn_id'), false);
  assert.equal(notNull(db, 'model_calls', 'turn_id'), false);
  assert.equal(notNull(db, 'agent_runs', 'session_id'), true);
  assert.ok(!columns(db, 'model_call_attempts').includes('fallback_from_attempt_id'));
  assert.ok(!columns(db, 'model_call_attempts').includes('fallback_reason'));
  const indexes = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as { name: string }[]
  ).map((row) => row.name);
  for (const index of [
    'idx_model_calls_turn_run',
    'idx_model_calls_fallback_from',
    'idx_agent_runs_parent',
    'idx_turns_status',
  ]) {
    assert.ok(indexes.includes(index), `missing index ${index}`);
  }
  // Foreign key enforcement is active after migrations.
  assert.equal(
    (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys,
    1,
  );
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO model_calls (
          call_id, session_id, turn_id, agent_id, agent_run_id, owns_turn, owns_agent_run,
          provider_account_id, provider, model, requested_at, status
        ) VALUES ('c1', 'session', NULL, 'ghost', 'ghost_run', 0, 0, 'ghost_account', 'p', 'm', 1, 'running')`,
      ).run(),
  );
});

test('upgrade from v2 preserves data through the table rebuilds', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, 2);
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('s', NULL, 1, 1)`).run();
  db.prepare(
    `INSERT INTO agents (agent_id, name, kind, persistent, owner_agent_id, default_model_policy_id,
      metadata_json, created_at, deleted_at)
     VALUES ('sam', 'SAM', 'orchestrator', 1, NULL, NULL, NULL, 1, NULL)`,
  ).run();
  db.prepare(
    `INSERT INTO turns (turn_id, session_id, user_message_id, status, started_at, completed_at, metadata_json)
     VALUES ('t', 's', NULL, 'completed', 1, 2, NULL)`,
  ).run();
  db.prepare(
    `INSERT INTO provider_accounts (provider_account_id, provider, display_label, billing_mode,
      plan_reference, active, metadata_json, created_at, updated_at)
     VALUES ('acct', 'p', 'P', 'api', NULL, 1, NULL, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO agent_runs (agent_run_id, agent_id, parent_agent_run_id, spawned_by_agent_id,
      spawned_by_run_id, session_id, turn_id, purpose, spawn_reason, status, started_at,
      completed_at, agent_name_snapshot, agent_kind_snapshot, metadata_json)
     VALUES ('r', 'sam', NULL, NULL, NULL, 's', 't', 'p', 'user_turn', 'completed', 1, 2, 'SAM', 'orchestrator', NULL)`,
  ).run();
  db.prepare(
    `INSERT INTO model_calls (call_id, session_id, turn_id, message_id, generation_id, agent_id,
      agent_run_id, owns_turn, owns_agent_run, parent_call_id, provider_account_id, provider, model,
      provider_request_id, route_reason, route_policy_id, fallback_from_call_id, requested_at,
      first_token_at, last_token_at, completed_at, ttft_ms, generation_duration_ms, total_latency_ms,
      output_tokens_per_second_milli, status, finish_reason, error_type, error_code, failure_stage,
      cancelled_at, model_context_limit, context_tokens, context_utilization_bps,
      requested_max_output_tokens, pricing_snapshot_id, metered_cost_micros, metered_currency,
      metered_cost_source, api_equivalent_cost_micros, api_equivalent_currency,
      api_equivalent_cost_source, raw_metadata_json)
     VALUES ('c', 's', 't', NULL, NULL, 'sam', 'r', 1, 1, NULL, 'acct', 'p', 'm', 'req', NULL, NULL,
      NULL, 1, NULL, NULL, 2, NULL, NULL, NULL, NULL, 'completed', 'stop', NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, 500, 'USD', 'provider_reported', 740, 'USD',
      'attempt_aggregate', NULL)`,
  ).run();
  db.prepare(
    `INSERT INTO model_call_attempts (attempt_id, call_id, attempt_number, provider_account_id,
      provider, model, started_at, response_received_at, first_token_at, last_token_at,
      completed_at, latency_ms, provider_request_id, http_status, status, error_type, error_code,
      failure_stage, fallback_from_attempt_id, fallback_reason, pricing_snapshot_id,
      metered_cost_micros, metered_currency, metered_cost_source, api_equivalent_cost_micros,
      api_equivalent_currency, api_equivalent_cost_source, raw_metadata_json)
     VALUES ('a', 'c', 1, 'acct', 'p', 'm', 1, NULL, NULL, NULL, 2, 1, 'req', 200, 'completed',
      NULL, NULL, NULL, NULL, NULL, NULL, 500, 'USD', 'provider_reported', 740, 'USD',
      'attempt_aggregate', NULL)`,
  ).run();

  migrate(db);
  const version = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
    version: number;
  };
  assert.equal(version.version, SCHEMA_VERSION);
  const call = db.prepare('SELECT * FROM model_calls WHERE call_id = ?').get('c') as Record<
    string,
    unknown
  >;
  assert.equal(call.turn_id, 't');
  assert.equal(call.api_equivalent_cost_micros, 740);
  assert.equal(call.metered_cost_micros, 500);
  const attempt = db
    .prepare('SELECT * FROM model_call_attempts WHERE attempt_id = ?')
    .get('a') as Record<string, unknown>;
  assert.equal(attempt.status, 'completed');
  assert.equal(attempt.metered_cost_micros, 500);
  assert.ok(!('fallback_from_attempt_id' in attempt));
  assert.equal(notNull(db, 'model_calls', 'turn_id'), false);
  // Re-running is a no-op.
  migrate(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_calls').get()!.n, 1);
});

test('agent_runs insert succeeds after rebuilds and FKs target agent_runs', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('s', NULL, 1, 1)`).run();
  db.prepare(
    `INSERT INTO agents (agent_id, name, kind, persistent, owner_agent_id, default_model_policy_id,
      metadata_json, created_at, deleted_at)
     VALUES ('sam', 'SAM', 'orchestrator', 1, NULL, NULL, NULL, 1, NULL)`,
  ).run();
  db.prepare(
    `INSERT INTO agent_runs (agent_run_id, agent_id, parent_agent_run_id, spawned_by_agent_id,
      spawned_by_run_id, session_id, turn_id, purpose, spawn_reason, status, started_at,
      completed_at, agent_name_snapshot, agent_kind_snapshot, metadata_json)
     VALUES ('r', 'sam', NULL, NULL, NULL, 's', NULL, 'p', 'user_turn', 'running', 1, NULL, 'SAM', 'orchestrator', NULL)`,
  ).run();
  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'agent_runs'`).get() as { sql: string };
  assert.doesNotMatch(sql.sql, /agent_runs_v3/);
  assert.doesNotMatch(sql.sql, /agent_runs_v4/);
  const fks = db.prepare('PRAGMA foreign_key_list(agent_runs)').all() as { table: string }[];
  assert.ok(fks.some((fk) => fk.table === 'agent_runs'));
  assert.ok(!fks.some((fk) => fk.table === 'agent_runs_v3' || fk.table === 'agent_runs_v4'));
});

test('v4 to v5 preserves conversation identity and every linked history/telemetry row and FK', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db, 4);
    db.exec(`
      INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('s', 'Saved title', 123, 456);
      INSERT INTO messages (id, conversation_id, role, content, status, created_at, updated_at, payload_json)
        VALUES ('m', 's', 'assistant', 'Saved answer', 'completed', 124, 455, '{"saved":true}');
      INSERT INTO generations (id, conversation_id, message_id, status, provider, model, started_at, completed_at, usage_json)
        VALUES ('g', 's', 'm', 'completed', 'p', 'model', 124, 455, '{"outputTokens":7}');
      INSERT INTO agents (agent_id, name, kind, persistent, created_at) VALUES ('a', 'Agent', 'worker', 1, 123);
      INSERT INTO turns (turn_id, session_id, user_message_id, status, started_at) VALUES ('t', 's', 'm', 'completed', 123);
      INSERT INTO agent_runs (agent_run_id, agent_id, session_id, turn_id, status, started_at, agent_name_snapshot, agent_kind_snapshot)
        VALUES ('r', 'a', 's', 't', 'completed', 123, 'Agent', 'worker');
      INSERT INTO provider_accounts (provider_account_id, provider, display_label, billing_mode, active, created_at, updated_at)
        VALUES ('p', 'provider', 'Provider', 'api', 1, 123, 456);
      INSERT INTO subscription_plans (subscription_plan_id, provider_account_id, name, billing_mode, currency, price_micros, period_start, period_end, created_at)
        VALUES ('plan', 'p', 'Plan', 'subscription', 'USD', 1000, 1, 999, 123);
      INSERT INTO model_pricing (pricing_snapshot_id, provider, model, currency, effective_from, source, created_at)
        VALUES ('price', 'provider', 'model', 'USD', 1, 'test', 123);
      INSERT INTO model_calls (call_id, session_id, turn_id, message_id, generation_id, agent_id, agent_run_id,
        owns_turn, owns_agent_run, provider_account_id, provider, model, requested_at, status, pricing_snapshot_id, metered_cost_micros)
        VALUES ('call', 's', 't', 'm', 'g', 'a', 'r', 1, 1, 'p', 'provider', 'model', 123, 'completed', 'price', 700);
      INSERT INTO model_call_attempts (attempt_id, call_id, attempt_number, provider_account_id, provider, model, started_at, status)
        VALUES ('attempt', 'call', 1, 'p', 'provider', 'model', 123, 'completed');
      INSERT INTO model_call_usage (call_id, usage_source, reported_output_tokens) VALUES ('call', 'provider', 7);
      INSERT INTO model_call_attempt_usage (attempt_id, usage_source, reported_output_tokens) VALUES ('attempt', 'provider', 7);
      INSERT INTO cost_allocations (allocation_id, call_id, subscription_plan_id, period_start, period_end, amount_micros, currency, method, created_at)
        VALUES ('cost', 'call', 'plan', 1, 999, 700, 'USD', 'test', 456);
    `);
    const tables = ['messages', 'generations', 'agents', 'turns', 'agent_runs', 'provider_accounts',
      'subscription_plans', 'model_pricing', 'model_calls', 'model_call_attempts', 'model_call_usage',
      'model_call_attempt_usage', 'cost_allocations'];
    const before = tables.map((table) => ({
      table, rows: db.prepare(`SELECT * FROM ${table}`).all(),
      fks: db.prepare(`PRAGMA foreign_key_list(${table})`).all(),
    }));
    migrate(db);
    assert.deepEqual({ ...db.prepare('SELECT * FROM conversations WHERE id = ?').get('s') }, {
      id: 's', title: 'Saved title', created_at: 123, updated_at: 456, kind: 'chat', state: 'active',
      owner_agent_id: null, parent_session_id: null, archived_at: null,
    });
    for (const { table, rows, fks } of before) {
      assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), rows, table);
      assert.deepEqual(db.prepare(`PRAGMA foreign_key_list(${table})`).all(), fks, `${table} FKs`);
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.exec("UPDATE conversations SET state = 'archived', archived_at = 500 WHERE id = 's'");
    migrate(db);
    assert.equal(db.prepare("SELECT state FROM conversations WHERE id = 's'").get()!.state, 'archived');
    assert.equal(db.prepare("SELECT archived_at FROM conversations WHERE id = 's'").get()!.archived_at, 500);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

for (const fromVersion of [0, 4]) {
  test(`v5 from v${fromVersion} enforces parent FK without cascade or owner FK and preserves legacy inserts`, () => {
    const db = new DatabaseSync(':memory:');
    try {
      if (fromVersion) migrate(db, fromVersion);
      migrate(db);
      db.exec("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('parent', NULL, 1, 2)");
      db.exec(`INSERT INTO conversations (id, title, kind, owner_agent_id, parent_session_id, created_at, updated_at)
        VALUES ('child', 'Child', 'any-kind', 'opaque-unregistered-owner', 'parent', 3, 4)`);
      assert.throws(() => db.exec("DELETE FROM conversations WHERE id = 'parent'"), /FOREIGN KEY/);
      assert.throws(() => db.exec("UPDATE conversations SET parent_session_id = 'ghost' WHERE id = 'child'"), /FOREIGN KEY/);
      assert.throws(() => db.exec("UPDATE conversations SET state = 'deleted' WHERE id = 'child'"), /CHECK/);
      const fks = db.prepare('PRAGMA foreign_key_list(conversations)').all();
      assert.equal(fks.length, 1);
      assert.equal(fks[0].from, 'parent_session_id');
      assert.equal(fks[0].table, 'conversations');
      assert.equal(fks[0].to, 'id');
      assert.equal(fks[0].on_delete, 'RESTRICT');
      assert.equal(db.prepare("SELECT state FROM conversations WHERE id = 'parent'").get()!.state, 'active');
      assert.equal(db.prepare("SELECT kind FROM conversations WHERE id = 'parent'").get()!.kind, 'chat');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      db.close();
    }
  });
}
