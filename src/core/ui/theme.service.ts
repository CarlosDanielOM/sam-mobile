import { Injectable, computed, signal } from '@angular/core';
import { type UiColorMode, effectiveColorMode, type UiAccent, type UiDirection, type UiMode, UI_DIRECTIONS, uiTokens } from './tokens';

/** Provide at a screen boundary to keep mock/theme changes local to that screen. */
@Injectable({ providedIn: 'root' })
export class SamUiTheme {
  readonly direction = signal<UiDirection>('interlude');
  readonly mode = signal<UiMode>('dark');
  readonly accent = signal<UiAccent>('purple');
  readonly colorMode = signal<UiColorMode>('color');
  readonly doNotDisturb = signal(false);
  readonly reducedMotion = signal(false);
  readonly effectiveColorMode = computed(() => effectiveColorMode(this.colorMode(), this.doNotDisturb()));
  readonly tokens = computed(() => uiTokens(this.direction(), this.mode(), this.accent(), this.effectiveColorMode()));
  readonly design = computed(() => UI_DIRECTIONS.find(item => item.id === this.direction())!);
}
