import { Injectable, computed, inject, signal } from '@angular/core';
import { createModels } from '@earendil-works/pi-ai';
import type { AuthType, Provider } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { groqProvider } from '@earendil-works/pi-ai/providers/groq';
import { kimiCodingProvider } from '@earendil-works/pi-ai/providers/kimi-coding';
import { minimaxProvider } from '@earendil-works/pi-ai/providers/minimax';
import { moonshotaiProvider } from '@earendil-works/pi-ai/providers/moonshotai';
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { qwenTokenPlanProvider } from '@earendil-works/pi-ai/providers/qwen-token-plan';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import { ApplicationSettings } from '@nativescript/core';
import { ACCOUNT_CATALOG } from './account-catalog';
import { SamAuthInteraction } from './auth-interaction';
import { SettingsCredentialStore } from './credentials';

const PROVIDER_KEY = 'sam.providerId';
const MODEL_KEY = 'sam.modelId';

const PROVIDER_FACTORIES: Record<string, () => Provider> = {
  'openai-codex': openaiCodexProvider,
  xai: xaiProvider,
  minimax: minimaxProvider,
  moonshotai: moonshotaiProvider,
  'kimi-coding': kimiCodingProvider,
  'qwen-token-plan': qwenTokenPlanProvider,
  openrouter: openrouterProvider,
  anthropic: anthropicProvider,
  google: googleProvider,
  openai: openaiProvider,
  deepseek: deepseekProvider,
  groq: groqProvider,
  'opencode-go': opencodeGoProvider,
};

export type ModelChoice = { id: string; name: string };

export type ModelOption = {
  providerId: string;
  modelId: string;
  label: string;
};

export type ProviderState = {
  connected: boolean;
  credentialType: 'oauth' | 'api_key' | null;
  models: ModelChoice[];
};

const EMPTY_STATE: ProviderState = { connected: false, credentialType: null, models: [] };

@Injectable({ providedIn: 'root' })
export class ProviderService {
  private readonly auth = inject(SamAuthInteraction);
  private readonly credentials = new SettingsCredentialStore();
  private readonly models = createModels({
    credentials: this.credentials,
    authContext: {
      env: async () => undefined,
      fileExists: async () => false,
    },
  });

  readonly states = signal<Record<string, ProviderState>>({});
  readonly connectingId = signal<string | null>(null);
  readonly errors = signal<Record<string, string>>({});
  readonly activeProviderId = signal<string | null>(
    ApplicationSettings.getString(PROVIDER_KEY, '') || null,
  );
  readonly activeModelId = signal<string | null>(
    ApplicationSettings.getString(MODEL_KEY, '') || null,
  );

  readonly active = computed(() => {
    const providerId = this.activeProviderId();
    const modelId = this.activeModelId();
    if (!providerId || !modelId || !this.states()[providerId]?.connected) {
      return null;
    }
    const model = this.models.getModel(providerId, modelId);
    const account = ACCOUNT_CATALOG.find((entry) => entry.id === providerId);
    const credentialType = this.states()[providerId]?.credentialType;
    return model
      ? {
          providerId,
          providerAccountId: `provider-account:${providerId}:${credentialType ?? 'unknown'}`,
          providerAccountLabel: account?.name ?? providerId,
          billingMode: (credentialType && account?.billingModes[credentialType]) || 'unknown',
          model,
        }
      : null;
  });

  readonly activeLabel = computed(() => {
    const active = this.active();
    if (!active) {
      return 'Not connected';
    }
    return active.model.name || active.model.id;
  });

  readonly modelOptions = computed(() => {
    const states = this.states();
    const connected = ACCOUNT_CATALOG.filter((entry) => states[entry.id]?.connected);
    const multi = connected.length > 1;
    const options: ModelOption[] = [];
    for (const entry of connected) {
      for (const model of states[entry.id].models) {
        options.push({
          providerId: entry.id,
          modelId: model.id,
          label: multi ? `${entry.name} · ${model.name}` : model.name,
        });
      }
    }
    return options;
  });

  constructor() {
    for (const entry of ACCOUNT_CATALOG) {
      const factory = PROVIDER_FACTORIES[entry.id];
      if (factory) {
        this.models.setProvider(factory());
      }
    }
    void this.refresh();
  }

  get runtime() {
    return this.models;
  }

  state(providerId: string): ProviderState {
    return this.states()[providerId] ?? EMPTY_STATE;
  }

  error(providerId: string): string | null {
    return this.errors()[providerId] ?? null;
  }

  isActive(providerId: string, modelId: string): boolean {
    return this.activeProviderId() === providerId && this.activeModelId() === modelId;
  }

  async refresh(): Promise<void> {
    const next: Record<string, ProviderState> = {};
    for (const entry of ACCOUNT_CATALOG) {
      if (!PROVIDER_FACTORIES[entry.id]) {
        continue;
      }
      const credential = await this.credentials.read(entry.id);
      next[entry.id] = {
        connected: credential !== undefined,
        credentialType: credential?.type ?? null,
        models: this.models.getModels(entry.id).map((model) => ({
          id: model.id,
          name: model.name || model.id,
        })),
      };
    }
    this.states.set(next);

    const current = next[this.activeProviderId() ?? ''];
    const stillValid =
      current?.connected && current.models.some((model) => model.id === this.activeModelId());
    if (!stillValid) {
      this.applyActive(this.firstAvailable(next));
    }
  }

  selectModel(providerId: string, modelId: string): void {
    const state = this.state(providerId);
    if (!state.connected || !state.models.some((model) => model.id === modelId)) {
      return;
    }
    this.applyActive({ providerId, modelId });
  }

  async connect(providerId: string, method: AuthType): Promise<void> {
    if (this.connectingId() || !PROVIDER_FACTORIES[providerId]) {
      return;
    }
    this.connectingId.set(providerId);
    this.setError(providerId, null);
    this.auth.reset();
    try {
      await this.models.login(providerId, method, {
        prompt: (authPrompt) => this.auth.prompt(authPrompt),
        notify: (event) => this.auth.notify(event),
      });
      this.auth.reset();
      await this.refresh();
    } catch (error) {
      this.setError(providerId, error instanceof Error ? error.message : String(error));
    } finally {
      this.connectingId.set(null);
    }
  }

  async disconnect(providerId: string): Promise<void> {
    await this.models.logout(providerId);
    this.setError(providerId, null);
    await this.refresh();
  }

  private applyActive(selection: { providerId: string; modelId: string } | null): void {
    this.activeProviderId.set(selection?.providerId ?? null);
    this.activeModelId.set(selection?.modelId ?? null);
    ApplicationSettings.setString(PROVIDER_KEY, selection?.providerId ?? '');
    ApplicationSettings.setString(MODEL_KEY, selection?.modelId ?? '');
  }

  private firstAvailable(
    states: Record<string, ProviderState>,
  ): { providerId: string; modelId: string } | null {
    for (const entry of ACCOUNT_CATALOG) {
      const state = states[entry.id];
      if (state?.connected && state.models.length) {
        return { providerId: entry.id, modelId: state.models[0].id };
      }
    }
    return null;
  }

  private setError(providerId: string, message: string | null): void {
    this.errors.update((errors) => {
      const next = { ...errors };
      if (message === null) {
        delete next[providerId];
      } else {
        next[providerId] = message;
      }
      return next;
    });
  }
}
