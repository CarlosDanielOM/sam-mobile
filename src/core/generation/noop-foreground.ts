import type { BackgroundGenerationPort, ForegroundState, ForegroundThinking } from './types';

export class NoopForegroundService implements BackgroundGenerationPort {
  start(_state: ForegroundThinking): void {}
  update(_state: ForegroundState): void {}
  stop(): void {}
  setCancelHandler(_handler: (generationId: string) => void): void {}
}
