import { Injectable, computed, signal } from '@angular/core';
import { ApplicationSettings } from '@nativescript/core';
import { AGENT_CATALOG, agentById, effectivePrompt } from './agents';

const KEY = 'sam.agentPrompts';

@Injectable({ providedIn: 'root' })
export class AgentPromptService {
  private readonly revision = signal(0);

  readonly agents = computed(() => {
    this.revision();
    const stored = load();
    return AGENT_CATALOG.map((agent) => ({
      id: agent.id,
      name: agent.name,
      prompt: effectivePrompt(stored[agent.id], agent.defaultPrompt),
      custom: Boolean(stored[agent.id]?.trim()),
    }));
  });

  get(id: string): string {
    const agent = agentById(id);
    return effectivePrompt(load()[id], agent?.defaultPrompt ?? '');
  }

  save(id: string, prompt: string): void {
    const all = load();
    const trimmed = prompt.trim();
    const fallback = agentById(id)?.defaultPrompt ?? '';
    if (!trimmed || trimmed === fallback) {
      delete all[id];
    } else {
      all[id] = trimmed;
    }
    ApplicationSettings.setString(KEY, JSON.stringify(all));
    this.revision.update((value) => value + 1);
  }

  reset(id: string): void {
    this.save(id, '');
  }
}

function load(): Record<string, string> {
  try {
    return JSON.parse(ApplicationSettings.getString(KEY, '{}')) as Record<string, string>;
  } catch {
    return {};
  }
}
