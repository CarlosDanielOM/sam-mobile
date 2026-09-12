import { ApplicationSettings } from '@nativescript/core';
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';

const KEY = 'sam.credentials';

export class SettingsCredentialStore implements CredentialStore {
  private queue = Promise.resolve();

  async read(providerId: string): Promise<Credential | undefined> {
    return this.load()[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.load()).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const run = this.queue.then(async () => {
      const all = this.load();
      const next = await fn(all[providerId]);
      if (next === undefined) {
        return all[providerId];
      }
      all[providerId] = next;
      this.save(all);
      return next;
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async delete(providerId: string): Promise<void> {
    const run = this.queue.then(async () => {
      const all = this.load();
      delete all[providerId];
      this.save(all);
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  private load(): Record<string, Credential> {
    const raw = ApplicationSettings.getString(KEY, '{}');
    try {
      return JSON.parse(raw) as Record<string, Credential>;
    } catch {
      return {};
    }
  }

  private save(all: Record<string, Credential>): void {
    ApplicationSettings.setString(KEY, JSON.stringify(all));
  }
}
