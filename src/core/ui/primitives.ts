import { Directive, ElementRef, effect, inject, input, signal } from '@angular/core';
import { Button, Color, type TextField, type View } from '@nativescript/core';
import { SamUiTheme } from './theme.service';
import { UI_LAYOUT, UI_TYPE } from './tokens';
import { SamPressDirective } from './motion';
const color = (value: string) => new Color(value);

@Directive({ selector: 'Button[samButton]', standalone: true, hostDirectives: [SamPressDirective] })
export class SamButtonDirective {
  readonly samButton = input<'primary' | 'secondary' | 'ghost' | 'danger'>('primary');
  readonly samDisabled = input(false);
  readonly samAlign = input<'left' | 'center'>('center');
  readonly samBusy = input(false);
  private readonly theme = inject(SamUiTheme);
  private readonly view = inject<ElementRef<Button>>(ElementRef).nativeElement;
  constructor() {
    effect(() => {
      const t = this.theme.tokens(), variant = this.samButton(), primary = variant === 'primary';
      this.view.isEnabled = !this.samDisabled() && !this.samBusy();
      Object.assign(this.view.style, {
        minHeight: UI_LAYOUT.touch, minWidth: UI_LAYOUT.touch, padding: '12 16',
        fontSize: UI_TYPE.body, fontWeight: '600', fontFamily: t.labelFont,
        textTransform: 'none', whiteSpace: 'normal', textAlignment: this.samAlign(),
        borderRadius: t.controlRadius, borderWidth: variant === 'ghost' ? 0 : t.border,
        borderColor: color(primary ? t.accent : variant === 'danger' ? t.danger : t.secondaryBorder),
        backgroundColor: color(primary ? t.accent : variant === 'ghost' ? 'transparent' : variant === 'secondary' ? t.secondarySurface : t.surface),
        color: color(primary ? t.onAccent : variant === 'danger' ? t.danger : variant === 'secondary' ? t.secondaryAccent : t.text),
        opacity: !this.view.isEnabled ? 0.45 : 1,
        androidElevation: 0, androidDynamicElevationOffset: 0,
      });
      this.view.textWrap = true;
    });
  }
}

@Directive({ selector: '[samSurface]', standalone: true })
export class SamSurfaceDirective {
  readonly samSurface = input<'card' | 'inset' | 'raised' | 'accent' | 'support'>('card');
  private readonly theme = inject(SamUiTheme);
  private readonly view = inject<ElementRef<View>>(ElementRef).nativeElement;
  constructor() {
    effect(() => {
      const t = this.theme.tokens(), tone = this.samSurface();
      Object.assign(this.view.style, {
        backgroundColor: color(tone === 'inset' ? t.inset : tone === 'raised' ? t.raised : tone === 'accent' ? t.accentSurface : tone === 'support' ? t.secondarySurface : t.surface),
        borderColor: color(t.line), borderWidth: t.border, borderRadius: t.radius, padding: t.insetSize,
      });
    });
  }
}

@Directive({ selector: 'Label[samText]', standalone: true })
export class SamTextDirective {
  readonly samText = input<keyof typeof UI_TYPE>('body');
  readonly samMuted = input(false);
  readonly samAccent = input(false);
  readonly samSupport = input(false);
  private readonly theme = inject(SamUiTheme);
  private readonly view = inject<ElementRef<View>>(ElementRef).nativeElement;
  constructor() {
    effect(() => {
      const t = this.theme.tokens(), role = this.samText();
      Object.assign(this.view.style, {
        color: color(this.samAccent() ? t.accent : this.samSupport() ? t.secondaryAccent : this.samMuted() ? t.muted : t.text),
        fontSize: UI_TYPE[role], fontWeight: ['display', 'heading', 'title'].includes(role) ? '600' : '400',
        fontFamily: role === 'display' ? t.displayFont : role === 'code' || role === 'meta' ? t.labelFont : 'sans-serif',
        whiteSpace: 'normal', lineHeight: 4,
      });
    });
  }
}

@Directive({ selector: 'TextField[samField], TextView[samField]', standalone: true,
  host: { '(focus)': 'focused.set(true)', '(blur)': 'focused.set(false)' } })
export class SamFieldDirective {
  readonly samInvalid = input(false);
  readonly samFieldMinHeight = input<number>(UI_LAYOUT.touch);
  readonly focused = signal(false);
  private readonly theme = inject(SamUiTheme);
  private readonly view = inject<ElementRef<TextField>>(ElementRef).nativeElement;
  constructor() {
    effect(() => {
      const t = this.theme.tokens();
      Object.assign(this.view.style, {
        minHeight: Math.max(UI_LAYOUT.touch, this.samFieldMinHeight()), padding: '12 14', fontSize: 16,
        color: color(t.text), placeholderColor: color(t.muted), backgroundColor: color(t.inset),
        borderRadius: t.controlRadius, borderWidth: 1,
        borderColor: color(this.samInvalid() ? t.danger : this.focused() ? t.accent : t.control),
      });
    });
  }
}

/** Put direct native buttons in this layout; no Angular wrapper around flex children. */
@Directive({ selector: 'FlexboxLayout[samActions]', standalone: true })
export class SamActionsDirective {
  private readonly view = inject<ElementRef<View>>(ElementRef).nativeElement;
  constructor() {
    Object.assign(this.view.style, { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'stretch', marginLeft: -4, marginRight: -4, marginBottom: 8 });
  }
}

/** Native width properties survive the Tailwind CSS filter. */
@Directive({ selector: 'Button[samAction]', standalone: true })
export class SamActionDirective {
  private readonly view = inject<ElementRef<View>>(ElementRef).nativeElement;
  constructor() {
    Object.assign(this.view.style, { width: UI_LAYOUT.action, maxWidth: UI_LAYOUT.actionMax, flexGrow: 1, flexShrink: 1, margin: 4 });
  }
}
