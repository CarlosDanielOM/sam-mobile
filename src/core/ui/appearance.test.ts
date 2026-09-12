import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_APPEARANCE, readAppearance } from './appearance.ts';
import { effectiveColorMode } from './tokens.ts';
import { motionDuration } from './motion-tokens.ts';

test('new and malformed preferences use official defaults', () => {
  for (const value of ['', '{}', 'null', 'false', '{broken']) assert.deepEqual(readAppearance(value), DEFAULT_APPEARANCE);
});
test('saved appearance survives a restart including the palette beneath DND', () => {
  for (const colorMode of ['color', 'mono'] as const) {
    const saved = { mode: 'light' as const, colorMode, doNotDisturb: true, reducedMotion: true };
    const restored = readAppearance(JSON.stringify(saved));
    assert.deepEqual(restored, saved);
    assert.equal(effectiveColorMode(restored.colorMode, restored.doNotDisturb), 'mono');
    assert.equal(effectiveColorMode(restored.colorMode, false), colorMode);
  }
});
test('unknown fields and invalid values preserve independent valid preferences', () => {
  assert.deepEqual(readAppearance('{"mode":"light","colorMode":"rainbow","doNotDisturb":"true","reducedMotion":true,"future":42}'),
    { mode: 'light', colorMode: 'color', doNotDisturb: false, reducedMotion: true });
});
test('either app or system reduced motion removes every custom transition', () => {
  for (const kind of ['press', 'release', 'reveal', 'drawer', 'exit', 'navigation'] as const) {
    assert.ok(motionDuration(kind, false, false) > 0);
    assert.ok(motionDuration(kind, false, false) <= 300);
    assert.equal(motionDuration(kind, true, false), 0);
    assert.equal(motionDuration(kind, false, true), 0);
    assert.equal(motionDuration(kind, true, true), 0);
  }
});
