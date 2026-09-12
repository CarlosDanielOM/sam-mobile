import type {
  AgentRecord,
  AgentRunRecord,
  CostAllocationRecord,
  ModelCallAttemptRecord,
  ModelCallAttemptUsageRecord,
  ModelCallRecord,
  ModelCallUsageRecord,
  PricingSnapshotRecord,
  ProviderAccountRecord,
  SubscriptionPlanRecord,
  TelemetryRepository,
  TokenUsage,
  TurnRecord,
} from '../telemetry/types';

type RowReader<T> = (cursor: any) => T;

function text(cursor: any, column: string): string {
  const index = cursor.getColumnIndex(column);
  return String(cursor.getString(index) ?? '');
}

function optionalText(cursor: any, column: string): string | null {
  const index = cursor.getColumnIndex(column);
  return index < 0 || cursor.isNull(index) ? null : String(cursor.getString(index));
}

function integer(cursor: any, column: string): number {
  return Number(cursor.getLong(cursor.getColumnIndex(column)));
}

function optionalInteger(cursor: any, column: string): number | null {
  const index = cursor.getColumnIndex(column);
  return index < 0 || cursor.isNull(index) ? null : Number(cursor.getLong(index));
}

function queryOne<T>(db: any, sql: string, args: unknown[], reader: RowReader<T>): T | null {
  const cursor = db.rawQuery(sql, args.map(String));
  try {
    return cursor.moveToFirst() ? reader(cursor) : null;
  } finally {
    cursor.close();
  }
}

function queryAll<T>(db: any, sql: string, args: unknown[], reader: RowReader<T>): T[] {
  const cursor = db.rawQuery(sql, args.map(String));
  const records: T[] = [];
  try {
    while (cursor.moveToNext()) {
      records.push(reader(cursor));
    }
    return records;
  } finally {
    cursor.close();
  }
}

function values(record: Record<string, unknown>): unknown[] {
  return Object.values(record).map((value) => (typeof value === 'boolean' ? Number(value) : value));
}

function insert(db: any, table: string, record: Record<string, unknown>, replace = false): void {
  const columns = Object.keys(record);
  db.execSQL(
    `INSERT ${replace ? 'OR REPLACE ' : ''}INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    values(record),
  );
}

function update(db: any, table: string, idColumn: string, id: string, record: Record<string, unknown>): void {
  const columns = Object.keys(record);
  db.execSQL(
    `UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE ${idColumn} = ?`,
    [...values(record), id],
  );
}

function readAgent(cursor: any): AgentRecord {
  return {
    id: text(cursor, 'agent_id'),
    name: text(cursor, 'name'),
    kind: text(cursor, 'kind'),
    persistent: integer(cursor, 'persistent') !== 0,
    ownerAgentId: optionalText(cursor, 'owner_agent_id'),
    defaultModelPolicyId: optionalText(cursor, 'default_model_policy_id'),
    metadataJson: optionalText(cursor, 'metadata_json'),
    createdAt: integer(cursor, 'created_at'),
    deletedAt: optionalInteger(cursor, 'deleted_at'),
  };
}

function agentValues(record: AgentRecord): Record<string, unknown> {
  return {
    agent_id: record.id,
    name: record.name,
    kind: record.kind,
    persistent: record.persistent,
    owner_agent_id: record.ownerAgentId,
    default_model_policy_id: record.defaultModelPolicyId,
    metadata_json: record.metadataJson,
    created_at: record.createdAt,
    deleted_at: record.deletedAt,
  };
}

function readTurn(cursor: any): TurnRecord {
  return {
    id: text(cursor, 'turn_id'),
    sessionId: text(cursor, 'session_id'),
    userMessageId: optionalText(cursor, 'user_message_id'),
    status: text(cursor, 'status'),
    startedAt: integer(cursor, 'started_at'),
    completedAt: optionalInteger(cursor, 'completed_at'),
    metadataJson: optionalText(cursor, 'metadata_json'),
  };
}

function turnValues(record: TurnRecord): Record<string, unknown> {
  return {
    turn_id: record.id,
    session_id: record.sessionId,
    user_message_id: record.userMessageId,
    status: record.status,
    started_at: record.startedAt,
    completed_at: record.completedAt,
    metadata_json: record.metadataJson,
  };
}

function readAgentRun(cursor: any): AgentRunRecord {
  return {
    id: text(cursor, 'agent_run_id'),
    agentId: text(cursor, 'agent_id'),
    parentAgentRunId: optionalText(cursor, 'parent_agent_run_id'),
    spawnedByAgentId: optionalText(cursor, 'spawned_by_agent_id'),
    spawnedByRunId: optionalText(cursor, 'spawned_by_run_id'),
    sessionId: text(cursor, 'session_id'),
    turnId: optionalText(cursor, 'turn_id'),
    purpose: optionalText(cursor, 'purpose'),
    spawnReason: optionalText(cursor, 'spawn_reason'),
    status: text(cursor, 'status'),
    startedAt: integer(cursor, 'started_at'),
    completedAt: optionalInteger(cursor, 'completed_at'),
    agentNameSnapshot: text(cursor, 'agent_name_snapshot'),
    agentKindSnapshot: text(cursor, 'agent_kind_snapshot'),
    metadataJson: optionalText(cursor, 'metadata_json'),
  };
}

function agentRunValues(record: AgentRunRecord): Record<string, unknown> {
  return {
    agent_run_id: record.id,
    agent_id: record.agentId,
    parent_agent_run_id: record.parentAgentRunId,
    spawned_by_agent_id: record.spawnedByAgentId,
    spawned_by_run_id: record.spawnedByRunId,
    session_id: record.sessionId,
    turn_id: record.turnId,
    purpose: record.purpose,
    spawn_reason: record.spawnReason,
    status: record.status,
    started_at: record.startedAt,
    completed_at: record.completedAt,
    agent_name_snapshot: record.agentNameSnapshot,
    agent_kind_snapshot: record.agentKindSnapshot,
    metadata_json: record.metadataJson,
  };
}

function readProviderAccount(cursor: any): ProviderAccountRecord {
  return {
    id: text(cursor, 'provider_account_id'),
    provider: text(cursor, 'provider'),
    displayLabel: text(cursor, 'display_label'),
    billingMode: text(cursor, 'billing_mode'),
    planReference: optionalText(cursor, 'plan_reference'),
    active: integer(cursor, 'active') !== 0,
    metadataJson: optionalText(cursor, 'metadata_json'),
    createdAt: integer(cursor, 'created_at'),
    updatedAt: integer(cursor, 'updated_at'),
  };
}

function providerAccountValues(record: ProviderAccountRecord): Record<string, unknown> {
  return {
    provider_account_id: record.id,
    provider: record.provider,
    display_label: record.displayLabel,
    billing_mode: record.billingMode,
    plan_reference: record.planReference,
    active: record.active,
    metadata_json: record.metadataJson,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function readPlan(cursor: any): SubscriptionPlanRecord {
  return {
    id: text(cursor, 'subscription_plan_id'),
    providerAccountId: text(cursor, 'provider_account_id'),
    name: text(cursor, 'name'),
    billingMode: text(cursor, 'billing_mode'),
    currency: text(cursor, 'currency'),
    priceMicros: integer(cursor, 'price_micros'),
    periodStart: integer(cursor, 'period_start'),
    periodEnd: integer(cursor, 'period_end'),
    metadataJson: optionalText(cursor, 'metadata_json'),
    createdAt: integer(cursor, 'created_at'),
  };
}

function readPricing(cursor: any): PricingSnapshotRecord {
  return {
    id: text(cursor, 'pricing_snapshot_id'),
    provider: text(cursor, 'provider'),
    providerAccountId: optionalText(cursor, 'provider_account_id'),
    model: text(cursor, 'model'),
    inputPerMillionMicros: optionalInteger(cursor, 'input_per_million_micros'),
    cacheReadPerMillionMicros: optionalInteger(cursor, 'cache_read_per_million_micros'),
    cacheWritePerMillionMicros: optionalInteger(cursor, 'cache_write_per_million_micros'),
    outputPerMillionMicros: optionalInteger(cursor, 'output_per_million_micros'),
    reasoningPerMillionMicros: optionalInteger(cursor, 'reasoning_per_million_micros'),
    modalityRatesJson: optionalText(cursor, 'modality_rates_json'),
    currency: text(cursor, 'currency'),
    effectiveFrom: integer(cursor, 'effective_from'),
    effectiveTo: optionalInteger(cursor, 'effective_to'),
    source: text(cursor, 'source'),
    notes: optionalText(cursor, 'notes'),
    createdAt: integer(cursor, 'created_at'),
  };
}

function readCall(cursor: any): ModelCallRecord {
  return {
    id: text(cursor, 'call_id'),
    sessionId: text(cursor, 'session_id'),
    turnId: optionalText(cursor, 'turn_id'),
    messageId: optionalText(cursor, 'message_id'),
    generationId: optionalText(cursor, 'generation_id'),
    agentId: text(cursor, 'agent_id'),
    agentRunId: text(cursor, 'agent_run_id'),
    ownsTurn: integer(cursor, 'owns_turn') !== 0,
    ownsAgentRun: integer(cursor, 'owns_agent_run') !== 0,
    parentCallId: optionalText(cursor, 'parent_call_id'),
    providerAccountId: text(cursor, 'provider_account_id'),
    provider: text(cursor, 'provider'),
    model: text(cursor, 'model'),
    providerRequestId: optionalText(cursor, 'provider_request_id'),
    routeReason: optionalText(cursor, 'route_reason'),
    routePolicyId: optionalText(cursor, 'route_policy_id'),
    fallbackFromCallId: optionalText(cursor, 'fallback_from_call_id'),
    requestedAt: integer(cursor, 'requested_at'),
    firstTokenAt: optionalInteger(cursor, 'first_token_at'),
    lastTokenAt: optionalInteger(cursor, 'last_token_at'),
    completedAt: optionalInteger(cursor, 'completed_at'),
    ttftMs: optionalInteger(cursor, 'ttft_ms'),
    generationDurationMs: optionalInteger(cursor, 'generation_duration_ms'),
    totalLatencyMs: optionalInteger(cursor, 'total_latency_ms'),
    outputTokensPerSecondMilli: optionalInteger(cursor, 'output_tokens_per_second_milli'),
    status: text(cursor, 'status'),
    finishReason: optionalText(cursor, 'finish_reason'),
    errorType: optionalText(cursor, 'error_type'),
    errorCode: optionalText(cursor, 'error_code'),
    failureStage: optionalText(cursor, 'failure_stage'),
    cancelledAt: optionalInteger(cursor, 'cancelled_at'),
    modelContextLimit: optionalInteger(cursor, 'model_context_limit'),
    contextTokens: optionalInteger(cursor, 'context_tokens'),
    contextUtilizationBps: optionalInteger(cursor, 'context_utilization_bps'),
    requestedMaxOutputTokens: optionalInteger(cursor, 'requested_max_output_tokens'),
    pricingSnapshotId: optionalText(cursor, 'pricing_snapshot_id'),
    meteredCostMicros: optionalInteger(cursor, 'metered_cost_micros'),
    meteredCurrency: optionalText(cursor, 'metered_currency'),
    meteredCostSource: optionalText(cursor, 'metered_cost_source'),
    apiEquivalentCostMicros: optionalInteger(cursor, 'api_equivalent_cost_micros'),
    apiEquivalentCurrency: optionalText(cursor, 'api_equivalent_currency'),
    apiEquivalentCostSource: optionalText(cursor, 'api_equivalent_cost_source'),
    rawMetadataJson: optionalText(cursor, 'raw_metadata_json'),
  };
}

function callValues(record: ModelCallRecord): Record<string, unknown> {
  return {
    call_id: record.id,
    session_id: record.sessionId,
    turn_id: record.turnId,
    message_id: record.messageId,
    generation_id: record.generationId,
    agent_id: record.agentId,
    agent_run_id: record.agentRunId,
    owns_turn: record.ownsTurn,
    owns_agent_run: record.ownsAgentRun,
    parent_call_id: record.parentCallId,
    provider_account_id: record.providerAccountId,
    provider: record.provider,
    model: record.model,
    provider_request_id: record.providerRequestId,
    route_reason: record.routeReason,
    route_policy_id: record.routePolicyId,
    fallback_from_call_id: record.fallbackFromCallId,
    requested_at: record.requestedAt,
    first_token_at: record.firstTokenAt,
    last_token_at: record.lastTokenAt,
    completed_at: record.completedAt,
    ttft_ms: record.ttftMs,
    generation_duration_ms: record.generationDurationMs,
    total_latency_ms: record.totalLatencyMs,
    output_tokens_per_second_milli: record.outputTokensPerSecondMilli,
    status: record.status,
    finish_reason: record.finishReason,
    error_type: record.errorType,
    error_code: record.errorCode,
    failure_stage: record.failureStage,
    cancelled_at: record.cancelledAt,
    model_context_limit: record.modelContextLimit,
    context_tokens: record.contextTokens,
    context_utilization_bps: record.contextUtilizationBps,
    requested_max_output_tokens: record.requestedMaxOutputTokens,
    pricing_snapshot_id: record.pricingSnapshotId,
    metered_cost_micros: record.meteredCostMicros,
    metered_currency: record.meteredCurrency,
    metered_cost_source: record.meteredCostSource,
    api_equivalent_cost_micros: record.apiEquivalentCostMicros,
    api_equivalent_currency: record.apiEquivalentCurrency,
    api_equivalent_cost_source: record.apiEquivalentCostSource,
    raw_metadata_json: record.rawMetadataJson,
  };
}

function readAttempt(cursor: any): ModelCallAttemptRecord {
  return {
    id: text(cursor, 'attempt_id'),
    callId: text(cursor, 'call_id'),
    attemptNumber: integer(cursor, 'attempt_number'),
    providerAccountId: text(cursor, 'provider_account_id'),
    provider: text(cursor, 'provider'),
    model: text(cursor, 'model'),
    startedAt: integer(cursor, 'started_at'),
    responseReceivedAt: optionalInteger(cursor, 'response_received_at'),
    firstTokenAt: optionalInteger(cursor, 'first_token_at'),
    lastTokenAt: optionalInteger(cursor, 'last_token_at'),
    completedAt: optionalInteger(cursor, 'completed_at'),
    latencyMs: optionalInteger(cursor, 'latency_ms'),
    providerRequestId: optionalText(cursor, 'provider_request_id'),
    httpStatus: optionalInteger(cursor, 'http_status'),
    status: text(cursor, 'status'),
    errorType: optionalText(cursor, 'error_type'),
    errorCode: optionalText(cursor, 'error_code'),
    failureStage: optionalText(cursor, 'failure_stage'),
    pricingSnapshotId: optionalText(cursor, 'pricing_snapshot_id'),
    meteredCostMicros: optionalInteger(cursor, 'metered_cost_micros'),
    meteredCurrency: optionalText(cursor, 'metered_currency'),
    meteredCostSource: optionalText(cursor, 'metered_cost_source'),
    apiEquivalentCostMicros: optionalInteger(cursor, 'api_equivalent_cost_micros'),
    apiEquivalentCurrency: optionalText(cursor, 'api_equivalent_currency'),
    apiEquivalentCostSource: optionalText(cursor, 'api_equivalent_cost_source'),
    rawMetadataJson: optionalText(cursor, 'raw_metadata_json'),
  };
}

function attemptValues(record: ModelCallAttemptRecord): Record<string, unknown> {
  return {
    attempt_id: record.id,
    call_id: record.callId,
    attempt_number: record.attemptNumber,
    provider_account_id: record.providerAccountId,
    provider: record.provider,
    model: record.model,
    started_at: record.startedAt,
    response_received_at: record.responseReceivedAt,
    first_token_at: record.firstTokenAt,
    last_token_at: record.lastTokenAt,
    completed_at: record.completedAt,
    latency_ms: record.latencyMs,
    provider_request_id: record.providerRequestId,
    http_status: record.httpStatus,
    status: record.status,
    error_type: record.errorType,
    error_code: record.errorCode,
    failure_stage: record.failureStage,
    pricing_snapshot_id: record.pricingSnapshotId,
    metered_cost_micros: record.meteredCostMicros,
    metered_currency: record.meteredCurrency,
    metered_cost_source: record.meteredCostSource,
    api_equivalent_cost_micros: record.apiEquivalentCostMicros,
    api_equivalent_currency: record.apiEquivalentCurrency,
    api_equivalent_cost_source: record.apiEquivalentCostSource,
    raw_metadata_json: record.rawMetadataJson,
  };
}

function usageValues(record: TokenUsage): Record<string, unknown> {
  return {
    reported_input_tokens: record.reportedInputTokens,
    reported_uncached_input_tokens: record.reportedUncachedInputTokens,
    reported_cache_read_tokens: record.reportedCacheReadTokens,
    reported_cache_write_tokens: record.reportedCacheWriteTokens,
    reported_output_tokens: record.reportedOutputTokens,
    reported_reasoning_tokens: record.reportedReasoningTokens,
    reported_total_tokens: record.reportedTotalTokens,
    estimated_input_tokens: record.estimatedInputTokens,
    estimated_uncached_input_tokens: record.estimatedUncachedInputTokens,
    estimated_cache_read_tokens: record.estimatedCacheReadTokens,
    estimated_cache_write_tokens: record.estimatedCacheWriteTokens,
    estimated_output_tokens: record.estimatedOutputTokens,
    estimated_reasoning_tokens: record.estimatedReasoningTokens,
    estimated_total_tokens: record.estimatedTotalTokens,
    usage_source: record.source,
    provenance_json: record.provenanceJson,
    provider_usage_json: record.providerUsageJson,
    context_components_json: record.contextComponentsJson,
    modality_usage_json: record.modalityUsageJson,
  };
}

function readUsage(cursor: any): TokenUsage {
  return {
    reportedInputTokens: optionalInteger(cursor, 'reported_input_tokens'),
    reportedUncachedInputTokens: optionalInteger(cursor, 'reported_uncached_input_tokens'),
    reportedCacheReadTokens: optionalInteger(cursor, 'reported_cache_read_tokens'),
    reportedCacheWriteTokens: optionalInteger(cursor, 'reported_cache_write_tokens'),
    reportedOutputTokens: optionalInteger(cursor, 'reported_output_tokens'),
    reportedReasoningTokens: optionalInteger(cursor, 'reported_reasoning_tokens'),
    reportedTotalTokens: optionalInteger(cursor, 'reported_total_tokens'),
    estimatedInputTokens: optionalInteger(cursor, 'estimated_input_tokens'),
    estimatedUncachedInputTokens: optionalInteger(cursor, 'estimated_uncached_input_tokens'),
    estimatedCacheReadTokens: optionalInteger(cursor, 'estimated_cache_read_tokens'),
    estimatedCacheWriteTokens: optionalInteger(cursor, 'estimated_cache_write_tokens'),
    estimatedOutputTokens: optionalInteger(cursor, 'estimated_output_tokens'),
    estimatedReasoningTokens: optionalInteger(cursor, 'estimated_reasoning_tokens'),
    estimatedTotalTokens: optionalInteger(cursor, 'estimated_total_tokens'),
    source: text(cursor, 'usage_source') as TokenUsage['source'],
    provenanceJson: optionalText(cursor, 'provenance_json'),
    providerUsageJson: optionalText(cursor, 'provider_usage_json'),
    contextComponentsJson: optionalText(cursor, 'context_components_json'),
    modalityUsageJson: optionalText(cursor, 'modality_usage_json'),
  };
}

export class SqliteTelemetryRepository implements TelemetryRepository {
  private readonly database: () => any;

  constructor(database: () => any) {
    this.database = database;
  }

  insertAgent(record: AgentRecord): void {
    insert(this.database(), 'agents', agentValues(record));
  }
  getAgent(id: string): AgentRecord | null {
    return queryOne(this.database(), 'SELECT * FROM agents WHERE agent_id = ?', [id], readAgent);
  }
  updateAgent(record: AgentRecord): void {
    const { agent_id, ...fields } = agentValues(record);
    update(this.database(), 'agents', 'agent_id', String(agent_id), fields);
  }
  insertTurn(record: TurnRecord): void {
    insert(this.database(), 'turns', turnValues(record));
  }
  getTurn(id: string): TurnRecord | null {
    return queryOne(this.database(), 'SELECT * FROM turns WHERE turn_id = ?', [id], readTurn);
  }
  updateTurn(record: TurnRecord): void {
    const { turn_id, ...fields } = turnValues(record);
    update(this.database(), 'turns', 'turn_id', String(turn_id), fields);
  }
  insertAgentRun(record: AgentRunRecord): void {
    insert(this.database(), 'agent_runs', agentRunValues(record));
  }
  getAgentRun(id: string): AgentRunRecord | null {
    return queryOne(this.database(), 'SELECT * FROM agent_runs WHERE agent_run_id = ?', [id], readAgentRun);
  }
  updateAgentRun(record: AgentRunRecord): void {
    const { agent_run_id, ...fields } = agentRunValues(record);
    update(this.database(), 'agent_runs', 'agent_run_id', String(agent_run_id), fields);
  }
  listAgentRunsByTurn(turnId: string): AgentRunRecord[] {
    return queryAll(
      this.database(),
      'SELECT * FROM agent_runs WHERE turn_id = ? ORDER BY started_at, agent_run_id',
      [turnId],
      readAgentRun,
    );
  }
  listAgentRunsByStatus(statuses: AgentRunRecord['status'][]): AgentRunRecord[] {
    if (!statuses.length) return [];
    return queryAll(
      this.database(),
      `SELECT * FROM agent_runs WHERE status IN (${statuses.map(() => '?').join(', ')})`,
      statuses,
      readAgentRun,
    );
  }
  insertProviderAccount(record: ProviderAccountRecord): void {
    insert(this.database(), 'provider_accounts', providerAccountValues(record));
  }
  getProviderAccount(id: string): ProviderAccountRecord | null {
    return queryOne(
      this.database(),
      'SELECT * FROM provider_accounts WHERE provider_account_id = ?',
      [id],
      readProviderAccount,
    );
  }
  updateProviderAccount(record: ProviderAccountRecord): void {
    const { provider_account_id, ...fields } = providerAccountValues(record);
    update(this.database(), 'provider_accounts', 'provider_account_id', String(provider_account_id), fields);
  }
  insertSubscriptionPlan(record: SubscriptionPlanRecord): void {
    insert(this.database(), 'subscription_plans', {
      subscription_plan_id: record.id,
      provider_account_id: record.providerAccountId,
      name: record.name,
      billing_mode: record.billingMode,
      currency: record.currency,
      price_micros: record.priceMicros,
      period_start: record.periodStart,
      period_end: record.periodEnd,
      metadata_json: record.metadataJson,
      created_at: record.createdAt,
    });
  }
  getSubscriptionPlan(id: string): SubscriptionPlanRecord | null {
    return queryOne(
      this.database(),
      'SELECT * FROM subscription_plans WHERE subscription_plan_id = ?',
      [id],
      readPlan,
    );
  }
  insertPricingSnapshot(record: PricingSnapshotRecord): void {
    insert(this.database(), 'model_pricing', {
      pricing_snapshot_id: record.id,
      provider: record.provider,
      provider_account_id: record.providerAccountId,
      model: record.model,
      input_per_million_micros: record.inputPerMillionMicros,
      cache_read_per_million_micros: record.cacheReadPerMillionMicros,
      cache_write_per_million_micros: record.cacheWritePerMillionMicros,
      output_per_million_micros: record.outputPerMillionMicros,
      reasoning_per_million_micros: record.reasoningPerMillionMicros,
      modality_rates_json: record.modalityRatesJson,
      currency: record.currency,
      effective_from: record.effectiveFrom,
      effective_to: record.effectiveTo,
      source: record.source,
      notes: record.notes,
      created_at: record.createdAt,
    });
  }
  getPricingSnapshot(id: string): PricingSnapshotRecord | null {
    return queryOne(
      this.database(),
      'SELECT * FROM model_pricing WHERE pricing_snapshot_id = ?',
      [id],
      readPricing,
    );
  }
  listPricingSnapshots(provider: string, model: string, at: number): PricingSnapshotRecord[] {
    return queryAll(
      this.database(),
      `SELECT * FROM model_pricing
       WHERE provider = ? AND model = ? AND effective_from <= ?
         AND (effective_to IS NULL OR effective_to > ?)
       ORDER BY effective_from DESC, created_at DESC`,
      [provider, model, at, at],
      readPricing,
    );
  }
  insertModelCall(record: ModelCallRecord): void {
    insert(this.database(), 'model_calls', callValues(record));
  }
  getModelCall(id: string): ModelCallRecord | null {
    return queryOne(this.database(), 'SELECT * FROM model_calls WHERE call_id = ?', [id], readCall);
  }
  getModelCallByMessageId(messageId: string): ModelCallRecord | null {
    return queryOne(
      this.database(),
      'SELECT * FROM model_calls WHERE message_id = ? ORDER BY requested_at DESC LIMIT 1',
      [messageId],
      readCall,
    );
  }
  getModelCallByGenerationId(generationId: string): ModelCallRecord | null {
    return queryOne(
      this.database(),
      'SELECT * FROM model_calls WHERE generation_id = ? ORDER BY requested_at DESC LIMIT 1',
      [generationId],
      readCall,
    );
  }
  updateModelCall(record: ModelCallRecord): void {
    const { call_id, ...fields } = callValues(record);
    update(this.database(), 'model_calls', 'call_id', String(call_id), fields);
  }
  listModelCallsBySession(sessionId: string): ModelCallRecord[] {
    return queryAll(
      this.database(),
      'SELECT * FROM model_calls WHERE session_id = ? ORDER BY requested_at, call_id',
      [sessionId],
      readCall,
    );
  }
  listModelCallsByTurn(turnId: string): ModelCallRecord[] {
    return queryAll(
      this.database(),
      'SELECT * FROM model_calls WHERE turn_id = ? ORDER BY requested_at, call_id',
      [turnId],
      readCall,
    );
  }
  listModelCallsByAgentRun(agentRunId: string): ModelCallRecord[] {
    return queryAll(
      this.database(),
      'SELECT * FROM model_calls WHERE agent_run_id = ? ORDER BY requested_at, call_id',
      [agentRunId],
      readCall,
    );
  }
  listModelCallsByAgent(agentId: string): ModelCallRecord[] {
    return queryAll(
      this.database(),
      'SELECT * FROM model_calls WHERE agent_id = ? ORDER BY requested_at, call_id',
      [agentId],
      readCall,
    );
  }
  listModelCallsByFallbackFrom(callId: string): ModelCallRecord[] {
    return queryAll(
      this.database(),
      'SELECT * FROM model_calls WHERE fallback_from_call_id = ? ORDER BY requested_at, call_id',
      [callId],
      readCall,
    );
  }
  listModelCallsByStatus(statuses: ModelCallRecord['status'][]): ModelCallRecord[] {
    if (!statuses.length) return [];
    return queryAll(
      this.database(),
      `SELECT * FROM model_calls WHERE status IN (${statuses.map(() => '?').join(', ')})`,
      statuses,
      readCall,
    );
  }
  insertModelCallAttempt(record: ModelCallAttemptRecord): void {
    insert(this.database(), 'model_call_attempts', attemptValues(record));
  }
  getModelCallAttempt(id: string): ModelCallAttemptRecord | null {
    return queryOne(
      this.database(),
      'SELECT * FROM model_call_attempts WHERE attempt_id = ?',
      [id],
      readAttempt,
    );
  }
  updateModelCallAttempt(record: ModelCallAttemptRecord): void {
    const { attempt_id, ...fields } = attemptValues(record);
    update(this.database(), 'model_call_attempts', 'attempt_id', String(attempt_id), fields);
  }
  listModelCallAttempts(callId: string): ModelCallAttemptRecord[] {
    return queryAll(
      this.database(),
      'SELECT * FROM model_call_attempts WHERE call_id = ? ORDER BY attempt_number',
      [callId],
      readAttempt,
    );
  }
  putModelCallUsage(record: ModelCallUsageRecord): void {
    insert(this.database(), 'model_call_usage', { call_id: record.callId, ...usageValues(record) }, true);
  }
  getModelCallUsage(callId: string): ModelCallUsageRecord | null {
    return queryOne(this.database(), 'SELECT * FROM model_call_usage WHERE call_id = ?', [callId], (cursor) => ({
      callId: text(cursor, 'call_id'),
      ...readUsage(cursor),
    }));
  }
  putModelCallAttemptUsage(record: ModelCallAttemptUsageRecord): void {
    insert(
      this.database(),
      'model_call_attempt_usage',
      { attempt_id: record.attemptId, ...usageValues(record) },
      true,
    );
  }
  getModelCallAttemptUsage(attemptId: string): ModelCallAttemptUsageRecord | null {
    return queryOne(
      this.database(),
      'SELECT * FROM model_call_attempt_usage WHERE attempt_id = ?',
      [attemptId],
      (cursor) => ({ attemptId: text(cursor, 'attempt_id'), ...readUsage(cursor) }),
    );
  }
  insertCostAllocation(record: CostAllocationRecord): void {
    insert(this.database(), 'cost_allocations', {
      allocation_id: record.id,
      call_id: record.callId,
      subscription_plan_id: record.subscriptionPlanId,
      period_start: record.periodStart,
      period_end: record.periodEnd,
      amount_micros: record.amountMicros,
      currency: record.currency,
      method: record.method,
      batch_id: record.batchId,
      created_at: record.createdAt,
    });
  }
  listCostAllocations(callId: string): CostAllocationRecord[] {
    return queryAll(
      this.database(),
      'SELECT * FROM cost_allocations WHERE call_id = ? ORDER BY created_at, allocation_id',
      [callId],
      (cursor) => ({
        id: text(cursor, 'allocation_id'),
        callId: text(cursor, 'call_id'),
        subscriptionPlanId: text(cursor, 'subscription_plan_id'),
        periodStart: integer(cursor, 'period_start'),
        periodEnd: integer(cursor, 'period_end'),
        amountMicros: integer(cursor, 'amount_micros'),
        currency: text(cursor, 'currency'),
        method: text(cursor, 'method'),
        batchId: optionalText(cursor, 'batch_id'),
        createdAt: integer(cursor, 'created_at'),
      }),
    );
  }
  listTurnsByStatus(statuses: TurnRecord['status'][]): TurnRecord[] {
    if (!statuses.length) return [];
    return queryAll(
      this.database(),
      `SELECT * FROM turns WHERE status IN (${statuses.map(() => '?').join(', ')})`,
      statuses,
      readTurn,
    );
  }
}
