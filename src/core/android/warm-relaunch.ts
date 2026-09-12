import { Application, isAndroid } from '@nativescript/core';
import { createWarmWindowContentResolver } from './window-content-resolver';

const TAG = 'SAM-LIFECYCLE';

function log(message: string): void {
  console.log(`${TAG} ${message}`);
}

export function installWarmActivityRelaunch(): void {
  if (!isAndroid) {
    return;
  }
  const resolve = createWarmWindowContentResolver((request: { android?: { intent?: unknown; savedInstanceState?: unknown } }) => {
    log('window-content warm-relaunch');
    const args: { eventName: string; object: typeof Application; android?: unknown; savedInstanceState?: unknown; root?: unknown } = {
      eventName: Application.launchEvent,
      object: Application,
      android: request.android?.intent,
      savedInstanceState: request.android?.savedInstanceState,
    };
    Application.notify(args);
    return args.root ?? null;
  });
  Application.setWindowContentResolver((request) => {
    const content = resolve(request);
    if (content === undefined) {
      log('window-content first-launch');
    }
    return content;
  });
  Application.on(Application.launchEvent, () => {
    log('launch');
  });
  Application.on(Application.exitEvent, () => {
    log('exit');
  });
  const androidApp = Application.android;
  if (!androidApp) {
    return;
  }
  androidApp.on(androidApp.activityCreatedEvent, (args) => {
    log(`activityCreated hash=${args.activity?.hashCode?.()}`);
  });
  androidApp.on(androidApp.activityDestroyedEvent, (args) => {
    log(`activityDestroyed finishing=${args.activity?.isFinishing?.()} hash=${args.activity?.hashCode?.()}`);
  });
}
