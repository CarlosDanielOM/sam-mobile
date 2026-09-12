import { Injectable, inject, type Signal } from '@angular/core';
import { Application } from '@nativescript/core';
import { persistence } from '../persistence/store';
import { ProviderService } from '../provider.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import { BackgroundGenerationService } from './background-generation.service';
import { obtainGenerationRuntime } from './runtime';
import type { GenerationState, RetryGenerationInput, StartGenerationInput } from './types';
import type { SessionEngine } from '../sessions/session-engine';

let appVisible = true;
let visibilityBound = false;

function bindVisibility(): void {
  if (visibilityBound) {
    return;
  }
  visibilityBound = true;
  Application.on(Application.suspendEvent, () => {
    appVisible = false;
  });
  Application.on(Application.resumeEvent, () => {
    appVisible = true;
  });
}

@Injectable({ providedIn: 'root' })
export class GenerationManager {
  private readonly controller;
  readonly snapshot: Signal<GenerationState[]>;
  readonly revision: Signal<number>;
  readonly sessions: SessionEngine;

  constructor() {
    const providers = inject(ProviderService);
    const foreground = inject(BackgroundGenerationService);
    bindVisibility();
    const store = persistence();
    this.controller = obtainGenerationRuntime({
      store,
      streamSimple: (model, context, options) =>
        providers.runtime.streamSimple(model, context, options),
      foreground,
      telemetry: new TelemetryService(store.telemetry),
      isAppVisible: () => appVisible,
    });
    this.snapshot = this.controller.snapshot;
    this.revision = this.controller.revision;
    this.sessions = this.controller.sessions;
  }

  start(input: StartGenerationInput) {
    return this.controller.start(input);
  }

  retry(input: RetryGenerationInput) {
    return this.controller.retry(input);
  }

  cancel(generationId: string): void {
    this.controller.cancel(generationId);
  }

  activeFor(conversationId: string) {
    return this.controller.activeFor(conversationId);
  }

  usageSummary(conversationId: string) {
    return this.controller.usageSummary(conversationId);
  }

  turnUsage(conversationId: string) {
    return this.controller.turnUsage(conversationId);
  }
}
