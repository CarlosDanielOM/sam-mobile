/** Interlude motion: milliseconds and native dip. See DESIGN_LANGUAGE.md. */
export const UI_MOTION = {
  press: 80, release: 180, reveal: 240, drawer: 280, exit: 200, navigation: 240,
  pressScale: 0.985, revealDistance: 8, curve: 'easeOut',
} as const;
export type UiMotionKind = 'press' | 'release' | 'reveal' | 'drawer' | 'exit' | 'navigation';
export function motionDuration(kind: UiMotionKind, reduced: boolean, systemReduced: boolean): number {
  return reduced || systemReduced ? 0 : UI_MOTION[kind];
}
