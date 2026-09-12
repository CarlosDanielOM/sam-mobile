import { createId } from '../generation/ids';
import { SessionRuntimeRegistry } from './runtime-registry';
import type {
  CreateSessionInput, RuntimeRegistry, Session, SessionEngineOptions, SessionEvent,
  SessionPatch, SessionRepository, SessionState, SessionWork, WorkRegistration,
} from './types';

export class SessionEngine {
  private readonly repository: SessionRepository;
  private readonly clock: () => number;
  private readonly id: () => string;
  private readonly registry = new SessionRuntimeRegistry();
  readonly runtimes: RuntimeRegistry = this.registry;
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly archiving = new Set<string>();

  constructor(repository: SessionRepository, options: SessionEngineOptions = {}) {
    this.repository = repository;
    this.clock = options.clock ?? Date.now;
    this.id = options.id ?? (() => createId('session'));
  }

  create(input: CreateSessionInput = {}): Session {
    if (input.parentSessionId != null) this.requireActive(input.parentSessionId);
    const at = this.clock();
    const session = this.repository.createSession({
      id: this.id(), title: input.title ?? null, kind: input.kind ?? 'chat', state: 'active',
      ownerAgentId: input.ownerAgentId ?? null, parentSessionId: input.parentSessionId ?? null,
      createdAt: at, updatedAt: at, archivedAt: null,
    });
    this.registry.ensure(session.id);
    this.emit({ type: 'created', sessionId: session.id, session });
    return session;
  }

  get(id: string): Session | null { return this.repository.getSession(id); }
  list(state?: SessionState): Session[] { return this.repository.listSessions(state); }

  update(id: string, patch: SessionPatch): Session {
    const session = this.repository.updateSession(id, { ...patch, updatedAt: this.clock() });
    this.emit({ type: 'updated', sessionId: id, session });
    return session;
  }

  archive(id: string): Session {
    const root = this.require(id);
    if (this.archiving.has(id)) return root;
    const sessions = new Map<string, Session>([[id, root]]);
    for (const session of sessions.values()) {
      for (const child of this.repository.listSessionChildren(session.id)) sessions.set(child.id, child);
    }
    const ids = [...sessions.keys()];
    if (ids.some((sessionId) => this.archiving.has(sessionId))) {
      throw new Error(`Session subtree is being archived: ${id}`);
    }
    for (const sessionId of ids) this.archiving.add(sessionId);
    try {
      const at = this.clock();
      this.repository.archiveSessions(ids, at);
      this.registry.cancel(ids, (sessionId) => this.emit({ type: 'runtime_cancelled', sessionId }));
      for (const session of sessions.values()) {
        if (session.state !== 'archived') {
          this.emit({ type: 'archived', sessionId: session.id, session: this.require(session.id) });
        }
      }
      return this.require(id);
    } finally {
      for (const sessionId of ids) this.archiving.delete(sessionId);
    }
  }

  restore(id: string): Session {
    const existing = this.require(id);
    if (this.archiving.has(id)) throw new Error(`Session is being archived: ${id}`);
    if (existing.parentSessionId !== null) this.requireActive(existing.parentSessionId);
    const session = existing.state === 'active' ? existing : this.repository.restoreSession(id, this.clock());
    this.registry.ensure(id);
    if (existing.state !== 'active') this.emit({ type: 'restored', sessionId: id, session });
    return session;
  }

  requireActive(id: string): Session {
    const session = this.require(id);
    let current = session;
    const seen = new Set<string>();
    while (true) {
      if (seen.has(current.id)) throw new Error(`Session ancestry cycle: ${current.id}`);
      seen.add(current.id);
      if (current.state !== 'active' || this.archiving.has(current.id)) {
        throw new Error(`Session is archived: ${current.id}`);
      }
      if (current.parentSessionId === null) break;
      current = this.require(current.parentSessionId);
    }
    this.registry.ensure(id);
    return session;
  }

  registerWork(sessionId: string, work: SessionWork): WorkRegistration {
    this.requireActive(sessionId);
    const { id: workId, kind } = work;
    const registration = this.registry.register(sessionId, work, () =>
      this.emit({ type: 'work_finished', sessionId, workId, kind }));
    this.emit({ type: 'work_started', sessionId, workId, kind });
    return registration;
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private require(id: string): Session {
    const session = this.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    return session;
  }

  private emit(event: SessionEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener('session' in event ? { ...event, session: { ...event.session } } : { ...event });
      } catch {
        // Observers cannot interrupt persistence or runtime cleanup.
      }
    }
  }
}
