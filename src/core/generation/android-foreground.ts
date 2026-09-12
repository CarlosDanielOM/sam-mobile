import { Application, Utils } from '@nativescript/core';
import type { BackgroundGenerationPort, ForegroundState, ForegroundThinking } from './types';

declare const android: any;
declare const org: any;

const SERVICE = 'org.nativescript.nativesam.generation.GenerationForegroundService';
const ACTION_START = 'org.nativescript.nativesam.generation.START';
const ACTION_UPDATE = 'org.nativescript.nativesam.generation.UPDATE';
const ACTION_COMPLETE = 'org.nativescript.nativesam.generation.COMPLETE';
const ACTION_FAILED = 'org.nativescript.nativesam.generation.FAILED';
const ACTION_STOP = 'org.nativescript.nativesam.generation.STOP';

function ctx(): any {
  return Utils.android.getApplicationContext();
}

function serviceIntent(action: string): any {
  const next = new android.content.Intent();
  next.setClassName(ctx(), SERVICE);
  next.setAction(action);
  return next;
}

function startExisting(intent: any): void {
  ctx().startService(intent);
}

function startForeground(intent: any): void {
  if (android.os.Build.VERSION.SDK_INT >= 26) {
    ctx().startForegroundService(intent);
  } else {
    ctx().startService(intent);
  }
}

function requestNotificationPermission(): void {
  if (android.os.Build.VERSION.SDK_INT < 33) {
    return;
  }
  const activity = Application.android?.foregroundActivity;
  if (!activity) {
    return;
  }
  const permission = 'android.permission.POST_NOTIFICATIONS';
  if (activity.checkSelfPermission(permission) === android.content.pm.PackageManager.PERMISSION_GRANTED) {
    return;
  }
  const perms = (Array as unknown as { create(type: string, length: number): any }).create(
    'java.lang.String',
    1,
  );
  perms[0] = permission;
  activity.requestPermissions(perms, 4201);
}

function thinkingText(state: ForegroundThinking): { title: string; text: string } {
  if (state.activeCount > 1) {
    return {
      title: `SAM - ${state.activeCount} tasks running`,
      text: 'Working on your requests',
    };
  }
  return { title: 'SAM is thinking…', text: state.modelName ? String(state.modelName) : '' };
}

export class AndroidForegroundService implements BackgroundGenerationPort {
  private running = false;
  private cancelHandler: ((generationId: string) => void) | null = null;
  private listening = false;

  start(state: ForegroundThinking): void {
    this.ensureListener();
    requestNotificationPermission();
    const copy = thinkingText(state);
    const intent = serviceIntent(this.running ? ACTION_UPDATE : ACTION_START);
    intent.putExtra('title', copy.title);
    intent.putExtra('text', copy.text);
    const generationId = state.activeCount === 1 && state.generationId?.trim()
      ? state.generationId : undefined;
    if (state.activeCount === 1 && state.conversationId) {
      intent.putExtra('sam.conversationId', state.conversationId);
    }
    if (generationId) {
      intent.putExtra('sam.generationId', generationId);
    }
    intent.putExtra('showCancel', !!generationId);
    if (this.running) {
      startExisting(intent);
    } else {
      startForeground(intent);
      this.running = true;
    }
  }

  update(state: ForegroundState): void {
    if (state.kind === 'thinking') {
      this.start(state);
      return;
    }
    if (state.kind === 'idle') {
      this.stop();
      return;
    }
    if (!this.running) {
      const done = serviceIntent(state.kind === 'failed' ? ACTION_FAILED : ACTION_COMPLETE);
      done.putExtra('sam.conversationId', state.conversationId);
      done.putExtra('sam.generationId', state.generationId);
      startExisting(done);
      return;
    }
    const intent = serviceIntent(state.kind === 'failed' ? ACTION_FAILED : ACTION_COMPLETE);
    intent.putExtra('sam.conversationId', state.conversationId);
    intent.putExtra('sam.generationId', state.generationId);
    startExisting(intent);
    this.running = false;
  }

  stop(): void {
    if (!this.running) {
      return;
    }
    startExisting(serviceIntent(ACTION_STOP));
    this.running = false;
  }

  setCancelHandler(handler: (generationId: string) => void): void {
    this.cancelHandler = handler;
    this.ensureListener();
  }

  private ensureListener(): void {
    if (this.listening) {
      return;
    }
    this.listening = true;
    org.nativescript.nativesam.generation.GenerationForegroundService.setListener(
      new org.nativescript.nativesam.generation.GenerationServiceListener({
        onCancel: (generationId?: string) => {
          if (generationId?.trim()) {
            this.cancelHandler?.(generationId);
          }
        },
      }),
    );
  }
}
