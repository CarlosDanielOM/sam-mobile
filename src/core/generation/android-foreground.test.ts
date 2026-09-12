import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import type { ForegroundThinking } from './types.ts';

class Intent {
  service = '';
  action = '';
  extras: Record<string, unknown> = {};
  setClassName(_context: unknown, service: string): void { this.service = service; }
  setAction(action: string): void { this.action = action; }
  putExtra(key: string, value: unknown): void { this.extras[key] = value; }
}

const calls: { foreground: boolean; intent: Intent }[] = [];
let listener: { onCancel(id?: string | null): void };
const context = {
  startService: (intent: Intent) => calls.push({ foreground: false, intent }),
  startForegroundService: (intent: Intent) => calls.push({ foreground: true, intent }),
};
mock.module('@nativescript/core', { namedExports: {
  Application: { android: {} },
  Utils: { android: { getApplicationContext: () => context } },
} });
(globalThis as any).android = {
  content: { Intent },
  os: { Build: { VERSION: { SDK_INT: 33 } } },
};
(globalThis as any).org = { nativescript: { nativesam: { generation: {
  GenerationForegroundService: { setListener: (next: typeof listener) => { listener = next; } },
  GenerationServiceListener: class {
    constructor(callbacks: typeof listener) { return callbacks; }
  },
} } } };
const { AndroidForegroundService } = await import('./android-foreground.ts');

const single: ForegroundThinking = {
  kind: 'thinking', activeCount: 1,
  generationId: 'generation-a', conversationId: 'session-a', modelName: 'Model A',
};
const aggregate: ForegroundThinking = {
  kind: 'thinking', activeCount: 2,
};

beforeEach(() => { calls.length = 0; });

test('single task preserves model, chat scope and scoped cancel', () => {
  new AndroidForegroundService().start(single);
  assert.deepEqual(calls[0].intent.extras, {
    title: 'SAM is thinking…', text: 'Model A',
    'sam.generationId': 'generation-a', 'sam.conversationId': 'session-a', showCancel: true,
  });
});

test('aggregate notification has generic copy and no arbitrary session or cancel', () => {
  for (const state of [aggregate, { ...single, activeCount: 3 }]) {
    new AndroidForegroundService().start(state);
    assert.deepEqual(calls.at(-1)!.intent.extras, {
      title: `SAM - ${state.activeCount} tasks running`,
      text: 'Working on your requests', showCancel: false,
    });
  }
});

test('single task without a generation ID never exposes an unscoped cancel', () => {
  for (const generationId of [undefined, '', '   ']) {
    new AndroidForegroundService().start({ ...single, generationId });
    const extras = calls.at(-1)!.intent.extras;
    assert.equal(extras.showCancel, false);
    assert.equal(Object.hasOwn(extras, 'sam.generationId'), false);
  }
});

test('one service start then updates through 1 -> 2 -> 1, stopping only on idle', () => {
  const service = new AndroidForegroundService();
  service.start(single);
  service.update(aggregate);
  service.update({ ...single, generationId: 'generation-b', conversationId: 'session-b' });
  assert.deepEqual(calls.map(({ foreground, intent }) => [foreground, intent.action]), [
    [true, 'org.nativescript.nativesam.generation.START'],
    [false, 'org.nativescript.nativesam.generation.UPDATE'],
    [false, 'org.nativescript.nativesam.generation.UPDATE'],
  ]);
  assert.equal(new Set(calls.map(({ intent }) => intent.service)).size, 1);
  assert.equal(calls[2].intent.extras['sam.generationId'], 'generation-b');
  assert.equal(calls[2].intent.extras['sam.conversationId'], 'session-b');
  service.update({ kind: 'idle' });
  service.stop();
  assert.equal(calls.length, 4);
  assert.equal(calls[3].intent.action, 'org.nativescript.nativesam.generation.STOP');
  service.start(single);
  assert.equal(calls[4].foreground, true);
});

test('controller terminal state ends the current service lifecycle', () => {
  for (const kind of ['completed', 'failed'] as const) {
    calls.length = 0;
    const service = new AndroidForegroundService();
    service.start(single);
    service.update({ kind, generationId: 'generation-a', conversationId: 'session-a' });
    service.stop();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].intent.action,
      `org.nativescript.nativesam.generation.${kind === 'failed' ? 'FAILED' : 'COMPLETE'}`);
    service.start(single);
    assert.equal(calls[2].foreground, true);
  }
});

test('native listener ignores missing IDs and forwards stale IDs without retargeting or stopping', () => {
  const service = new AndroidForegroundService();
  const cancelled: string[] = [];
  service.setCancelHandler((id) => cancelled.push(id));
  service.start(single);
  service.update(aggregate);
  service.update({ ...single, generationId: 'generation-b', conversationId: 'session-b' });
  listener.onCancel();
  listener.onCancel(null);
  listener.onCancel('');
  listener.onCancel('   ');
  assert.deepEqual(cancelled, []);
  listener.onCancel('generation-a');
  listener.onCancel('generation-b');
  assert.deepEqual(cancelled, ['generation-a', 'generation-b']);
  assert.equal(calls.length, 3);
});
