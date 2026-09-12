import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === './motion-tokens') return next('./motion-tokens.ts', context);
  return next(specifier, context);
} });
const animations: FakeAnimation[] = [];
class FakeAnimation {
  cancelled = false;
  resolve!: () => void;
  reject!: (reason: Error) => void;
  constructor(_definitions: unknown[]) { animations.push(this); }
  play() { return new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; }); }
  cancel() { this.cancelled = true; this.reject(new Error('cancelled')); }
}
mock.module('@nativescript/core', { namedExports: { Animation: FakeAnimation } });
const { ViewMotion } = await import('./view-motion.ts');

test('a newer animation cancels its predecessor without clearing the new owner', async () => {
  animations.length = 0;
  const player = new ViewMotion({} as any);
  const first = player.play({ opacity: 0.65, duration: 240 });
  const second = player.play({ opacity: 1, duration: 180 });
  assert.equal(animations[0].cancelled, true);
  await first;
  player.cancel();
  assert.equal(animations[1].cancelled, true);
  await second;
});
test('reduced motion cancels in-flight work and applies the final state synchronously', async () => {
  animations.length = 0;
  const view = { opacity: 0.65, translateX: -320, translateY: 8, scaleX: 0.985, scaleY: 0.985 };
  const player = new ViewMotion(view as any);
  const pending = player.play({ opacity: 1, duration: 240 });
  await player.play({ opacity: 1, translate: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, duration: 0 });
  await pending;
  assert.equal(animations.length, 1);
  assert.equal(animations[0].cancelled, true);
  assert.deepEqual(view, { opacity: 1, translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 });
});
test('finished work is released, so cleanup is safe and does not cancel it again', async () => {
  animations.length = 0;
  const player = new ViewMotion({} as any);
  const pending = player.play({ opacity: 1, duration: 240 });
  animations[0].resolve();
  await pending;
  player.cancel(); player.cancel();
  assert.equal(animations[0].cancelled, false);
});
