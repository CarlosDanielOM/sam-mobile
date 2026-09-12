import type { Session, SessionRepository } from '../sessions/types';

export type MessageRole = 'user' | 'assistant';

export type MessageStatus =
  | 'pending'
  | 'streaming'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'cancelled';

export type GenerationStatus =
  | 'queued'
  | 'connecting'
  | 'streaming'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'cancelled';

export type ConversationRecord = Session;

export type MessageRecord = {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  provider: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  payloadJson: string | null;
};

export type GenerationUsage = {
  inputTokens?: number;
  uncachedInputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  requestId?: string;
  finishReason?: string;
  piCost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

export type GenerationRecord = {
  id: string;
  conversationId: string;
  messageId: string;
  status: GenerationStatus;
  provider: string;
  model: string;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  usage: GenerationUsage | null;
};

export type MessagePatch = Partial<
  Pick<MessageRecord, 'content' | 'status' | 'error' | 'payloadJson' | 'updatedAt'>
>;

export type GenerationPatch = Partial<
  Pick<GenerationRecord, 'status' | 'completedAt' | 'error' | 'usage'>
>;

export interface PersistenceApi extends SessionRepository {
  ensureConversation(id: string, title?: string | null): ConversationRecord;
  getConversation(id: string): ConversationRecord | null;
  updateConversationTitle(id: string, title: string, at: number): void;
  touchConversation(id: string, at: number): void;
  insertMessage(message: MessageRecord): void;
  updateMessage(id: string, patch: MessagePatch): void;
  getMessage(id: string): MessageRecord | null;
  listMessages(conversationId: string): MessageRecord[];
  insertGeneration(generation: GenerationRecord): void;
  updateGeneration(id: string, patch: GenerationPatch): void;
  getGeneration(id: string): GenerationRecord | null;
  listGenerationsByStatus(statuses: GenerationStatus[]): GenerationRecord[];
}
