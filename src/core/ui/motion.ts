import { Directive, ElementRef, Injectable, OnDestroy, effect, inject, input, untracked } from '@angular/core';
import { Application, Utils, isAndroid, isIOS, type View, type TouchGestureEventData } from '@nativescript/core';
import { ViewMotion } from './view-motion';
export { ViewMotion } from './view-motion';
import { SamUiTheme } from './theme.service';
import { UI_MOTION, motionDuration, type UiMotionKind } from './motion-tokens';

function systemReducesMotion(): boolean {
  try {
    if (isAndroid) {
      const g = (globalThis as any).android;
      const resolver = (Application.android.context ?? Utils.android.getApplicationContext()).getContentResolver();
      return g.provider.Settings.Global.getFloat(resolver, 'animator_duration_scale', 1) === 0;
    }
    if (isIOS) return !!(globalThis as any).UIAccessibilityIsReduceMotionEnabled();
  } catch { /* A missing platform API must never prevent interaction. */ }
  return false;
}

@Injectable({ providedIn: 'root' })
export class SamMotion {
  private readonly theme = inject(SamUiTheme);
  duration(kind: UiMotionKind): number {
    return motionDuration(kind, this.theme.reducedMotion(), systemReducesMotion());
  }
}

@Directive({ selector: '[samPress]', standalone: true, host: { '(touch)': 'touch($event)', '(unloaded)': 'reset()' } })
export class SamPressDirective implements OnDestroy {
  private readonly view = inject<ElementRef<View>>(ElementRef).nativeElement;
  private readonly motion = inject(SamMotion);
  private readonly player = new ViewMotion(this.view);
  private held = false;
  touch(event: unknown): void {
    const down = (event as TouchGestureEventData).action === 'down';
    if (!down && !this.held) return;
    this.held = down;
    if (!this.view.isEnabled) { this.reset(); return; }
    const duration = this.motion.duration(down ? 'press' : 'release');
    const scale = down && duration ? UI_MOTION.pressScale : 1;
    void this.player.play({ scale: { x: scale, y: scale }, duration });
  }
  reset(): void { this.held = false; this.player.cancel(); this.view.scaleX = this.view.scaleY = 1; }
  ngOnDestroy(): void { this.reset(); }
}

/** Reveal on insertion or a semantic key change; never key to streaming text or polling. */
@Directive({ selector: '[samReveal]', standalone: true, host: { '(loaded)': 'reveal()', '(unloaded)': 'reset()' } })
export class SamRevealDirective implements OnDestroy {
  readonly samReveal = input<unknown>('');
  private readonly view = inject<ElementRef<View>>(ElementRef).nativeElement;
  private readonly motion = inject(SamMotion);
  private readonly player = new ViewMotion(this.view);
  constructor() {
    effect(() => { this.samReveal(); if (this.view.isLoaded) untracked(() => this.reveal()); });
  }
  reveal(): void {
    this.player.cancel();
    const duration = this.motion.duration('reveal');
    this.view.opacity = duration ? 0.65 : 1;
    this.view.translateY = duration ? UI_MOTION.revealDistance : 0;
    void this.player.play({ opacity: 1, translate: { x: 0, y: 0 }, duration });
  }
  reset(): void { this.player.cancel(); this.view.opacity = 1; this.view.translateY = 0; }
  ngOnDestroy(): void { this.reset(); }
}
