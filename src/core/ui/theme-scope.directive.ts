import { Directive, ElementRef, effect, inject } from '@angular/core';
import { Color, Page, type View } from '@nativescript/core';
import { SamUiTheme } from './theme.service';

/** Bridges existing semantic CSS classes to the same tokens as the native primitives. */
@Directive({ selector: '[samThemeScope]', standalone: true })
export class SamThemeScopeDirective {
  private readonly ui = inject(SamUiTheme);
  private readonly view = inject<ElementRef<View>>(ElementRef).nativeElement;
  private readonly page = inject(Page);
  constructor() {
    effect(() => {
      const t = this.ui.tokens();
      const variables = Object.entries(t).map(([key, value]) =>
        `--sam-${key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())}: ${value}`).join(';');
      this.view.setInlineStyle(variables);
      this.page.actionBarHidden = true;
      this.page.backgroundColor = new Color(t.background);
      this.page.androidStatusBarBackground = new Color(t.background);
      this.page.statusBarStyle = this.ui.mode() === 'dark' ? 'light' : 'dark';
    });
  }
}
