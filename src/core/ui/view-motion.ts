import { Animation, type View, type AnimationDefinition } from '@nativescript/core';
import { UI_MOTION } from './motion-tokens';

/** One owner per view: a newer gesture replaces, rather than queues behind, an older one. */
export class ViewMotion {
  private animation?: Animation;
  private readonly view: View;
  constructor(view: View) { this.view = view; }
  cancel(): void { this.animation?.cancel(); this.animation = undefined; }
  async play(options: AnimationDefinition): Promise<void> {
    this.cancel();
    if (!options.duration) {
      if (options.opacity !== undefined) this.view.opacity = options.opacity;
      if (options.translate) { this.view.translateX = options.translate.x; this.view.translateY = options.translate.y; }
      if (options.scale) { this.view.scaleX = options.scale.x; this.view.scaleY = options.scale.y; }
      return;
    }
    const animation = new Animation([{ ...options, target: this.view, curve: UI_MOTION.curve }]);
    this.animation = animation;
    try { await animation.play(); } catch { /* Unloading or superseding an animation cancels its promise. */ }
    finally { if (this.animation === animation) this.animation = undefined; }
  }
}
