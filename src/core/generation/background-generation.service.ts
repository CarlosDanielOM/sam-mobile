import { Injectable } from '@angular/core';
import { isAndroid } from '@nativescript/core';
import { AndroidForegroundService } from './android-foreground';
import { NoopForegroundService } from './noop-foreground';
import type { BackgroundGenerationPort, ForegroundState, ForegroundThinking } from './types';

const port: BackgroundGenerationPort = isAndroid
  ? new AndroidForegroundService()
  : new NoopForegroundService();

@Injectable({ providedIn: 'root' })
export class BackgroundGenerationService implements BackgroundGenerationPort {
  start(state: ForegroundThinking): void {
    port.start(state);
  }

  update(state: ForegroundState): void {
    port.update(state);
  }

  stop(): void {
    port.stop();
  }

  setCancelHandler(handler: (generationId: string) => void): void {
    port.setCancelHandler(handler);
  }
}
