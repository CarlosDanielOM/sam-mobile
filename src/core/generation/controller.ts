import { signal } from '@angular/core';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import type { GenerationStatus } from '../persistence/types';
import { messagesToContext, titleFromText } from './history';
import { createId } from './ids';
import { SessionEngine } from '../sessions/session-engine';
import type { WorkRegistration } from '../sessions/types';
import type {
  BackgroundGenerationPort,
  GenerationControllerDeps,
  GenerationState,
  RetryGenerationInput,
  StartGenerationInput,
} from './types';
import { ACTIVE_GENERATION_STATUSES } from './types';
import { usageFromAssistant } from './usage';
import { DEFAULT_SYSTEM_PROMPT, SAM_AGENT_ID } from '../agents';
import { TelemetryService, type SessionUsageSummary, type TurnUsageDetail } from '../telemetry/telemetry.service';
import { tokenUsageFromAssistant } from '../telemetry/usage';

const DEFAULT_FLUSH_MS = 500;
const DEFAULT_FLUSH_CHARS = 400;
const CANCEL_USAGE_WAIT_MS = 1_000;

type RuntimeTelemetry = {
  callId: string;
  attemptId: string | null;
  turnId: string | null;
  agentRunId: string;
  ownsTurn: boolean;
  ownsAgentRun: boolean;
};

type RuntimeGeneration = {
  abort: AbortController;
  work: WorkRegistration | null;
  state: GenerationState;
  lastFlushAt: number;
  lastFlushLength: number;
  persistedStreaming: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  telemetry: RuntimeTelemetry | null;
};

function providerRequestId(headers: Record<string, string>): string | null {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  for (const name of ['x-request-id', 'request-id', 'openai-request-id', 'x-amzn-requestid', 'cf-ray']) {
    const value = normalized[name];
    if (value) {
      return value;
    }
  }
  return null;
}

function errorDetails(error: unknown): { type: string; code: string | null } {
  if (!(error instanceof Error)) {
    return { type: 'UnknownError', code: null };
  }
  const candidate = error as Error & { code?: unknown; status?: unknown };
  const rawCode = candidate.code ?? candidate.status;
  return {
    type: error.name || 'Error',
    code: typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : null,
  };
}

function resolveSystemPrompt(value?: string): string {
  const text = value?.trim();
  return text ? text : DEFAULT_SYSTEM_PROMPT;
}

function assistantText(result: AssistantMessage): string {
  return result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

export class GenerationController {
  readonly sessions: SessionEngine;
  readonly snapshot = signal<GenerationState[]>([]);
  readonly revision = signal(0);

  private readonly runtime = new Map<string, RuntimeGeneration>();
  private readonly store;
  private readonly streamSimple;
  private readonly foreground: BackgroundGenerationPort;
  private readonly now: () => number;
  private readonly flushEveryMs: number;
  private readonly flushEveryChars: number;
  private readonly isAppVisible: () => boolean;
  private readonly telemetry: TelemetryService | null;

  constructor(deps: GenerationControllerDeps) {
    this.store = deps.store;
    this.streamSimple = deps.streamSimple;
    this.foreground = deps.foreground;
    this.now = deps.now ?? (() => Date.now());
    this.flushEveryMs = deps.flushEveryMs ?? DEFAULT_FLUSH_MS;
    this.flushEveryChars = deps.flushEveryChars ?? DEFAULT_FLUSH_CHARS;
    this.isAppVisible = deps.isAppVisible ?? (() => true);
    this.telemetry = deps.telemetry ?? null;
    this.sessions = deps.sessions ?? new SessionEngine(this.store, { clock: this.now });
    this.telemetry?.ensureAgent({
      id: SAM_AGENT_ID,
      name: 'SAM',
      kind: 'orchestrator',
      persistent: true,
    });
  }

  activeFor(conversationId: string): GenerationState[] {
    return this.snapshot().filter(
      (item) =>
        item.conversationId === conversationId && ACTIVE_GENERATION_STATUSES.includes(item.status),
    );
  }

  usageSummary(conversationId: string): SessionUsageSummary | null {
    return this.telemetry?.getSessionUsageSummary(conversationId) ?? null;
  }

  turnUsage(conversationId: string): TurnUsageDetail | null {
    return this.telemetry?.getTurnUsageDetail(conversationId) ?? null;
  }

  recoverOrphans(): void {
    const orphans = this.store.listGenerationsByStatus(['queued', 'connecting', 'streaming']);
    const at = this.now();
    for (const orphan of orphans) {
      if (this.runtime.has(orphan.id)) {
        continue;
      }
      const message = this.store.getMessage(orphan.messageId);
      this.telemetry?.interruptGeneration(
        orphan.id,
        orphan.error ?? 'Generation was interrupted.',
        at,
      );
      this.store.updateGeneration(orphan.id, {
        status: 'interrupted',
        completedAt: at,
        error: orphan.error ?? 'Generation was interrupted.',
      });
      if (message) {
        this.store.updateMessage(message.id, {
          status: 'interrupted',
          error: message.error ?? 'Generation was interrupted.',
          updatedAt: at,
        });
      }
      this.store.touchConversation(orphan.conversationId, at);
    }
    // The global sweep also closes unattached turns/runs. Only a cold runtime
    // can know those records are orphaned rather than live shared work.
    if (!this.runtime.size) this.telemetry?.recoverOrphans(at);
    this.syncForeground();
    if (orphans.length) {
      this.bump();
    }
  }

  async start(input: StartGenerationInput): Promise<GenerationState> {
    const at = this.now();
    const conversation = this.sessions.requireActive(input.conversationId);
    if (conversation && (!conversation.title || conversation.title === 'SAM')) {
      this.sessions.update(input.conversationId, { title: titleFromText(input.text) });
    }
    this.sessions.requireActive(input.conversationId);

    const userId = createId('msg');
    const assistantId = createId('msg');
    const generationId = createId('gen');

    this.store.insertMessage({
      id: userId,
      conversationId: input.conversationId,
      role: 'user',
      content: input.text,
      status: 'completed',
      provider: null,
      model: null,
      createdAt: at,
      updatedAt: at,
      error: null,
      payloadJson: null,
    });
    this.store.insertMessage({
      id: assistantId,
      conversationId: input.conversationId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      provider: input.providerId,
      model: input.model.id,
      createdAt: at + 1,
      updatedAt: at + 1,
      error: null,
      payloadJson: null,
    });
    this.store.insertGeneration({
      id: generationId,
      conversationId: input.conversationId,
      messageId: assistantId,
      status: 'connecting',
      provider: input.providerId,
      model: input.model.id,
      startedAt: at,
      completedAt: null,
      error: null,
      usage: null,
    });
    this.store.touchConversation(input.conversationId, at);

    const telemetry = () => this.prepareTelemetry(input, {
      generationId,
      messageId: assistantId,
      userMessageId: userId,
      at,
      retryOfMessageId: null,
    });

    const history = messagesToContext(this.store.listMessages(input.conversationId), new Set([assistantId]));
    return this.run(generationId, assistantId, input, history, telemetry);
  }

  async retry(input: RetryGenerationInput): Promise<GenerationState | null> {
    this.sessions.requireActive(input.conversationId);
    const failed = this.store.getMessage(input.messageId);
    if (!failed || failed.conversationId !== input.conversationId || failed.role !== 'assistant') {
      return null;
    }
    if (!['failed', 'interrupted', 'cancelled'].includes(failed.status)) return null;
    const at = this.now();
    const assistantId = createId('msg');
    const generationId = createId('gen');
    this.store.insertMessage({
      id: assistantId,
      conversationId: input.conversationId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      provider: input.providerId,
      model: input.model.id,
      createdAt: at,
      updatedAt: at,
      error: null,
      payloadJson: null,
    });
    this.store.insertGeneration({
      id: generationId,
      conversationId: input.conversationId,
      messageId: assistantId,
      status: 'connecting',
      provider: input.providerId,
      model: input.model.id,
      startedAt: at,
      completedAt: null,
      error: null,
      usage: null,
    });
    this.store.touchConversation(input.conversationId, at);
    const telemetry = () => this.prepareTelemetry(input, {
      generationId,
      messageId: assistantId,
      userMessageId: null,
      at,
      retryOfMessageId: failed.id,
    });
    const exclude = new Set<string>(
      this.store
        .listMessages(input.conversationId)
        .filter((message) => message.createdAt > failed.createdAt || message.id === failed.id)
        .map((message) => message.id),
    );
    exclude.add(assistantId);
    const history = messagesToContext(this.store.listMessages(input.conversationId), exclude);
    return this.run(generationId, assistantId, input, history, telemetry);
  }

  cancel(generationId: string): void {
    this.runtime.get(generationId)?.abort.abort();
  }

  private run(
    generationId: string,
    assistantId: string,
    input: StartGenerationInput | RetryGenerationInput,
    history: Message[],
    prepareTelemetry: () => RuntimeTelemetry | null,
  ): GenerationState {
    const abort = new AbortController();
    const startedAt = this.now();
    const runtime: RuntimeGeneration = {
      abort,
      work: null,
      lastFlushAt: startedAt,
      lastFlushLength: 0,
      persistedStreaming: false,
      timer: null,
      telemetry: null,
      state: {
        id: generationId,
        conversationId: input.conversationId,
        messageId: assistantId,
        provider: input.providerId,
        model: input.model.id,
        modelName: input.model.name || input.model.id,
        status: 'connecting',
        text: '',
        startedAt,
      },
    };
    this.runtime.set(generationId, runtime);
    runtime.work = this.sessions.registerWork(input.conversationId, {
      id: generationId,
      kind: 'generation',
      cancel: () => abort.abort(),
    });
    this.publish();
    this.bump();
    void this.consume(runtime, input, history, prepareTelemetry);
    return runtime.state;
  }

  private async consume(
    runtime: RuntimeGeneration,
    input: StartGenerationInput | RetryGenerationInput,
    history: Message[],
    prepareTelemetry: () => RuntimeTelemetry | null,
  ): Promise<void> {
    let partial: AssistantMessage | undefined;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort!: () => void;
    const cancellation = new Promise<undefined>((resolve) => {
      onAbort = () => {
        cancelTimer = setTimeout(() => resolve(undefined), CANCEL_USAGE_WAIT_MS);
      };
      runtime.abort.signal.addEventListener('abort', onAbort, { once: true });
      if (runtime.abort.signal.aborted) {
        onAbort();
      }
    });
    try {
      if (runtime.abort.signal.aborted) {
        this.finish(runtime, 'cancelled');
        return;
      }
      this.syncForeground();
      runtime.telemetry = prepareTelemetry();
      if (runtime.telemetry && this.telemetry) {
        const attempt = this.telemetry.startAttempt({
          callId: runtime.telemetry.callId,
          providerAccountId: input.providerAccountId ?? `provider-account:${input.providerId}:default`,
          provider: input.providerId,
          model: input.model.id,
        });
        runtime.telemetry.attemptId = attempt.id;
      }
      const stream = this.streamSimple(input.model, { systemPrompt: resolveSystemPrompt(input.systemPrompt), messages: history }, {
        transport: 'sse',
        signal: runtime.abort.signal,
        maxRetries: 0,
        onResponse: (response) => {
          if (runtime.telemetry?.attemptId && this.telemetry) {
            this.telemetry.recordResponse(runtime.telemetry.attemptId, {
              httpStatus: response.status,
              providerRequestId: providerRequestId(response.headers),
            });
          }
        },
      });
      // Aborted streams can still return billable usage. Bound the wait even if
      // the iterator or final result never settles, keeping the last snapshot.
      const result = await Promise.race([
        (async () => {
          for await (const event of stream) {
            partial = event.partial ?? event.message ?? event.error ?? partial;
            if (runtime.abort.signal.aborted) {
              break;
            }
            if (event.type === 'text_delta' && event.delta) {
              if (runtime.telemetry?.attemptId && this.telemetry) {
                this.telemetry.recordToken(runtime.telemetry.callId, runtime.telemetry.attemptId);
              }
              this.append(runtime, event.delta);
            }
          }
          return stream.result();
        })(),
        cancellation,
      ]);
      if (!result || runtime.abort.signal.aborted || result.stopReason === 'aborted') {
        this.finish(runtime, 'cancelled', {
          text: !result || runtime.abort.signal.aborted ? runtime.state.text : assistantText(result) || runtime.state.text,
          result: result ?? partial,
        });
        return;
      }
      const text = assistantText(result) || runtime.state.text;
      if (result.stopReason === 'error') {
        this.finish(runtime, 'failed', {
          text,
          error: result.errorMessage || 'Request failed.',
          result,
        });
        return;
      }
      this.finish(runtime, 'completed', { text, result });
    } catch (error) {
      if (runtime.abort.signal.aborted) {
        this.finish(runtime, 'cancelled', { result: partial });
        return;
      }
      this.finish(runtime, 'failed', {
        error: error instanceof Error ? error.message : String(error),
        cause: error,
        result: partial,
      });
    } finally {
      runtime.abort.signal.removeEventListener('abort', onAbort);
      if (cancelTimer !== undefined) {
        clearTimeout(cancelTimer);
      }
    }
  }

  private append(runtime: RuntimeGeneration, delta: string): void {
    if (this.runtime.get(runtime.state.id) !== runtime) return;
    runtime.state = {
      ...runtime.state,
      status: 'streaming',
      text: runtime.state.text + delta,
    };
    if (!runtime.persistedStreaming) {
      runtime.persistedStreaming = true;
      this.store.updateGeneration(runtime.state.id, { status: 'streaming' });
      this.publish();
      this.flush(runtime);
      return;
    }
    this.publish();
    this.scheduleFlush(runtime);
  }

  private scheduleFlush(runtime: RuntimeGeneration): void {
    const at = this.now();
    const pending = runtime.state.text.length - runtime.lastFlushLength;
    if (at - runtime.lastFlushAt >= this.flushEveryMs || pending >= this.flushEveryChars) {
      this.flush(runtime);
      return;
    }
    if (runtime.timer) {
      return;
    }
    runtime.timer = setTimeout(() => {
      runtime.timer = null;
      if (this.runtime.has(runtime.state.id) && ACTIVE_GENERATION_STATUSES.includes(runtime.state.status)) {
        this.flush(runtime);
      }
    }, this.flushEveryMs);
  }

  private flush(runtime: RuntimeGeneration): void {
    if (runtime.timer) {
      clearTimeout(runtime.timer);
      runtime.timer = null;
    }
    const at = this.now();
    this.store.updateMessage(runtime.state.messageId, {
      content: runtime.state.text,
      status: 'streaming',
      updatedAt: at,
    });
    runtime.lastFlushAt = at;
    runtime.lastFlushLength = runtime.state.text.length;
  }

  private finish(
    runtime: RuntimeGeneration,
    status: Extract<GenerationStatus, 'completed' | 'failed' | 'cancelled'>,
    extras: { text?: string; error?: string; result?: AssistantMessage; cause?: unknown } = {},
  ): void {
    if (this.runtime.get(runtime.state.id) !== runtime) return;
    if (extras.result && status !== 'completed') {
      extras = {
        ...extras,
        result: { ...extras.result, stopReason: status === 'cancelled' ? 'aborted' : 'error' },
      };
    }
    if (runtime.timer) {
      clearTimeout(runtime.timer);
      runtime.timer = null;
    }
    const at = this.now();
    const text = extras.text ?? runtime.state.text;
    const error = extras.error;
    const usage = extras.result ? usageFromAssistant(extras.result) : null;
    const messageStatus = status === 'completed' ? 'completed' : status;
    runtime.state = {
      ...runtime.state,
      status,
      text,
      error,
      usage,
      completedAt: at,
    };
    try {
      this.finishTelemetry(runtime, status, at, extras);
    } catch (telemetryError) {
      console.warn('Telemetry finalization failed.', telemetryError);
    }
    this.store.updateMessage(runtime.state.messageId, {
      content: text,
      status: messageStatus,
      error: error ?? null,
      payloadJson: extras.result ? JSON.stringify(extras.result) : null,
      updatedAt: at,
    });
    this.store.updateGeneration(runtime.state.id, {
      status,
      completedAt: at,
      error: error ?? null,
      usage,
    });
    this.store.touchConversation(runtime.state.conversationId, at);
    this.runtime.delete(runtime.state.id);
    runtime.work?.finish();
    this.publish();
    this.bump();
    this.syncForeground(runtime.state);
  }

  private prepareTelemetry(
    input: StartGenerationInput | RetryGenerationInput,
    ids: {
      generationId: string;
      messageId: string;
      userMessageId: string | null;
      retryOfMessageId: string | null;
      at: number;
    },
  ): RuntimeTelemetry | null {
    if (!this.telemetry) {
      return null;
    }
    const providerAccountId = input.providerAccountId ?? `provider-account:${input.providerId}:default`;
    this.telemetry.ensureProviderAccount({
      id: providerAccountId,
      provider: input.providerId,
      displayLabel: input.providerAccountLabel ?? input.providerId,
      billingMode: input.billingMode ?? 'unknown',
      at: ids.at,
    });

    let turnId: string;
    let agentId: string;
    let agentRunId: string;
    let ownsTurn = false;
    let ownsAgentRun = false;
    let fallbackFromCallId: string | null = null;

    if (input.telemetryContext) {
      turnId = input.telemetryContext.turnId;
      agentId = input.telemetryContext.agentId;
      agentRunId = input.telemetryContext.agentRunId;
    } else {
      const previous = ids.retryOfMessageId
        ? this.telemetry.getModelCallByMessageId(ids.retryOfMessageId)
        : null;
      if (previous) {
        // A retried message keeps its original turn when there is one; legacy or
        // background calls without a turn get a fresh one for the new message.
        if (previous.turnId !== null) {
          turnId = previous.turnId;
          this.telemetry.reopenTurn(turnId);
        } else {
          turnId = this.telemetry.startTurn({
            sessionId: input.conversationId,
            userMessageId: ids.userMessageId,
            startedAt: ids.at,
          }).id;
        }
        fallbackFromCallId = previous.id;
        ownsTurn = true;
      } else {
        turnId = this.telemetry.startTurn({
          sessionId: input.conversationId,
          userMessageId: ids.userMessageId,
          startedAt: ids.at,
        }).id;
        ownsTurn = true;
      }
      agentId = SAM_AGENT_ID;
      agentRunId = this.telemetry.startAgentRun({
        agentId,
        sessionId: input.conversationId,
        turnId,
        purpose: ids.retryOfMessageId ? 'Retry response generation' : 'Respond to user turn',
        spawnReason: ids.retryOfMessageId ? 'user_retry' : 'user_turn',
        startedAt: ids.at,
      }).id;
      ownsAgentRun = true;
    }

    const call = this.telemetry.startModelCall({
      sessionId: input.conversationId,
      turnId,
      messageId: ids.messageId,
      generationId: ids.generationId,
      agentId,
      agentRunId,
      ownsTurn,
      ownsAgentRun,
      parentCallId: input.telemetryContext?.parentCallId ?? null,
      providerAccountId,
      provider: input.providerId,
      model: input.model.id,
      routeReason:
        input.telemetryContext?.routeReason ?? (ids.retryOfMessageId ? 'manual_retry' : 'manually_selected'),
      routePolicyId: input.telemetryContext?.routePolicyId ?? null,
      fallbackFromCallId,
      modelContextLimit:
        typeof (input.model as { contextWindow?: unknown }).contextWindow === 'number'
          ? (input.model as { contextWindow: number }).contextWindow
          : null,
      requestedAt: ids.at,
    });
    return { callId: call.id, attemptId: null, turnId, agentRunId, ownsTurn, ownsAgentRun };
  }

  private finishTelemetry(
    runtime: RuntimeGeneration,
    status: Extract<GenerationStatus, 'completed' | 'failed' | 'cancelled'>,
    at: number,
    extras: { text?: string; error?: string; result?: AssistantMessage; cause?: unknown },
  ): void {
    if (!runtime.telemetry || !this.telemetry) {
      return;
    }
    const details =
      status === 'cancelled'
        ? { type: 'Cancelled', code: null }
        : extras.cause
          ? errorDetails(extras.cause)
          : { type: 'ProviderError', code: null };
    const failureStage = status === 'completed' ? null : runtime.persistedStreaming ? 'stream' : 'request';
    if (runtime.telemetry.attemptId) {
      // Pi prices usage from its model registry (`usage.cost`, in USD). That is
      // API-equivalent value, not a provider-metered charge; the telemetry
      // service only uses it when no configured pricing snapshot applies.
      const registryCost = extras.result?.usage?.cost?.total;
      const usage = extras.result ? tokenUsageFromAssistant(extras.result) : null;
      const registryApiEquivalent =
        usage && typeof registryCost === 'number' && Number.isFinite(registryCost) && registryCost >= 0
          ? Math.round(registryCost * 1_000_000)
          : null;
      this.telemetry.completeAttempt(runtime.telemetry.attemptId, {
        status,
        completedAt: at,
        providerRequestId: extras.result?.responseId ?? null,
        usage,
        finishReason: extras.result?.rawStopReason ?? extras.result?.stopReason ?? null,
        errorType: status === 'completed' ? null : details.type,
        errorCode: status === 'completed' ? null : details.code,
        failureStage,
        apiEquivalentCostMicros: registryApiEquivalent,
        apiEquivalentCurrency: registryApiEquivalent === null ? null : 'USD',
        apiEquivalentCostSource: registryApiEquivalent === null ? null : 'pi_registry_pricing',
        rawMetadata: extras.result
          ? {
              api: extras.result.api,
              provider: extras.result.provider,
              model: extras.result.model,
              responseModel: extras.result.responseModel,
              diagnostics: extras.result.diagnostics,
              endTurn: extras.result.endTurn,
            }
          : null,
      });
    }
    this.telemetry.completeModelCall(runtime.telemetry.callId, {
      status,
      completedAt: at,
      finishReason: extras.result?.rawStopReason ?? extras.result?.stopReason ?? null,
      errorType: status === 'completed' ? null : details.type,
      errorCode: status === 'completed' ? null : details.code,
      failureStage,
    });
    if (runtime.telemetry.ownsAgentRun) {
      this.telemetry.completeAgentRun(runtime.telemetry.agentRunId, status, at);
    }
    if (runtime.telemetry.ownsTurn && runtime.telemetry.turnId !== null) {
      this.telemetry.completeTurn(runtime.telemetry.turnId, status, at);
    }
  }

  private publish(): void {
    this.snapshot.set([...this.runtime.values()].map((item) => item.state));
  }

  private bump(): void {
    this.revision.update((value) => value + 1);
  }

  private syncForeground(terminal?: GenerationState): void {
    const active = [...this.runtime.values()].map((item) => item.state);
    if (active.length) {
      const current = active.length === 1 ? active[0] : undefined;
      this.foreground.start({
        kind: 'thinking',
        generationId: current?.id,
        conversationId: current?.conversationId,
        modelName: current?.modelName,
        activeCount: active.length,
      });
      return;
    }
    if (terminal && !this.isAppVisible() && (terminal.status === 'completed' || terminal.status === 'failed')) {
      this.foreground.update({
        kind: terminal.status,
        generationId: terminal.id,
        conversationId: terminal.conversationId,
      });
      return;
    }
    this.foreground.stop();
  }
}
