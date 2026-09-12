export type SessionState = 'active' | 'archived';

export type Session = {
  id: string;
  title: string | null;
  kind: string;
  state: SessionState;
  ownerAgentId: string | null;
  parentSessionId: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
};

export type SessionPatch = Partial<Pick<Session, 'title' | 'kind' | 'ownerAgentId'>>;
export type CreateSessionInput = SessionPatch & { parentSessionId?: string | null };
export type SessionRecordPatch = SessionPatch & { updatedAt?: number };

export interface SessionRepository {
  createSession(record: Session): Session;
  getSession(id: string): Session | null;
  listSessions(state?: SessionState): Session[];
  updateSession(id: string, patch: SessionRecordPatch): Session;
  listSessionChildren(id: string): Session[];
  /** All IDs must exist; either every update commits or none does. */
  archiveSessions(ids: string[], at: number): void;
  restoreSession(id: string, at: number): Session;
}

export type SessionWork = { id: string; kind: string; cancel: () => void };
export type WorkRegistration = { signal: AbortSignal; finish(): void };
export type SessionRuntime = { readonly signal: AbortSignal };
export interface RuntimeRegistry {
  get(sessionId: string): SessionRuntime | undefined;
  /** Includes cancelled work that has not finished, even from older scopes. */
  count(sessionId?: string): number;
}

export type SessionEvent =
  | { type: 'created' | 'updated' | 'archived' | 'restored'; sessionId: string; session: Session }
  | { type: 'work_started' | 'work_finished'; sessionId: string; workId: string; kind: string }
  | { type: 'runtime_cancelled'; sessionId: string };

export type SessionEngineOptions = { clock?: () => number; id?: () => string };
