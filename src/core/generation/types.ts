import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ProviderResponse,
} from '@earendil-works/pi-ai';
import type { GenerationStatus, GenerationUsage, PersistenceApi } from '../persistence/types';
import type { BillingMode } from '../telemetry/types';
import type { TelemetryService } from '../telemetry/telemetry.service';
import type { SessionEngine } from '../sessions/session-engine';

export type GenerationState = {
  id: string;
  conversationId: string;
  messageId: string;
  provider: string;
  model: string;
  modelName?: string;
  status: GenerationStatus;
  text: string;
  error?: string;
  usage?: GenerationUsage | null;
  startedAt: number;
  completedAt?: number;
};

export type StartGenerationInput = {
  conversationId: string;
  text: string;
  providerId: string;
  providerAccountId?: string;
  providerAccountLabel?: string;
  billingMode?: BillingMode;
  model: Model<Api>;
  systemPrompt?: string;
  telemetryContext?: GenerationTelemetryContext;
};

export type RetryGenerationInput = {
  conversationId: string;
  messageId: string;
  providerId: string;
  providerAccountId?: string;
  providerAccountLabel?: string;
  billingMode?: BillingMode;
  model: Model<Api>;
  systemPrompt?: string;
  telemetryContext?: GenerationTelemetryContext;
};

export type GenerationTelemetryContext = {
  turnId: string;
  agentId: string;
  agentRunId: string;
  parentCallId?: string | null;
  routeReason?: string | null;
  routePolicyId?: string | null;
};

export type StreamSimpleFn = (
  model: Model<Api>,
  context: Context,
  options: {
    transport: 'sse';
    signal: AbortSignal;
    maxRetries?: number;
    onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
  },
) => AsyncIterable<{
  type: string;
  delta?: string;
  partial?: AssistantMessage;
  message?: AssistantMessage;
  error?: AssistantMessage;
}> & {
  result(): Promise<AssistantMessage>;
};

export type ForegroundThinking = {
  kind: 'thinking';
  generationId?: string;
  conversationId?: string;
  modelName?: string;
  activeCount: number;
};

export type ForegroundTerminal = {
  kind: 'completed' | 'failed';
  generationId: string;
  conversationId: string;
};

export type ForegroundIdle = { kind: 'idle' };

export type ForegroundState = ForegroundThinking | ForegroundTerminal | ForegroundIdle;

export interface BackgroundGenerationPort {
  start(state: ForegroundThinking): void;
  update(state: ForegroundState): void;
  stop(): void;
  setCancelHandler(handler: (generationId: string) => void): void;
}

export type GenerationControllerDeps = {
  store: PersistenceApi;
  sessions?: SessionEngine;
  streamSimple: StreamSimpleFn;
  foreground: BackgroundGenerationPort;
  now?: () => number;
  flushEveryMs?: number;
  flushEveryChars?: number;
  isAppVisible?: () => boolean;
  telemetry?: TelemetryService;
};

export const ACTIVE_GENERATION_STATUSES: GenerationStatus[] = ['queued', 'connecting', 'streaming'];
