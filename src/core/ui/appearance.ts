import type { UiColorMode, UiMode } from './tokens';

export interface AppearancePreferences {
  mode: UiMode;
  colorMode: UiColorMode;
  doNotDisturb: boolean;
  reducedMotion: boolean;
}
export const APPEARANCE_KEY = 'sam.appearance.v1';
export const DEFAULT_APPEARANCE: AppearancePreferences = {
  mode: 'dark', colorMode: 'color', doNotDisturb: false, reducedMotion: false,
};
/** Validate saved preferences independently so a future field never resets valid choices. */
export function readAppearance(raw: string): AppearancePreferences {
  try {
    const value = JSON.parse(raw);
    return {
      mode: value?.mode === 'light' ? 'light' : 'dark',
      colorMode: value?.colorMode === 'mono' ? 'mono' : 'color',
      doNotDisturb: value?.doNotDisturb === true,
      reducedMotion: value?.reducedMotion === true,
    };
  } catch { return { ...DEFAULT_APPEARANCE }; }
}
