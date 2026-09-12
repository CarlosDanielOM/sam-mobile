import { ChangeDetectionStrategy, Component, NO_ERRORS_SCHEMA, OnDestroy, inject, signal } from '@angular/core';
import { NativeScriptCommonModule } from '@nativescript/angular';
import { Dialogs, type TextField, type View } from '@nativescript/core';
import { SamUiTheme, SamButtonDirective, SamSurfaceDirective, SamTextDirective, SamFieldDirective,
  SamActionsDirective, SamActionDirective, SamChoiceComponent, UI_DIRECTIONS, UI_ACCENTS, uiTokens,
  SamThemeScopeDirective, SamRevealDirective, SamMotion, AppAppearance, type UiDirection, type UiAccent } from '../../core/ui';
import { DrawerComponent } from '../shell/drawer.component';
import { DrawerService } from '../shell/drawer.service';

@Component({
  selector: 'ns-ui-kit', templateUrl: './ui-kit.component.html', styleUrls: ['./ui-kit.component.css'],
  imports: [NativeScriptCommonModule, DrawerComponent, SamButtonDirective, SamSurfaceDirective,
    SamTextDirective, SamFieldDirective, SamActionsDirective, SamActionDirective, SamChoiceComponent, SamThemeScopeDirective, SamRevealDirective],
  providers: [SamUiTheme, SamMotion], schemas: [NO_ERRORS_SCHEMA], changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiKitComponent implements OnDestroy {
  readonly ui = inject(SamUiTheme);
  readonly drawer = inject(DrawerService);
  readonly directions = UI_DIRECTIONS;
  readonly accents = UI_ACCENTS;
  readonly replay = signal(0);
  readonly replayIncrement = (value: number) => value + 1;
  readonly name = signal('Weekend ideas');
  readonly email = signal('');
  readonly notes = signal('Keep it short. Leave room for a little curiosity.');
  readonly attempted = signal(false);
  readonly remember = signal(true);
  readonly notifications = signal(false);
  readonly answerStyle = signal('Balanced');
  readonly saving = signal(false);
  readonly notice = signal('');
  readonly section = signal('controls');
  readonly sections = [{ id: 'controls', title: 'Controls' }, { id: 'surfaces', title: 'Surfaces' }, { id: 'type', title: 'Type & space' }, { id: 'motion', title: 'Motion' }];
  readonly narrow = signal(false);
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    const appearance = inject(AppAppearance);
    this.ui.mode.set(appearance.mode());
    this.ui.colorMode.set(appearance.colorMode());
    this.ui.doNotDisturb.set(appearance.doNotDisturb());
    this.ui.reducedMotion.set(appearance.reducedMotion());

  }
  choose(direction: UiDirection): void { this.ui.direction.set(direction); }
  layout(event: unknown): void {
    const view = (event as { object?: View }).object;
    if (view) this.narrow.set(view.getActualSize().width < 370);
  }
  checkedValue(event: unknown): boolean { return !!(event as { object?: { checked: boolean } }).object?.checked; }
  value(event: unknown): string { return (event as { object?: TextField }).object?.text ?? ''; }
  accentColor(accent: UiAccent): string { return uiTokens('spectrum', this.ui.mode(), accent).accent; }
  invalidEmail(): boolean { return this.attempted() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.email()); }
  save(): void {
    if (this.saving()) return;
    this.notice.set(''); this.saving.set(true);
    this.timer = setTimeout(() => {
      this.saving.set(false);
      this.notice.set('Preview saved. This example only changes the UI Kit.');
    }, 900);
  }
  validate(): void {
    this.attempted.set(true);
    this.notice.set(this.invalidEmail() ? 'Check the email field above.' : 'Looks good. Your example form is valid.');
  }
  async showDialog(): Promise<void> {
    const confirmed = await Dialogs.confirm({ title: 'Keep this direction?',
      message: 'This is a dialog example. Your app theme and saved data stay the same.',
      okButtonText: 'Keep exploring', cancelButtonText: 'Close' });
    this.notice.set(confirmed ? 'Keep exploring the components below.' : 'Dialog dismissed.');
  }
  ngOnDestroy(): void { if (this.timer) clearTimeout(this.timer); }
}
