import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { mock, test } from 'node:test';
import { Injector, signal } from '@angular/core';
import { Subject } from 'rxjs';
import ts from 'typescript';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/session-notification-navigation.ts')) {
      return {
        format: 'module', shortCircuit: true,
        source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, experimentalDecorators: true },
        }).outputText,
      };
    }
    return nextLoad(url, context);
  },
});

function events() {
  const listeners = new Map<string, Set<(args: any) => void>>();
  return {
    on(name: string, callback: (args: any) => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(callback);
    },
    off(name: string, callback: (args: any) => void) { listeners.get(name)?.delete(callback); },
    emit(name: string, args: any = {}) { listeners.get(name)?.forEach((callback) => callback(args)); },
    count: () => [...listeners.values()].reduce((count, callbacks) => count + callbacks.size, 0),
  };
}

const androidApp = { ...events(), activityNewIntentEvent: 'activityNewIntent',
  startActivity: null as any, foregroundActivity: null as any };
const Application = { ...events(), android: androidApp, launchEvent: 'launch', resumeEvent: 'resume' };
class Router {}
class NavigationEnd {}
class RouterExtensions {}
class SessionStore {}
mock.module('@nativescript/core', { namedExports: { Application, isAndroid: true } });
mock.module('@nativescript/angular', { namedExports: { RouterExtensions } });
mock.module('@angular/router', { namedExports: { Router, NavigationEnd } });
mock.module('../sessions/session-store.ts', { namedExports: { SessionStore } });
const { SessionNotificationNavigation } = await import('./session-notification-navigation.ts');

const EXTRA = 'sam.conversationId';
function intent(id?: string) {
  const extras = new Map(id === undefined ? [] : [[EXTRA, id]]);
  return {
    hasExtra: (key: string) => extras.has(key),
    getStringExtra: (key: string) => extras.get(key) ?? null,
    removeExtra: mock.fn((key: string) => { extras.delete(key); }),
  };
}

function setup(t: { after: (fn: () => void) => void }, launch = intent(), navigated = true, url = '/providers') {
  androidApp.startActivity = { getIntent: () => launch };
  androidApp.foregroundActivity = null;
  const selectedSessionId = signal('saved');
  const activeSessions = signal([{ id: 'saved' }, { id: 'target' }, { id: 'other' }]);
  const forbidden = mock.fn(() => { throw new Error('Notification navigation must not operate the runtime or restore/create sessions'); });
  const sessions = {
    selectedSessionId, activeSessions,
    select: mock.fn((id: string) => { selectedSessionId.set(id); return true; }),
    restore: forbidden, create: forbidden, requireActive: forbidden, cancel: forbidden,
  };
  const router = {
    navigated, url, events: new Subject<unknown>(),
    isActive: mock.fn((path: string, _options: unknown) => router.url.split(/[?#]/)[0] === path),
  };
  const navigation = { navigate: mock.fn(async (_commands: string[], _extras: unknown) => true) };
  const injector = Injector.create({ providers: [
    { provide: SessionStore, useValue: sessions },
    { provide: Router, useValue: router },
    { provide: RouterExtensions, useValue: navigation },
    { provide: SessionNotificationNavigation, useFactory: () => new SessionNotificationNavigation() },
  ] });
  injector.get(SessionNotificationNavigation);
  t.after(() => {
    if (!injector.destroyed) injector.destroy();
    assert.equal(forbidden.mock.callCount(), 0);
    assert.equal(Application.count(), 0);
    assert.equal(androidApp.count(), 0);
    assert.equal(router.events.observed, false);
  });
  const endNavigation = (path: string) => {
    router.url = path;
    router.navigated = true;
    router.events.next(new NavigationEnd());
  };
  return { sessions, router, navigation, injector, endNavigation };
}

test('cold constructor launch overrides saved selection once without racing the initial chat redirect', (t) => {
  const launch = intent('target');
  const { sessions, navigation, endNavigation } = setup(t, launch, false, '/');
  assert.equal(sessions.selectedSessionId(), 'target');
  assert.equal(launch.hasExtra(EXTRA), false);
  assert.equal(navigation.navigate.mock.callCount(), 0);
  endNavigation('/chat');
  assert.equal(navigation.navigate.mock.callCount(), 0);
  sessions.selectedSessionId.set('other');
  Application.emit('resume');
  androidApp.emit('activityNewIntent', { intent: launch });
  assert.equal(sessions.selectedSessionId(), 'other');
  assert.equal(sessions.select.mock.callCount(), 1);
  assert.equal(launch.removeExtra.mock.callCount(), 1);
});

test('pending cold launch navigates only after initial navigation and only once', (t) => {
  const { sessions, navigation, endNavigation } = setup(t, intent('target'), false, '/');
  assert.equal(navigation.navigate.mock.callCount(), 0);
  endNavigation('/agents');
  assert.equal(sessions.selectedSessionId(), 'target');
  assert.deepEqual(navigation.navigate.mock.calls[0].arguments, [['/chat'], { clearHistory: true }]);
  endNavigation('/chat');
  assert.equal(navigation.navigate.mock.callCount(), 1);
});

test('warm Activity launch uses event intent and consumes duplicate new-intent/resume delivery', (t) => {
  const { sessions, navigation } = setup(t);
  const launch = intent('target');
  Application.emit('launch', { android: launch });
  androidApp.foregroundActivity = { getIntent: () => launch };
  androidApp.emit('activityNewIntent', { intent: launch });
  Application.emit('resume', { android: androidApp.foregroundActivity });
  assert.equal(sessions.selectedSessionId(), 'target');
  assert.equal(sessions.select.mock.callCount(), 1);
  assert.equal(navigation.navigate.mock.callCount(), 1);
  assert.equal(launch.removeExtra.mock.callCount(), 1);
});

test('new-intent selects active target on chat without navigation; a fresh tap can select it again', (t) => {
  const { sessions, navigation } = setup(t, intent(), true, '/chat?view=latest#bottom');
  const incoming = intent('target');
  androidApp.emit('activityNewIntent', { intent: incoming });
  sessions.selectedSessionId.set('other');
  androidApp.emit('activityNewIntent', { intent: incoming });
  assert.equal(sessions.selectedSessionId(), 'other');
  androidApp.emit('activityNewIntent', { intent: intent('target') });
  assert.equal(sessions.selectedSessionId(), 'target');
  assert.equal(sessions.select.mock.callCount(), 2);
  assert.equal(navigation.navigate.mock.callCount(), 0);
});

test('resume catches an unhandled Activity intent, preferring foreground over start Activity', (t) => {
  const { sessions, navigation } = setup(t);
  const incoming = intent('target');
  androidApp.foregroundActivity = { getIntent: () => incoming };
  Application.emit('resume');
  sessions.selectedSessionId.set('other');
  Application.emit('resume');
  assert.equal(sessions.selectedSessionId(), 'other');
  assert.equal(sessions.select.mock.callCount(), 1);
  assert.equal(navigation.navigate.mock.callCount(), 1);
  assert.equal(incoming.removeExtra.mock.callCount(), 1);
});

test('summary, empty, unknown and archived targets leave selection and navigation unchanged', (t) => {
  const { sessions, navigation } = setup(t, intent('archived'));
  for (const id of [undefined, '', 'missing', 'archived']) {
    const incoming = intent(id);
    androidApp.emit('activityNewIntent', { intent: incoming });
    Application.emit('launch', { android: incoming });
    assert.equal(incoming.hasExtra(EXTRA), false);
    assert.equal(incoming.removeExtra.mock.callCount(), id === undefined ? 0 : 1);
  }
  assert.equal(sessions.selectedSessionId(), 'saved');
  assert.equal(sessions.select.mock.callCount(), 0);
  assert.equal(navigation.navigate.mock.callCount(), 0);
});

test('failed selection consumes the target without navigating', (t) => {
  const { sessions, navigation } = setup(t);
  sessions.select.mock.mockImplementation(() => false);
  const incoming = intent('target');
  androidApp.emit('activityNewIntent', { intent: incoming });
  assert.equal(incoming.hasExtra(EXTRA), false);
  assert.equal(sessions.selectedSessionId(), 'saved');
  assert.equal(navigation.navigate.mock.callCount(), 0);
});

test('pending navigation is discarded if target becomes archived or selection changes', (t) => {
  const { sessions, navigation, endNavigation, router } = setup(t, intent('target'), false, '/');
  sessions.activeSessions.set([{ id: 'saved' }, { id: 'other' }]);
  endNavigation('/agents');
  assert.equal(navigation.navigate.mock.callCount(), 0);
  router.navigated = false;
  androidApp.emit('activityNewIntent', { intent: intent('other') });
  sessions.selectedSessionId.set('saved');
  endNavigation('/agents');
  assert.equal(navigation.navigate.mock.callCount(), 0);
});

test('destroy removes all listeners and discards pending startup navigation', (t) => {
  const { sessions, navigation, injector, endNavigation } = setup(t, intent('target'), false, '/');
  injector.destroy();
  const incoming = intent('other');
  Application.emit('launch', { android: incoming });
  Application.emit('resume', { android: { getIntent: () => incoming } });
  androidApp.emit('activityNewIntent', { intent: incoming });
  endNavigation('/agents');
  assert.equal(incoming.hasExtra(EXTRA), true);
  assert.equal(sessions.select.mock.callCount(), 1);
  assert.equal(navigation.navigate.mock.callCount(), 0);
});
