import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { ApplicationSettings } from '@nativescript/core';
import { GenerationManager } from '../generation/generation-manager';
import type { SessionEngine } from './session-engine';
import type { Session } from './types';

const SELECTION_KEY = 'sam.selectedSessionId';

@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly engine: SessionEngine = inject(GenerationManager).sessions;
  private readonly records = signal<Session[]>([]);
  private readonly revision = signal(0);
  private readonly selected = signal<string | null>(null);
  private readonly failure = signal<string | null>(null);

  readonly selectedSessionId = this.selected.asReadonly();
  readonly error = this.failure.asReadonly();
  readonly activeSessions = computed(() => {
    this.revision();
    return this.records().filter((session) => session.state === 'active').map((session) => ({
      ...session,
      runningCount: this.engine.runtimes.count(session.id),
    }));
  });
  readonly archivedSessions = computed(() => this.records().filter((session) => session.state === 'archived'));
  readonly selectedSession = computed(() =>
    this.activeSessions().find((session) => session.id === this.selected()) ?? null,
  );
  readonly runningCount = computed(() => {
    this.revision();
    return this.engine.runtimes.count();
  });

  constructor() {
    const unsubscribe = this.engine.subscribe(() => {
      try {
        this.refresh();
        // Archiving a parent can also remove the selected child from the active list.
        if (this.selected() && !this.selectedSession()) this.ensureSelection();
      } catch (error) {
        this.report(error);
      }
    });
    inject(DestroyRef).onDestroy(unsubscribe);
    let preferred = '';
    try {
      preferred = ApplicationSettings.getString(SELECTION_KEY, '');
    } catch (error) {
      this.report(error);
    }
    try {
      this.refresh();
      this.ensureSelection(preferred);
    } catch (error) {
      this.report(error);
    }
  }

  select(id: string): boolean {
    this.failure.set(null);
    try {
      if (this.engine.get(id)?.state !== 'active') throw new Error('Restore this session before opening it.');
      this.setSelection(id);
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  create(): boolean {
    this.failure.set(null);
    try {
      this.setSelection(this.engine.create({ title: 'SAM' }).id);
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  archive(id: string): boolean {
    this.failure.set(null);
    try {
      this.engine.archive(id);
      return !this.error();
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  restore(id: string): boolean {
    this.failure.set(null);
    try {
      this.setSelection(this.engine.restore(id).id);
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  private refresh(): void {
    this.records.set(this.engine.list());
    this.revision.update((value) => value + 1);
  }

  private ensureSelection(preferred?: string): void {
    const active = this.activeSessions();
    const existing = active.find((session) => session.id === preferred) ?? active[0];
    // Clear an archived selection before create emits synchronously to subscribers.
    this.selected.set(null);
    this.setSelection(existing?.id ?? this.engine.create({ title: 'SAM' }).id);
  }

  private setSelection(id: string): void {
    this.selected.set(id);
    ApplicationSettings.setString(SELECTION_KEY, id);
  }

  private report(error: unknown): void {
    this.failure.set(error instanceof Error ? error.message : 'Unable to update sessions. Please try again.');
  }
}
