import type { Session, SessionRecordPatch, SessionState } from '../sessions/types';
import type {
  ConversationRecord,
  GenerationPatch,
  GenerationRecord,
  GenerationStatus,
  MessagePatch,
  MessageRecord,
  PersistenceApi,
} from './types';
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
  TurnRecord,
} from '../telemetry/types';

function cloneConversation(record: ConversationRecord): ConversationRecord {
  return { ...record };
}

function cloneMessage(record: MessageRecord): MessageRecord {
  return { ...record };
}

function cloneGeneration(record: GenerationRecord): GenerationRecord {
  return {
    ...record,
    usage: record.usage ? { ...record.usage } : null,
  };
}

export class MemoryStore implements PersistenceApi, TelemetryRepository {
  private readonly conversations = new Map<string, ConversationRecord>();
  private readonly messages = new Map<string, MessageRecord>();
  private readonly generations = new Map<string, GenerationRecord>();
  private readonly agents = new Map<string, AgentRecord>();
  private readonly turns = new Map<string, TurnRecord>();
  private readonly agentRuns = new Map<string, AgentRunRecord>();
  private readonly providerAccounts = new Map<string, ProviderAccountRecord>();
  private readonly subscriptionPlans = new Map<string, SubscriptionPlanRecord>();
  private readonly pricingSnapshots = new Map<string, PricingSnapshotRecord>();
  private readonly modelCalls = new Map<string, ModelCallRecord>();
  private readonly attempts = new Map<string, ModelCallAttemptRecord>();
  private readonly callUsage = new Map<string, ModelCallUsageRecord>();
  private readonly attemptUsage = new Map<string, ModelCallAttemptUsageRecord>();
  private readonly costAllocations = new Map<string, CostAllocationRecord>();

  get telemetry(): TelemetryRepository {
    return this;
  }

  ensureConversation(id: string, title?: string | null): ConversationRecord {
    const existing = this.conversations.get(id);
    if (existing) {
      return cloneConversation(existing);
    }
    const now = Date.now();
    const record: ConversationRecord = {
      id,
      title: title ?? null,
      kind: 'chat',
      state: 'active',
      ownerAgentId: null,
      parentSessionId: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(id, record);
    return cloneConversation(record);
  }

  getConversation(id: string): ConversationRecord | null {
    const record = this.conversations.get(id);
    return record ? cloneConversation(record) : null;
  }

  createSession(record: Session): Session {
    if (this.conversations.has(record.id)) throw new Error(`Session already exists: ${record.id}`);
    if (record.parentSessionId !== null && !this.conversations.has(record.parentSessionId)) {
      throw new Error(`Session not found: ${record.parentSessionId}`);
    }
    this.conversations.set(record.id, cloneConversation(record));
    return cloneConversation(record);
  }

  getSession(id: string): Session | null { return this.getConversation(id); }

  listSessions(state?: SessionState): Session[] {
    return [...this.conversations.values()]
      .filter((record) => state === undefined || record.state === state)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .map(cloneConversation);
  }

  updateSession(id: string, patch: SessionRecordPatch): Session {
    const record = this.conversations.get(id);
    if (!record) throw new Error(`Session not found: ${id}`);
    if (patch.title !== undefined) record.title = patch.title;
    if (patch.kind !== undefined) record.kind = patch.kind;
    if (patch.ownerAgentId !== undefined) record.ownerAgentId = patch.ownerAgentId;
    if (patch.updatedAt !== undefined) record.updatedAt = patch.updatedAt;
    return cloneConversation(record);
  }

  listSessionChildren(id: string): Session[] {
    return this.listSessions().filter((record) => record.parentSessionId === id);
  }

  archiveSessions(ids: string[], at: number): void {
    const records = ids.map((id) => {
      const record = this.conversations.get(id);
      if (!record) throw new Error(`Session not found: ${id}`);
      return record;
    });
    for (const record of records) {
      if (record.state === 'archived') continue;
      record.state = 'archived';
      record.archivedAt = at;
      record.updatedAt = at;
    }
  }

  restoreSession(id: string, at: number): Session {
    const record = this.conversations.get(id);
    if (!record) throw new Error(`Session not found: ${id}`);
    if (record.state !== 'active') {
      record.state = 'active';
      record.archivedAt = null;
      record.updatedAt = at;
    }
    return cloneConversation(record);
  }

  updateConversationTitle(id: string, title: string, at: number): void {
    const record = this.conversations.get(id);
    if (!record) {
      return;
    }
    record.title = title;
    record.updatedAt = at;
  }

  touchConversation(id: string, at: number): void {
    const record = this.conversations.get(id);
    if (!record) {
      return;
    }
    record.updatedAt = at;
  }

  insertMessage(message: MessageRecord): void {
    this.messages.set(message.id, cloneMessage(message));
  }

  updateMessage(id: string, patch: MessagePatch): void {
    const record = this.messages.get(id);
    if (!record) {
      return;
    }
    Object.assign(record, patch);
  }

  getMessage(id: string): MessageRecord | null {
    const record = this.messages.get(id);
    return record ? cloneMessage(record) : null;
  }

  listMessages(conversationId: string): MessageRecord[] {
    return [...this.messages.values()]
      .filter((message) => message.conversationId === conversationId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map(cloneMessage);
  }

  insertGeneration(generation: GenerationRecord): void {
    this.generations.set(generation.id, cloneGeneration(generation));
  }

  updateGeneration(id: string, patch: GenerationPatch): void {
    const record = this.generations.get(id);
    if (!record) {
      return;
    }
    if (patch.usage) {
      record.usage = { ...patch.usage };
    }
    if (patch.status !== undefined) {
      record.status = patch.status;
    }
    if (patch.completedAt !== undefined) {
      record.completedAt = patch.completedAt;
    }
    if (patch.error !== undefined) {
      record.error = patch.error;
    }
  }

  getGeneration(id: string): GenerationRecord | null {
    const record = this.generations.get(id);
    return record ? cloneGeneration(record) : null;
  }

  listGenerationsByStatus(statuses: GenerationStatus[]): GenerationRecord[] {
    const wanted = new Set(statuses);
    return [...this.generations.values()]
      .filter((generation) => wanted.has(generation.status))
      .map(cloneGeneration);
  }

  insertAgent(record: AgentRecord): void {
    this.agents.set(record.id, { ...record });
  }

  getAgent(id: string): AgentRecord | null {
    const record = this.agents.get(id);
    return record ? { ...record } : null;
  }

  updateAgent(record: AgentRecord): void {
    if (this.agents.has(record.id)) {
      this.agents.set(record.id, { ...record });
    }
  }

  insertTurn(record: TurnRecord): void {
    this.turns.set(record.id, { ...record });
  }

  getTurn(id: string): TurnRecord | null {
    const record = this.turns.get(id);
    return record ? { ...record } : null;
  }

  updateTurn(record: TurnRecord): void {
    if (this.turns.has(record.id)) {
      this.turns.set(record.id, { ...record });
    }
  }

  insertAgentRun(record: AgentRunRecord): void {
    this.agentRuns.set(record.id, { ...record });
  }

  getAgentRun(id: string): AgentRunRecord | null {
    const record = this.agentRuns.get(id);
    return record ? { ...record } : null;
  }

  updateAgentRun(record: AgentRunRecord): void {
    if (this.agentRuns.has(record.id)) {
      this.agentRuns.set(record.id, { ...record });
    }
  }

  listAgentRunsByTurn(turnId: string): AgentRunRecord[] {
    return [...this.agentRuns.values()]
      .filter((record) => record.turnId === turnId)
      .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
      .map((record) => ({ ...record }));
  }

  listAgentRunsByStatus(statuses: AgentRunRecord['status'][]): AgentRunRecord[] {
    const wanted = new Set(statuses);
    return [...this.agentRuns.values()]
      .filter((record) => wanted.has(record.status))
      .map((record) => ({ ...record }));
  }

  insertProviderAccount(record: ProviderAccountRecord): void {
    this.providerAccounts.set(record.id, { ...record });
  }

  getProviderAccount(id: string): ProviderAccountRecord | null {
    const record = this.providerAccounts.get(id);
    return record ? { ...record } : null;
  }

  updateProviderAccount(record: ProviderAccountRecord): void {
    if (this.providerAccounts.has(record.id)) {
      this.providerAccounts.set(record.id, { ...record });
    }
  }

  insertSubscriptionPlan(record: SubscriptionPlanRecord): void {
    this.subscriptionPlans.set(record.id, { ...record });
  }

  getSubscriptionPlan(id: string): SubscriptionPlanRecord | null {
    const record = this.subscriptionPlans.get(id);
    return record ? { ...record } : null;
  }

  insertPricingSnapshot(record: PricingSnapshotRecord): void {
    this.pricingSnapshots.set(record.id, { ...record });
  }

  getPricingSnapshot(id: string): PricingSnapshotRecord | null {
    const record = this.pricingSnapshots.get(id);
    return record ? { ...record } : null;
  }

  listPricingSnapshots(provider: string, model: string, at: number): PricingSnapshotRecord[] {
    return [...this.pricingSnapshots.values()]
      .filter(
        (record) =>
          record.provider === provider &&
          record.model === model &&
          record.effectiveFrom <= at &&
          (record.effectiveTo === null || record.effectiveTo > at),
      )
      .map((record) => ({ ...record }));
  }

  insertModelCall(record: ModelCallRecord): void {
    this.modelCalls.set(record.id, { ...record });
  }

  getModelCall(id: string): ModelCallRecord | null {
    const record = this.modelCalls.get(id);
    return record ? { ...record } : null;
  }

  getModelCallByMessageId(messageId: string): ModelCallRecord | null {
    return (
      [...this.modelCalls.values()]
        .filter((record) => record.messageId === messageId)
        .sort((a, b) => b.requestedAt - a.requestedAt)
        .map((record) => ({ ...record }))[0] ?? null
    );
  }

  getModelCallByGenerationId(generationId: string): ModelCallRecord | null {
    return (
      [...this.modelCalls.values()]
        .filter((record) => record.generationId === generationId)
        .sort((a, b) => b.requestedAt - a.requestedAt)
        .map((record) => ({ ...record }))[0] ?? null
    );
  }

  updateModelCall(record: ModelCallRecord): void {
    if (this.modelCalls.has(record.id)) {
      this.modelCalls.set(record.id, { ...record });
    }
  }

  listModelCallsBySession(sessionId: string): ModelCallRecord[] {
    return [...this.modelCalls.values()]
      .filter((record) => record.sessionId === sessionId)
      .sort((a, b) => a.requestedAt - b.requestedAt || a.id.localeCompare(b.id))
      .map((record) => ({ ...record }));
  }

  listModelCallsByTurn(turnId: string): ModelCallRecord[] {
    return [...this.modelCalls.values()]
      .filter((record) => record.turnId === turnId)
      .sort((a, b) => a.requestedAt - b.requestedAt || a.id.localeCompare(b.id))
      .map((record) => ({ ...record }));
  }

  listModelCallsByAgentRun(agentRunId: string): ModelCallRecord[] {
    return [...this.modelCalls.values()]
      .filter((record) => record.agentRunId === agentRunId)
      .sort((a, b) => a.requestedAt - b.requestedAt || a.id.localeCompare(b.id))
      .map((record) => ({ ...record }));
  }

  listModelCallsByAgent(agentId: string): ModelCallRecord[] {
    return [...this.modelCalls.values()]
      .filter((record) => record.agentId === agentId)
      .sort((a, b) => a.requestedAt - b.requestedAt || a.id.localeCompare(b.id))
      .map((record) => ({ ...record }));
  }

  listModelCallsByFallbackFrom(callId: string): ModelCallRecord[] {
    return [...this.modelCalls.values()]
      .filter((record) => record.fallbackFromCallId === callId)
      .sort((a, b) => a.requestedAt - b.requestedAt || a.id.localeCompare(b.id))
      .map((record) => ({ ...record }));
  }

  listModelCallsByStatus(statuses: ModelCallRecord['status'][]): ModelCallRecord[] {
    const wanted = new Set(statuses);
    return [...this.modelCalls.values()]
      .filter((record) => wanted.has(record.status))
      .map((record) => ({ ...record }));
  }

  insertModelCallAttempt(record: ModelCallAttemptRecord): void {
    this.attempts.set(record.id, { ...record });
  }

  getModelCallAttempt(id: string): ModelCallAttemptRecord | null {
    const record = this.attempts.get(id);
    return record ? { ...record } : null;
  }

  updateModelCallAttempt(record: ModelCallAttemptRecord): void {
    if (this.attempts.has(record.id)) {
      this.attempts.set(record.id, { ...record });
    }
  }

  listModelCallAttempts(callId: string): ModelCallAttemptRecord[] {
    return [...this.attempts.values()]
      .filter((record) => record.callId === callId)
      .sort((a, b) => a.attemptNumber - b.attemptNumber)
      .map((record) => ({ ...record }));
  }

  putModelCallUsage(record: ModelCallUsageRecord): void {
    this.callUsage.set(record.callId, { ...record });
  }

  getModelCallUsage(callId: string): ModelCallUsageRecord | null {
    const record = this.callUsage.get(callId);
    return record ? { ...record } : null;
  }

  putModelCallAttemptUsage(record: ModelCallAttemptUsageRecord): void {
    this.attemptUsage.set(record.attemptId, { ...record });
  }

  getModelCallAttemptUsage(attemptId: string): ModelCallAttemptUsageRecord | null {
    const record = this.attemptUsage.get(attemptId);
    return record ? { ...record } : null;
  }

  insertCostAllocation(record: CostAllocationRecord): void {
    this.costAllocations.set(record.id, { ...record });
  }

  listCostAllocations(callId: string): CostAllocationRecord[] {
    return [...this.costAllocations.values()]
      .filter((record) => record.callId === callId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((record) => ({ ...record }));
  }

  listTurnsByStatus(statuses: TurnRecord['status'][]): TurnRecord[] {
    const wanted = new Set(statuses);
    return [...this.turns.values()]
      .filter((record) => wanted.has(record.status))
      .map((record) => ({ ...record }));
  }
}
