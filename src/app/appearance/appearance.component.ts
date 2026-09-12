import { ChangeDetectionStrategy, Component, NO_ERRORS_SCHEMA, inject, signal } from '@angular/core';
import { NativeScriptCommonModule } from '@nativescript/angular';
import { SamUiTheme, SamThemeScopeDirective, SamButtonDirective, SamSurfaceDirective, SamTextDirective,
  SamActionsDirective, SamActionDirective, SamRevealDirective } from '../../core/ui';
import { DrawerService } from '../shell/drawer.service';
import { DrawerComponent } from '../shell/drawer.component';

@Component({
  selector: 'ns-appearance', templateUrl: './appearance.component.html',
  imports: [NativeScriptCommonModule, DrawerComponent, SamThemeScopeDirective, SamButtonDirective,
    SamSurfaceDirective, SamTextDirective, SamActionsDirective, SamActionDirective, SamRevealDirective],
  schemas: [NO_ERRORS_SCHEMA], changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppearanceComponent {
  readonly ui = inject(SamUiTheme);
  readonly drawer = inject(DrawerService);
  readonly replay = signal(0);
  readonly replayIncrement = (value: number) => value + 1;
  checked(event: unknown): boolean { return !!(event as { object?: { checked: boolean } }).object?.checked; }
}
