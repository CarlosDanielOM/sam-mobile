import { Injectable, effect } from '@angular/core';
import { ApplicationSettings } from '@nativescript/core';
import { SamUiTheme } from './theme.service';
import { APPEARANCE_KEY, readAppearance } from './appearance';

/** Production preferences. Gallery instances of SamUiTheme remain temporary. */
@Injectable({ providedIn: 'root' })
export class AppAppearance extends SamUiTheme {
  constructor() {
    super();
    const saved = readAppearance(ApplicationSettings.getString(APPEARANCE_KEY, '{}'));
    this.mode.set(saved.mode);
    this.colorMode.set(saved.colorMode);
    this.doNotDisturb.set(saved.doNotDisturb);
    this.reducedMotion.set(saved.reducedMotion);
    effect(() => ApplicationSettings.setString(APPEARANCE_KEY, JSON.stringify({
      mode: this.mode(), colorMode: this.colorMode(),
      doNotDisturb: this.doNotDisturb(), reducedMotion: this.reducedMotion(),
    })));
  }
}
