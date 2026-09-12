import assert from 'node:assert/strict';
import test from 'node:test';
import { UI_ACCENTS, UI_DIRECTIONS, UI_LAYOUT, effectiveColorMode, uiTokens } from './tokens.ts';

function luminance(hex: string): number {
  const linear = hex.slice(1).match(/../g)!.map(value => {
    const s = parseInt(value, 16) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function contrast(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('every direction and accent keeps text readable in both modes', () => {
  for (const direction of UI_DIRECTIONS) for (const mode of ['dark', 'light'] as const) for (const accent of UI_ACCENTS) for (const colorMode of ['color', 'mono'] as const) {
    const t = uiTokens(direction.id, mode, accent, colorMode);
    for (const surface of [t.background, t.surface, t.inset, t.raised, t.accentSurface, t.secondarySurface]) {
      for (const ink of [t.text, t.muted, t.accent, t.secondaryAccent]) {
        assert.ok(contrast(ink, surface) >= 4.5, `${direction.id}/${mode}/${accent}: ${ink} on ${surface}`);
      }
    }
    assert.ok(contrast(t.onAccent, t.accent) >= 4.5, `${direction.id}/${mode}/${accent}: primary button`);
    assert.ok(contrast(t.control, t.inset) >= 3, `${direction.id}/${mode}/${accent}: input outline`);
  }
});

test('theme changes preserve touch sizing and keep the single-accent picker scoped to Spectrum', () => {
  assert.ok(UI_LAYOUT.touch >= 48);
  assert.ok(UI_LAYOUT.actionMax >= UI_LAYOUT.action);
  for (const direction of UI_DIRECTIONS.filter(d => d.id !== 'spectrum')) {
    assert.deepEqual(uiTokens(direction.id, 'dark', 'purple'), uiTokens(direction.id, 'dark', 'cyan'));
  }
  assert.equal(new Set(UI_ACCENTS.map(a => uiTokens('spectrum', 'dark', a).accent)).size, 4);
});


test('Interlude combines Quiet geometry, Ledger typography, and two color roles', () => {
  for (const mode of ['dark', 'light'] as const) {
    const mixed = uiTokens('interlude', mode);
    const quiet = uiTokens('quiet', mode);
    const ledger = uiTokens('ledger', mode);
    assert.equal(mixed.radius, quiet.radius);
    assert.equal(mixed.controlRadius, quiet.controlRadius);
    assert.equal(mixed.displayFont, ledger.displayFont);
    assert.equal(mixed.labelFont, ledger.labelFont);
    assert.notEqual(mixed.accent, mixed.secondaryAccent);
    assert.ok(contrast(mixed.secondaryBorder, mixed.secondarySurface) >= 3);
    const mono = uiTokens('interlude', mode, 'purple', 'mono');
    for (const key of ['background', 'surface', 'accent', 'secondaryAccent', 'accentSurface', 'secondarySurface', 'danger'] as const) {
      assert.equal(mono[key], quiet[key], `${mode}: monochrome ${key}`);
    }
  }
});

test('DND overrides appearance while preserving either palette preference', () => {
  for (const preference of ['color', 'mono'] as const) {
    assert.equal(effectiveColorMode(preference, false), preference);
    assert.equal(effectiveColorMode(preference, true), 'mono');
    assert.equal(effectiveColorMode(preference, false), preference);
  }
});
