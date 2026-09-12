import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.ts';

test('telemetry schema is a forward migration chain with normalized hierarchy and indexes', () => {
  assert.equal(SCHEMA_VERSION, 6);
  assert.deepEqual(
    MIGRATIONS.map((migration) => migration.version),
    [1, 2, 3, 4, 5, 6],
  );
  const v2 = MIGRATIONS[1].statements.join('\n');
  for (const table of [
    'agents',
    'turns',
    'agent_runs',
    'provider_accounts',
    'subscription_plans',
    'model_pricing',
    'model_calls',
    'model_call_attempts',
    'model_call_usage',
    'model_call_attempt_usage',
    'cost_allocations',
  ]) {
    assert.match(v2, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(v2, /FOREIGN KEY\(parent_agent_run_id\)/);
  assert.match(v2, /reported_cache_write_tokens INTEGER/);
  assert.match(v2, /api_equivalent_cost_micros INTEGER/);
  assert.match(v2, /CREATE INDEX IF NOT EXISTS idx_model_calls_provider_requested/);
});

test('v3 makes turn_id nullable and drops attempt-level fallback columns', () => {
  const v3 = MIGRATIONS[2].statements.join('\n');
  // turn_id is nullable in the rebuilt tables (optional turn context).
  assert.match(v3, /CREATE TABLE agent_runs_v3 \([\s\S]*?turn_id TEXT,/);
  assert.doesNotMatch(v3, /CREATE TABLE agent_runs_v3 \([\s\S]*?turn_id TEXT NOT NULL/);
  assert.match(v3, /CREATE TABLE model_calls_v3 \([\s\S]*?turn_id TEXT,/);
  assert.doesNotMatch(v3, /CREATE TABLE model_calls_v3 \([\s\S]*?turn_id TEXT NOT NULL/);
  // Fallback between providers/models is call-level lineage, not an attempt field.
  assert.doesNotMatch(v3, /CREATE TABLE model_call_attempts_v3 \([\s\S]*?fallback_from_attempt_id/);
  assert.doesNotMatch(v3, /CREATE TABLE model_call_attempts_v3 \([\s\S]*?fallback_reason/);
  // Indexes dropped with the rebuilt tables are recreated, plus new ones.
  for (const index of [
    'idx_agent_runs_turn_parent',
    'idx_model_calls_turn_run',
    'idx_model_calls_status_requested',
    'idx_turns_status',
    'idx_agent_runs_status',
    'idx_agent_runs_parent',
    'idx_model_calls_agent_run',
    'idx_model_calls_fallback_from',
    'idx_model_calls_pricing_snapshot',
  ]) {
    assert.match(v3, new RegExp(`CREATE INDEX IF NOT EXISTS ${index}`));
  }
});

test('table rebuilds reference final names so Android rename cannot leave dangling FKs', () => {
  const v3 = MIGRATIONS[2].statements.join('\n');
  assert.match(v3, /FOREIGN KEY\(parent_agent_run_id\) REFERENCES agent_runs\(agent_run_id\)/);
  assert.match(v3, /FOREIGN KEY\(spawned_by_run_id\) REFERENCES agent_runs\(agent_run_id\)/);
  assert.match(v3, /FOREIGN KEY\(parent_call_id\) REFERENCES model_calls\(call_id\)/);
  assert.match(v3, /FOREIGN KEY\(fallback_from_call_id\) REFERENCES model_calls\(call_id\)/);
  assert.doesNotMatch(v3, /REFERENCES agent_runs_v3/);
  assert.doesNotMatch(v3, /REFERENCES model_calls_v3/);
  const v4 = MIGRATIONS[3].statements.join('\n');
  assert.match(v4, /CREATE TABLE agent_runs_v4/);
  assert.match(v4, /CREATE TABLE model_calls_v4/);
  assert.match(v4, /FOREIGN KEY\(parent_agent_run_id\) REFERENCES agent_runs\(agent_run_id\)/);
  assert.match(v4, /FOREIGN KEY\(spawned_by_run_id\) REFERENCES agent_runs\(agent_run_id\)/);
  assert.match(v4, /FOREIGN KEY\(parent_call_id\) REFERENCES model_calls\(call_id\)/);
  assert.match(v4, /FOREIGN KEY\(fallback_from_call_id\) REFERENCES model_calls\(call_id\)/);
  assert.doesNotMatch(v4, /REFERENCES agent_runs_v4/);
  assert.doesNotMatch(v4, /REFERENCES model_calls_v4/);
});

test('no telemetry table stores credentials', () => {
  const sql = MIGRATIONS.flatMap((migration) => migration.statements).join('\n').toLowerCase();
  for (const forbidden of ['oauth_token', 'refresh_token', 'api_key', 'password', 'access_token']) {
    assert.ok(!sql.includes(forbidden), `schema must not contain ${forbidden}`);
  }
});

test('v5 evolves conversations additively with normalized, non-destructive session ancestry', () => {
  const v5 = MIGRATIONS[4].statements.join('\n');
  assert.match(v5, /ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'/);
  assert.match(v5, /ADD COLUMN state TEXT NOT NULL DEFAULT 'active'/);
  assert.match(v5, /CHECK \(state IN \('active', 'archived'\)\)/);
  assert.match(v5, /ADD COLUMN owner_agent_id TEXT/);
  assert.match(v5, /ADD COLUMN parent_session_id TEXT\s+REFERENCES conversations\(id\) ON DELETE RESTRICT/);
  assert.match(v5, /ADD COLUMN archived_at INTEGER/);
  assert.doesNotMatch(v5, /DROP|DELETE FROM|CREATE TABLE|CASCADE|REFERENCES agents|metadata/i);
});
