export const SCHEMA_VERSION = 5;

const USAGE_COLUMNS = `
  reported_input_tokens INTEGER,
  reported_uncached_input_tokens INTEGER,
  reported_cache_read_tokens INTEGER,
  reported_cache_write_tokens INTEGER,
  reported_output_tokens INTEGER,
  reported_reasoning_tokens INTEGER,
  reported_total_tokens INTEGER,
  estimated_input_tokens INTEGER,
  estimated_uncached_input_tokens INTEGER,
  estimated_cache_read_tokens INTEGER,
  estimated_cache_write_tokens INTEGER,
  estimated_output_tokens INTEGER,
  estimated_reasoning_tokens INTEGER,
  estimated_total_tokens INTEGER,
  usage_source TEXT NOT NULL,
  provenance_json TEXT,
  provider_usage_json TEXT,
  context_components_json TEXT,
  modality_usage_json TEXT`;

export const MIGRATIONS: { version: number; statements: string[] }[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        error TEXT,
        payload_json TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS generations (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        status TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        error TEXT,
        usage_json TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_messages_conversation
        ON messages(conversation_id, created_at, id)`,
      `CREATE INDEX IF NOT EXISTS idx_generations_status
        ON generations(status)`,
    ],
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        persistent INTEGER NOT NULL,
        owner_agent_id TEXT,
        default_model_policy_id TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        deleted_at INTEGER,
        FOREIGN KEY(owner_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE IF NOT EXISTS turns (
        turn_id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        user_message_id TEXT,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        metadata_json TEXT,
        FOREIGN KEY(session_id) REFERENCES conversations(id) ON DELETE RESTRICT,
        FOREIGN KEY(user_message_id) REFERENCES messages(id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE IF NOT EXISTS agent_runs (
        agent_run_id TEXT PRIMARY KEY NOT NULL,
        agent_id TEXT NOT NULL,
        parent_agent_run_id TEXT,
        spawned_by_agent_id TEXT,
        spawned_by_run_id TEXT,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        purpose TEXT,
        spawn_reason TEXT,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        agent_name_snapshot TEXT NOT NULL,
        agent_kind_snapshot TEXT NOT NULL,
        metadata_json TEXT,
        FOREIGN KEY(agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        FOREIGN KEY(parent_agent_run_id) REFERENCES agent_runs(agent_run_id) ON DELETE RESTRICT,
        FOREIGN KEY(spawned_by_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        FOREIGN KEY(spawned_by_run_id) REFERENCES agent_runs(agent_run_id) ON DELETE RESTRICT,
        FOREIGN KEY(session_id) REFERENCES conversations(id) ON DELETE RESTRICT,
        FOREIGN KEY(turn_id) REFERENCES turns(turn_id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE IF NOT EXISTS provider_accounts (
        provider_account_id TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL,
        display_label TEXT NOT NULL,
        billing_mode TEXT NOT NULL,
        plan_reference TEXT,
        active INTEGER NOT NULL,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS subscription_plans (
        subscription_plan_id TEXT PRIMARY KEY NOT NULL,
        provider_account_id TEXT NOT NULL,
        name TEXT NOT NULL,
        billing_mode TEXT NOT NULL,
        currency TEXT NOT NULL,
        price_micros INTEGER NOT NULL,
        period_start INTEGER NOT NULL,
        period_end INTEGER NOT NULL,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(provider_account_id) REFERENCES provider_accounts(provider_account_id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE IF NOT EXISTS model_pricing (
        pricing_snapshot_id TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL,
        provider_account_id TEXT,
        model TEXT NOT NULL,
        input_per_million_micros INTEGER,
        cache_read_per_million_micros INTEGER,
        cache_write_per_million_micros INTEGER,
        output_per_million_micros INTEGER,
        reasoning_per_million_micros INTEGER,
        modality_rates_json TEXT,
        currency TEXT NOT NULL,
        effective_from INTEGER NOT NULL,
        effective_to INTEGER,
        source TEXT NOT NULL,
        notes TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(provider_account_id) REFERENCES provider_accounts(provider_account_id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE IF NOT EXISTS model_calls (
        call_id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        message_id TEXT,
        generation_id TEXT,
        agent_id TEXT NOT NULL,
        agent_run_id TEXT NOT NULL,
        owns_turn INTEGER NOT NULL,
        owns_agent_run INTEGER NOT NULL,
        parent_call_id TEXT,
        provider_account_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_request_id TEXT,
        route_reason TEXT,
        route_policy_id TEXT,
        fallback_from_call_id TEXT,
        requested_at INTEGER NOT NULL,
        first_token_at INTEGER,
        last_token_at INTEGER,
        completed_at INTEGER,
        ttft_ms INTEGER,
        generation_duration_ms INTEGER,
        total_latency_ms INTEGER,
        output_tokens_per_second_milli INTEGER,
        status TEXT NOT NULL,
        finish_reason TEXT,
        error_type TEXT,
        error_code TEXT,
        failure_stage TEXT,
        cancelled_at INTEGER,
        model_context_limit INTEGER,
        context_tokens INTEGER,
        context_utilization_bps INTEGER,
        requested_max_output_tokens INTEGER,
        pricing_snapshot_id TEXT,
        metered_cost_micros INTEGER,
        metered_currency TEXT,
        metered_cost_source TEXT,
        api_equivalent_cost_micros INTEGER,
        api_equivalent_currency TEXT,
        api_equivalent_cost_source TEXT,
        raw_metadata_json TEXT,
        FOREIGN KEY(session_id) REFERENCES conversations(id) ON DELETE RESTRICT,
        FOREIGN KEY(turn_id) REFERENCES turns(turn_id) ON DELETE RESTRICT,
        FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE RESTRICT,
        FOREIGN KEY(generation_id) REFERENCES generations(id) ON DELETE RESTRICT,
        FOREIGN KEY(agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        FOREIGN KEY(agent_run_id) REFERENCES agent_runs(agent_run_id) ON DELETE RESTRICT,
        FOREIGN KEY(parent_call_id) REFERENCES model_calls(call_id) ON DELETE RESTRICT,
        FOREIGN KEY(provider_account_id) REFERENCES provider_accounts(provider_account_id) ON DELETE RESTRICT,
        FOREIGN KEY(fallback_from_call_id) REFERENCES model_calls(call_id) ON DELETE RESTRICT,
        FOREIGN KEY(pricing_snapshot_id) REFERENCES model_pricing(pricing_snapshot_id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE IF NOT EXISTS model_call_attempts (
        attempt_id TEXT PRIMARY KEY NOT NULL,
        call_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        provider_account_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        response_received_at INTEGER,
        first_token_at INTEGER,
        last_token_at INTEGER,
        completed_at INTEGER,
        latency_ms INTEGER,
        provider_request_id TEXT,
        http_status INTEGER,
        status TEXT NOT NULL,
        error_type TEXT,
        error_code TEXT,
        failure_stage TEXT,
        fallback_from_attempt_id TEXT,
        fallback_reason TEXT,
        pricing_snapshot_id TEXT,
        metered_cost_micros INTEGER,
        metered_currency TEXT,
        metered_cost_source TEXT,
        api_equivalent_cost_micros INTEGER,
        api_equivalent_currency TEXT,
        api_equivalent_cost_source TEXT,
        raw_metadata_json TEXT,
        UNIQUE(call_id, attempt_number),
        FOREIGN KEY(call_id) REFERENCES model_calls(call_id) ON DELETE RESTRICT,
        FOREIGN KEY(provider_account_id) REFERENCES provider_accounts(provider_account_id) ON DELETE RESTRICT,
        FOREIGN KEY(fallback_from_attempt_id) REFERENCES model_call_attempts(attempt_id) ON DELETE RESTRICT,
        FOREIGN KEY(pricing_snapshot_id) REFERENCES model_pricing(pricing_snapshot_id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE IF NOT EXISTS model_call_usage (
        call_id TEXT PRIMARY KEY NOT NULL,
        ${USAGE_COLUMNS},
        FOREIGN KEY(call_id) REFERENCES model_calls(call_id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE IF NOT EXISTS model_call_attempt_usage (
        attempt_id TEXT PRIMARY KEY NOT NULL,
        ${USAGE_COLUMNS},
        FOREIGN KEY(attempt_id) REFERENCES model_call_attempts(attempt_id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE IF NOT EXISTS cost_allocations (
        allocation_id TEXT PRIMARY KEY NOT NULL,
        call_id TEXT NOT NULL,
        subscription_plan_id TEXT NOT NULL,
        period_start INTEGER NOT NULL,
        period_end INTEGER NOT NULL,
        amount_micros INTEGER NOT NULL,
        currency TEXT NOT NULL,
        method TEXT NOT NULL,
        batch_id TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(call_id) REFERENCES model_calls(call_id) ON DELETE RESTRICT,
        FOREIGN KEY(subscription_plan_id) REFERENCES subscription_plans(subscription_plan_id) ON DELETE RESTRICT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_turns_session_started
        ON turns(session_id, started_at)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_runs_turn_parent
        ON agent_runs(turn_id, parent_agent_run_id, started_at)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_started
        ON agent_runs(agent_id, started_at)`,
      `CREATE INDEX IF NOT EXISTS idx_provider_accounts_provider
        ON provider_accounts(provider, active)`,
      `CREATE INDEX IF NOT EXISTS idx_subscription_plans_account_period
        ON subscription_plans(provider_account_id, period_start, period_end)`,
      `CREATE INDEX IF NOT EXISTS idx_model_pricing_lookup
        ON model_pricing(provider, model, provider_account_id, effective_from, effective_to)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_turn_run
        ON model_calls(turn_id, agent_run_id, requested_at)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_session_requested
        ON model_calls(session_id, requested_at)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_agent_requested
        ON model_calls(agent_id, requested_at)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_provider_requested
        ON model_calls(provider, provider_account_id, model, requested_at)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_message
        ON model_calls(message_id)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_generation
        ON model_calls(generation_id)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_status_requested
        ON model_calls(status, requested_at)`,
      `CREATE INDEX IF NOT EXISTS idx_model_call_attempts_call
        ON model_call_attempts(call_id, attempt_number)`,
      `CREATE INDEX IF NOT EXISTS idx_model_call_attempts_provider_started
        ON model_call_attempts(provider, provider_account_id, model, started_at)`,
      `CREATE INDEX IF NOT EXISTS idx_cost_allocations_plan_period
        ON cost_allocations(subscription_plan_id, period_start, period_end)`,
      `CREATE INDEX IF NOT EXISTS idx_cost_allocations_call
        ON cost_allocations(call_id, created_at)`,
    ],
  },
  // Version 3 rebuilds three tables (SQLite cannot alter column nullability or
  // drop columns portably across Android API levels):
  // - agent_runs.turn_id and model_calls.turn_id become nullable so background /
  //   proactive work without a chat turn can be recorded.
  // - model_call_attempts loses fallback_from_attempt_id / fallback_reason:
  //   provider/model fallback is modeled as a separate model call linked through
  //   model_calls.fallback_from_call_id, not as another attempt of the failed call.
  // The migrate() runner disables foreign key enforcement around migrations; the
  // rebuilds must stay within a single migration so referential integrity is
  // re-established before enforcement is re-enabled.
  {
    version: 3,
    statements: [
      `CREATE TABLE agent_runs_v3 (
        agent_run_id TEXT PRIMARY KEY NOT NULL,
        agent_id TEXT NOT NULL,
        parent_agent_run_id TEXT,
        spawned_by_agent_id TEXT,
        spawned_by_run_id TEXT,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        purpose TEXT,
        spawn_reason TEXT,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        agent_name_snapshot TEXT NOT NULL,
        agent_kind_snapshot TEXT NOT NULL,
        metadata_json TEXT,
        FOREIGN KEY(agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        FOREIGN KEY(parent_agent_run_id) REFERENCES agent_runs(agent_run_id) ON DELETE RESTRICT,
        FOREIGN KEY(spawned_by_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        FOREIGN KEY(spawned_by_run_id) REFERENCES agent_runs(agent_run_id) ON DELETE RESTRICT,
        FOREIGN KEY(session_id) REFERENCES conversations(id) ON DELETE RESTRICT,
        FOREIGN KEY(turn_id) REFERENCES turns(turn_id) ON DELETE RESTRICT
      )`,
      `INSERT INTO agent_runs_v3 (
        agent_run_id, agent_id, parent_agent_run_id, spawned_by_agent_id, spawned_by_run_id,
        session_id, turn_id, purpose, spawn_reason, status, started_at, completed_at,
        agent_name_snapshot, agent_kind_snapshot, metadata_json
      ) SELECT
        agent_run_id, agent_id, parent_agent_run_id, spawned_by_agent_id, spawned_by_run_id,
        session_id, turn_id, purpose, spawn_reason, status, started_at, completed_at,
        agent_name_snapshot, agent_kind_snapshot, metadata_json
      FROM agent_runs`,
      `DROP TABLE agent_runs`,
      `ALTER TABLE agent_runs_v3 RENAME TO agent_runs`,
      `CREATE TABLE model_calls_v3 (
        call_id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        message_id TEXT,
        generation_id TEXT,
        agent_id TEXT NOT NULL,
        agent_run_id TEXT NOT NULL,
        owns_turn INTEGER NOT NULL,
        owns_agent_run INTEGER NOT NULL,
        parent_call_id TEXT,
        provider_account_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_request_id TEXT,
        route_reason TEXT,
        route_policy_id TEXT,
        fallback_from_call_id TEXT,
        requested_at INTEGER NOT NULL,
        first_token_at INTEGER,
        last_token_at INTEGER,
        completed_at INTEGER,
        ttft_ms INTEGER,
        generation_duration_ms INTEGER,
        total_latency_ms INTEGER,
        output_tokens_per_second_milli INTEGER,
        status TEXT NOT NULL,
        finish_reason TEXT,
        error_type TEXT,
        error_code TEXT,
        failure_stage TEXT,
        cancelled_at INTEGER,
        model_context_limit INTEGER,
        context_tokens INTEGER,
        context_utilization_bps INTEGER,
        requested_max_output_tokens INTEGER,
        pricing_snapshot_id TEXT,
        metered_cost_micros INTEGER,
        metered_currency TEXT,
        metered_cost_source TEXT,
        api_equivalent_cost_micros INTEGER,
        api_equivalent_currency TEXT,
        api_equivalent_cost_source TEXT,
        raw_metadata_json TEXT,
        FOREIGN KEY(session_id) REFERENCES conversations(id) ON DELETE RESTRICT,
        FOREIGN KEY(turn_id) REFERENCES turns(turn_id) ON DELETE RESTRICT,
        FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE RESTRICT,
        FOREIGN KEY(generation_id) REFERENCES generations(id) ON DELETE RESTRICT,
        FOREIGN KEY(agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        FOREIGN KEY(agent_run_id) REFERENCES agent_runs(agent_run_id) ON DELETE RESTRICT,
        FOREIGN KEY(parent_call_id) REFERENCES model_calls(call_id) ON DELETE RESTRICT,
        FOREIGN KEY(provider_account_id) REFERENCES provider_accounts(provider_account_id) ON DELETE RESTRICT,
        FOREIGN KEY(fallback_from_call_id) REFERENCES model_calls(call_id) ON DELETE RESTRICT,
        FOREIGN KEY(pricing_snapshot_id) REFERENCES model_pricing(pricing_snapshot_id) ON DELETE RESTRICT
      )`,
      `INSERT INTO model_calls_v3 (
        call_id, session_id, turn_id, message_id, generation_id, agent_id, agent_run_id,
        owns_turn, owns_agent_run, parent_call_id, provider_account_id, provider, model,
        provider_request_id, route_reason, route_policy_id, fallback_from_call_id,
        requested_at, first_token_at, last_token_at, completed_at, ttft_ms,
        generation_duration_ms, total_latency_ms, output_tokens_per_second_milli,
        status, finish_reason, error_type, error_code, failure_stage, cancelled_at,
        model_context_limit, context_tokens, context_utilization_bps,
        requested_max_output_tokens, pricing_snapshot_id, metered_cost_micros,
        metered_currency, metered_cost_source, api_equivalent_cost_micros,
        api_equivalent_currency, api_equivalent_cost_source, raw_metadata_json
      ) SELECT
        call_id, session_id, turn_id, message_id, generation_id, agent_id, agent_run_id,
        owns_turn, owns_agent_run, parent_call_id, provider_account_id, provider, model,
        provider_request_id, route_reason, route_policy_id, fallback_from_call_id,
        requested_at, first_token_at, last_token_at, completed_at, ttft_ms,
        generation_duration_ms, total_latency_ms, output_tokens_per_second_milli,
        status, finish_reason, error_type, error_code, failure_stage, cancelled_at,
        model_context_limit, context_tokens, context_utilization_bps,
        requested_max_output_tokens, pricing_snapshot_id, metered_cost_micros,
        metered_currency, metered_cost_source, api_equivalent_cost_micros,
        api_equivalent_currency, api_equivalent_cost_source, raw_metadata_json
      FROM model_calls`,
      `DROP TABLE model_calls`,
      `ALTER TABLE model_calls_v3 RENAME TO model_calls`,
      `CREATE TABLE model_call_attempts_v3 (
        attempt_id TEXT PRIMARY KEY NOT NULL,
        call_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        provider_account_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        response_received_at INTEGER,
        first_token_at INTEGER,
        last_token_at INTEGER,
        completed_at INTEGER,
        latency_ms INTEGER,
        provider_request_id TEXT,
        http_status INTEGER,
        status TEXT NOT NULL,
        error_type TEXT,
        error_code TEXT,
        failure_stage TEXT,
        pricing_snapshot_id TEXT,
        metered_cost_micros INTEGER,
        metered_currency TEXT,
        metered_cost_source TEXT,
        api_equivalent_cost_micros INTEGER,
        api_equivalent_currency TEXT,
        api_equivalent_cost_source TEXT,
        raw_metadata_json TEXT,
        UNIQUE(call_id, attempt_number),
        FOREIGN KEY(call_id) REFERENCES model_calls(call_id) ON DELETE RESTRICT,
        FOREIGN KEY(provider_account_id) REFERENCES provider_accounts(provider_account_id) ON DELETE RESTRICT,
        FOREIGN KEY(pricing_snapshot_id) REFERENCES model_pricing(pricing_snapshot_id) ON DELETE RESTRICT
      )`,
      `INSERT INTO model_call_attempts_v3 (
        attempt_id, call_id, attempt_number, provider_account_id, provider, model,
        started_at, response_received_at, first_token_at, last_token_at, completed_at,
        latency_ms, provider_request_id, http_status, status, error_type, error_code,
        failure_stage, pricing_snapshot_id, metered_cost_micros, metered_currency,
        metered_cost_source, api_equivalent_cost_micros, api_equivalent_currency,
        api_equivalent_cost_source, raw_metadata_json
      ) SELECT
        attempt_id, call_id, attempt_number, provider_account_id, provider, model,
        started_at, response_received_at, first_token_at, last_token_at, completed_at,
        latency_ms, provider_request_id, http_status, status, error_type, error_code,
        failure_stage, pricing_snapshot_id, metered_cost_micros, metered_currency,
        metered_cost_source, api_equivalent_cost_micros, api_equivalent_currency,
        api_equivalent_cost_source, raw_metadata_json
      FROM model_call_attempts`,
      `DROP TABLE model_call_attempts`,
      `ALTER TABLE model_call_attempts_v3 RENAME TO model_call_attempts`,
      // Re-create the v2 indexes that were dropped with the rebuilt tables.
      `CREATE INDEX IF NOT EXISTS idx_agent_runs_turn_parent
        ON agent_runs(turn_id, parent_agent_run_id, started_at)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_started
        ON agent_runs(agent_id, started_at)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_turn_run
        ON model_calls(turn_id, agent_run_id, requested_at)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_session_requested
        ON model_calls(session_id, requested_at)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_agent_requested
        ON model_calls(agent_id, requested_at)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_provider_requested
        ON model_calls(provider, provider_account_id, model, requested_at)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_message
        ON model_calls(message_id)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_generation
        ON model_calls(generation_id)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_status_requested
        ON model_calls(status, requested_at)`,
      `CREATE INDEX IF NOT EXISTS idx_model_call_attempts_call
        ON model_call_attempts(call_id, attempt_number)`,
      `CREATE INDEX IF NOT EXISTS idx_model_call_attempts_provider_started
        ON model_call_attempts(provider, provider_account_id, model, started_at)`,
      // New indexes for recovery scans, lineage lookups, and per-run attribution.
      `CREATE INDEX IF NOT EXISTS idx_turns_status
        ON turns(status)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_runs_status
        ON agent_runs(status)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_runs_parent
        ON agent_runs(parent_agent_run_id)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_agent_run
        ON model_calls(agent_run_id, requested_at)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_fallback_from
        ON model_calls(fallback_from_call_id)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_pricing_snapshot
        ON model_calls(pricing_snapshot_id)`,
    ],
  },
  {
    version: 4,
    statements: [
      `CREATE TABLE agent_runs_v4 (
        agent_run_id TEXT PRIMARY KEY NOT NULL,
        agent_id TEXT NOT NULL,
        parent_agent_run_id TEXT,
        spawned_by_agent_id TEXT,
        spawned_by_run_id TEXT,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        purpose TEXT,
        spawn_reason TEXT,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        agent_name_snapshot TEXT NOT NULL,
        agent_kind_snapshot TEXT NOT NULL,
        metadata_json TEXT,
        FOREIGN KEY(agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        FOREIGN KEY(parent_agent_run_id) REFERENCES agent_runs(agent_run_id) ON DELETE RESTRICT,
        FOREIGN KEY(spawned_by_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        FOREIGN KEY(spawned_by_run_id) REFERENCES agent_runs(agent_run_id) ON DELETE RESTRICT,
        FOREIGN KEY(session_id) REFERENCES conversations(id) ON DELETE RESTRICT,
        FOREIGN KEY(turn_id) REFERENCES turns(turn_id) ON DELETE RESTRICT
      )`,
      `INSERT INTO agent_runs_v4 (
        agent_run_id, agent_id, parent_agent_run_id, spawned_by_agent_id, spawned_by_run_id,
        session_id, turn_id, purpose, spawn_reason, status, started_at, completed_at,
        agent_name_snapshot, agent_kind_snapshot, metadata_json
      ) SELECT
        agent_run_id, agent_id, parent_agent_run_id, spawned_by_agent_id, spawned_by_run_id,
        session_id, turn_id, purpose, spawn_reason, status, started_at, completed_at,
        agent_name_snapshot, agent_kind_snapshot, metadata_json
      FROM agent_runs`,
      `DROP TABLE agent_runs`,
      `ALTER TABLE agent_runs_v4 RENAME TO agent_runs`,
      `CREATE TABLE model_calls_v4 (
        call_id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        message_id TEXT,
        generation_id TEXT,
        agent_id TEXT NOT NULL,
        agent_run_id TEXT NOT NULL,
        owns_turn INTEGER NOT NULL,
        owns_agent_run INTEGER NOT NULL,
        parent_call_id TEXT,
        provider_account_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_request_id TEXT,
        route_reason TEXT,
        route_policy_id TEXT,
        fallback_from_call_id TEXT,
        requested_at INTEGER NOT NULL,
        first_token_at INTEGER,
        last_token_at INTEGER,
        completed_at INTEGER,
        ttft_ms INTEGER,
        generation_duration_ms INTEGER,
        total_latency_ms INTEGER,
        output_tokens_per_second_milli INTEGER,
        status TEXT NOT NULL,
        finish_reason TEXT,
        error_type TEXT,
        error_code TEXT,
        failure_stage TEXT,
        cancelled_at INTEGER,
        model_context_limit INTEGER,
        context_tokens INTEGER,
        context_utilization_bps INTEGER,
        requested_max_output_tokens INTEGER,
        pricing_snapshot_id TEXT,
        metered_cost_micros INTEGER,
        metered_currency TEXT,
        metered_cost_source TEXT,
        api_equivalent_cost_micros INTEGER,
        api_equivalent_currency TEXT,
        api_equivalent_cost_source TEXT,
        raw_metadata_json TEXT,
        FOREIGN KEY(session_id) REFERENCES conversations(id) ON DELETE RESTRICT,
        FOREIGN KEY(turn_id) REFERENCES turns(turn_id) ON DELETE RESTRICT,
        FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE RESTRICT,
        FOREIGN KEY(generation_id) REFERENCES generations(id) ON DELETE RESTRICT,
        FOREIGN KEY(agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        FOREIGN KEY(agent_run_id) REFERENCES agent_runs(agent_run_id) ON DELETE RESTRICT,
        FOREIGN KEY(parent_call_id) REFERENCES model_calls(call_id) ON DELETE RESTRICT,
        FOREIGN KEY(provider_account_id) REFERENCES provider_accounts(provider_account_id) ON DELETE RESTRICT,
        FOREIGN KEY(fallback_from_call_id) REFERENCES model_calls(call_id) ON DELETE RESTRICT,
        FOREIGN KEY(pricing_snapshot_id) REFERENCES model_pricing(pricing_snapshot_id) ON DELETE RESTRICT
      )`,
      `INSERT INTO model_calls_v4 (
        call_id, session_id, turn_id, message_id, generation_id, agent_id, agent_run_id,
        owns_turn, owns_agent_run, parent_call_id, provider_account_id, provider, model,
        provider_request_id, route_reason, route_policy_id, fallback_from_call_id,
        requested_at, first_token_at, last_token_at, completed_at, ttft_ms,
        generation_duration_ms, total_latency_ms, output_tokens_per_second_milli,
        status, finish_reason, error_type, error_code, failure_stage, cancelled_at,
        model_context_limit, context_tokens, context_utilization_bps,
        requested_max_output_tokens, pricing_snapshot_id, metered_cost_micros,
        metered_currency, metered_cost_source, api_equivalent_cost_micros,
        api_equivalent_currency, api_equivalent_cost_source, raw_metadata_json
      ) SELECT
        call_id, session_id, turn_id, message_id, generation_id, agent_id, agent_run_id,
        owns_turn, owns_agent_run, parent_call_id, provider_account_id, provider, model,
        provider_request_id, route_reason, route_policy_id, fallback_from_call_id,
        requested_at, first_token_at, last_token_at, completed_at, ttft_ms,
        generation_duration_ms, total_latency_ms, output_tokens_per_second_milli,
        status, finish_reason, error_type, error_code, failure_stage, cancelled_at,
        model_context_limit, context_tokens, context_utilization_bps,
        requested_max_output_tokens, pricing_snapshot_id, metered_cost_micros,
        metered_currency, metered_cost_source, api_equivalent_cost_micros,
        api_equivalent_currency, api_equivalent_cost_source, raw_metadata_json
      FROM model_calls`,
      `DROP TABLE model_calls`,
      `ALTER TABLE model_calls_v4 RENAME TO model_calls`,
      `CREATE INDEX IF NOT EXISTS idx_agent_runs_turn_parent
        ON agent_runs(turn_id, parent_agent_run_id, started_at)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_started
        ON agent_runs(agent_id, started_at)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_runs_status
        ON agent_runs(status)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_runs_parent
        ON agent_runs(parent_agent_run_id)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_turn_run
        ON model_calls(turn_id, agent_run_id, requested_at)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_session_requested
        ON model_calls(session_id, requested_at)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_agent_requested
        ON model_calls(agent_id, requested_at)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_provider_requested
        ON model_calls(provider, provider_account_id, model, requested_at)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_message
        ON model_calls(message_id)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_generation
        ON model_calls(generation_id)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_status_requested
        ON model_calls(status, requested_at)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_agent_run
        ON model_calls(agent_run_id, requested_at)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_fallback_from
        ON model_calls(fallback_from_call_id)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_pricing_snapshot
        ON model_calls(pricing_snapshot_id)`,
    ],
  },
  {
    version: 5,
    statements: [
      `ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'`,
      `ALTER TABLE conversations ADD COLUMN state TEXT NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'archived'))`,
      `ALTER TABLE conversations ADD COLUMN owner_agent_id TEXT`,
      `ALTER TABLE conversations ADD COLUMN parent_session_id TEXT
        REFERENCES conversations(id) ON DELETE RESTRICT`,
      `ALTER TABLE conversations ADD COLUMN archived_at INTEGER`,
      `CREATE INDEX idx_conversations_state_updated ON conversations(state, updated_at, id)`,
      `CREATE INDEX idx_conversations_parent ON conversations(parent_session_id)`,
    ],
  },
];
