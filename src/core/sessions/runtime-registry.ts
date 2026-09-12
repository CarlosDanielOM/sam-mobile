import type { RuntimeRegistry, SessionRuntime, SessionWork, WorkRegistration } from './types';

type Scope = { controller: AbortController; runtime: SessionRuntime };
type Entry = { sessionId: string; scope: Scope; work: SessionWork };

export class SessionRuntimeRegistry implements RuntimeRegistry {
  private readonly scopes = new Map<string, Scope>();
  private readonly work = new Set<Entry>();

  get(sessionId: string): SessionRuntime | undefined {
    return this.scopes.get(sessionId)?.runtime;
  }

  count(sessionId?: string): number {
    return sessionId === undefined
      ? this.work.size
      : [...this.work].filter((entry) => entry.sessionId === sessionId).length;
  }

  ensure(sessionId: string): SessionRuntime {
    let scope = this.scopes.get(sessionId);
    if (!scope || scope.controller.signal.aborted) {
      const controller = new AbortController();
      scope = { controller, runtime: Object.freeze({ signal: controller.signal }) };
      this.scopes.set(sessionId, scope);
    }
    return scope.runtime;
  }

  register(sessionId: string, work: SessionWork, onFinish: () => void): WorkRegistration {
    const runtime = this.ensure(sessionId);
    const scope = this.scopes.get(sessionId)!;
    if ([...this.work].some((entry) => entry.scope === scope && entry.work.id === work.id)) {
      throw new Error(`Work already registered: ${work.id}`);
    }
    const entry = { sessionId, scope, work: { ...work } };
    this.work.add(entry);
    return {
      signal: runtime.signal,
      finish: () => {
        if (this.work.delete(entry)) onFinish();
      },
    };
  }

  cancel(sessionIds: string[], onCancel: (sessionId: string) => void): void {
    const scopes = new Set<Scope>();
    const cancelled: string[] = [];
    for (const id of sessionIds) {
      const scope = this.scopes.get(id);
      if (scope && !scope.controller.signal.aborted) {
        scopes.add(scope);
        cancelled.push(id);
      }
    }
    const entries = [...this.work].filter((entry) => scopes.has(entry.scope));
    for (const scope of scopes) scope.controller.abort();
    for (const entry of entries) {
      try {
        entry.work.cancel();
      } catch {
        // One consumer must not prevent the remaining work from being cancelled.
      }
    }
    for (const id of cancelled) onCancel(id);
  }
}
