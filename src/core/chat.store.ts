import { Injectable, computed, inject, signal } from '@angular/core';
import { AgentPromptService } from './agent-prompt.service';
import { SAM_AGENT_ID } from './agents';
import { GenerationManager } from './generation/generation-manager';
import type { GenerationState } from './generation/types';
import { persistence } from './persistence/store';
import type { MessageRecord, MessageStatus } from './persistence/types';
import { ProviderService } from './provider.service';
import { SessionStore } from './sessions/session-store';
import type { SessionUsageSummary } from './telemetry/telemetry.service';
import { formatTokens, formatTurnUsage, type TurnUsageView } from './turn-usage';

export type ChatBubble = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status: MessageStatus;
  error: string | null;
};

function toBubble(message: MessageRecord): ChatBubble {
  return {
    id: message.id,
    role: message.role,
    text: message.content,
    status: message.status,
    error: message.error,
  };
}

function liveStatus(status: GenerationState['status']): MessageStatus {
  if (status === 'queued' || status === 'connecting') {
    return 'streaming';
  }
  return status;
}

function statusLabel(status: MessageStatus): string | null {
  if (status === 'interrupted') {
    return 'Interrupted';
  }
  if (status === 'failed') {
    return "Couldn't finish";
  }
  if (status === 'cancelled') {
    return 'Cancelled';
  }
  return null;
}

export type UsageSummaryView = {
  tokens: string;
  cost: string | null;
  context: string | null;
  contextPercent: number | null;
};

function formatUsageSummary(summary: SessionUsageSummary | null): UsageSummaryView | null {
  if (!summary) {
    return null;
  }
  const tokens = `${formatTokens(summary.inputTokens)} in · ${formatTokens(summary.cacheReadTokens)} cache · ${formatTokens(summary.outputTokens)} out`;
  const context =
    summary.contextPercent === null
      ? null
      : `${Number.isInteger(summary.contextPercent) ? summary.contextPercent : summary.contextPercent.toFixed(1)}%`;
  if (summary.costMicros === null) {
    return { tokens, cost: null, context, contextPercent: summary.contextPercent };
  }
  const amount = summary.costMicros / 1_000_000;
  const text =
    amount >= 0.01
      ? amount.toFixed(2)
      : amount >= 0.0001
        ? amount.toFixed(4)
        : amount.toFixed(6);
  const suffix = summary.hasUnknownCost ? '+' : '';
  const cost =
    !summary.currency || summary.currency === 'USD'
      ? `$${text}${suffix}`
      : `${text}${suffix} ${summary.currency}`;
  return { tokens, cost, context, contextPercent: summary.contextPercent };
}

@Injectable({ providedIn: 'root' })
export class ChatStore {
  private readonly providers = inject(ProviderService);
  private readonly generations = inject(GenerationManager);
  private readonly prompts = inject(AgentPromptService);
  private readonly store = persistence();
  readonly sessions = inject(SessionStore);
  readonly conversationId = this.sessions.selectedSessionId;

  private readonly drafts = signal<Record<string, string>>({});
  private readonly errors = signal<Record<string, string | null>>({});
  private readonly pending = signal<ReadonlySet<string>>(new Set());
  readonly draft = computed(() => {
    const id = this.conversationId();
    return id ? this.drafts()[id] ?? '' : '';
  });
  readonly error = computed(() => {
    const id = this.conversationId();
    return id ? this.errors()[id] ?? null : null;
  });

  private readonly persisted = computed(() => {
    const id = this.conversationId();
    this.generations.revision();
    return id ? this.store.listMessages(id).map(toBubble) : [];
  });

  readonly messages = computed(() => {
    const id = this.conversationId();
    const live = this.generations.snapshot().filter((item) => item.conversationId === id);
    if (!id) return [];
    const byMessage = new Map<string, GenerationState>(live.map((item) => [item.messageId, item]));
    return this.persisted().map((message) => {
      const current = byMessage.get(message.id);
      return current ? {
        ...message,
        text: current.text || message.text,
        status: liveStatus(current.status),
        error: current.error ?? message.error,
      } : message;
    });
  });

  readonly sending = computed(() => {
    const id = this.conversationId();
    return !!id && (this.pending().has(id) || this.generations
      .snapshot()
      .some(
        (item) =>
          item.conversationId === id &&
          (item.status === 'queued' || item.status === 'connecting' || item.status === 'streaming'),
      ));
  });

  readonly usageSummary = computed(() => {
    const id = this.conversationId();
    this.generations.revision();
    return id ? formatUsageSummary(this.generations.usageSummary(id)) : null;
  });

  readonly turnUsage = computed((): TurnUsageView | null => {
    const id = this.conversationId();
    this.generations.revision();
    const detail = id ? this.generations.turnUsage(id) : null;
    if (!detail) {
      return null;
    }
    const modelName = this.providers.runtime.getModel(detail.providerId, detail.modelId)?.name ?? null;
    return formatTurnUsage(detail, modelName);
  });

  setDraft(text: string): void {
    const id = this.conversationId();
    if (id) this.drafts.update((drafts) => ({ ...drafts, [id]: text }));
  }

  async send(): Promise<void> {
    const conversationId = this.conversationId();
    const text = this.draft().trim();
    if (!conversationId || !text || this.sending()) {
      return;
    }
    const active = this.providers.active();
    if (!active) {
      this.setError(conversationId, 'Connect a provider first.');
      return;
    }
    this.setDraft('');
    this.setError(conversationId, null);
    this.pending.update((ids) => new Set(ids).add(conversationId));
    try {
      await this.generations.start({
        conversationId,
        text,
        providerId: active.providerId,
        providerAccountId: active.providerAccountId,
        providerAccountLabel: active.providerAccountLabel,
        billingMode: active.billingMode,
        model: active.model,
        systemPrompt: this.prompts.get(SAM_AGENT_ID),
      });
    } catch (error) {
      this.setError(conversationId, error instanceof Error ? error.message : 'Unable to send. Please try again.');
      this.drafts.update((drafts) => ({ ...drafts, [conversationId]: drafts[conversationId] || text }));
    } finally {
      this.pending.update((ids) => new Set([...ids].filter((id) => id !== conversationId)));
    }
  }

  cancel(): void {
    const id = this.conversationId();
    if (!id) return;
    try {
      for (const item of this.generations.activeFor(id)) this.generations.cancel(item.id);
    } catch (error) {
      this.setError(id, error instanceof Error ? error.message : 'Unable to stop generation.');
    }
  }

  async retry(messageId: string): Promise<void> {
    const conversationId = this.conversationId();
    if (!conversationId || this.sending()) {
      return;
    }
    const active = this.providers.active();
    if (!active) {
      this.setError(conversationId, 'Connect a provider first.');
      return;
    }
    this.setError(conversationId, null);
    this.pending.update((ids) => new Set(ids).add(conversationId));
    try {
      await this.generations.retry({
        conversationId,
        messageId,
        providerId: active.providerId,
        providerAccountId: active.providerAccountId,
        providerAccountLabel: active.providerAccountLabel,
        billingMode: active.billingMode,
        model: active.model,
        systemPrompt: this.prompts.get(SAM_AGENT_ID),
      });
    } catch (error) {
      this.setError(conversationId, error instanceof Error ? error.message : 'Unable to retry. Please try again.');
    } finally {
      this.pending.update((ids) => new Set([...ids].filter((id) => id !== conversationId)));
    }
  }

  private setError(id: string, error: string | null): void {
    this.errors.update((errors) => ({ ...errors, [id]: error }));
  }

  labelFor(message: ChatBubble): string | null {
    return statusLabel(message.status);
  }

  canRetry(message: ChatBubble): boolean {
    return (
      message.role === 'assistant' &&
      (message.status === 'interrupted' || message.status === 'failed' || message.status === 'cancelled')
    );
  }
}
