import { ChangeDetectionStrategy, Component, NO_ERRORS_SCHEMA, input, output } from '@angular/core';
import { NativeScriptCommonModule } from '@nativescript/angular';
import { SamButtonDirective } from './primitives';

@Component({
  selector: 'sam-choice', standalone: true,
  imports: [NativeScriptCommonModule, SamButtonDirective], schemas: [NO_ERRORS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<Button [samButton]="checked() ? 'primary' : 'secondary'"
    [samDisabled]="disabled()" horizontalAlignment="stretch" samAlign="left" marginBottom="8"
    [text]="(kind() === 'radio' ? (checked() ? '●   ' : '○   ') : (checked() ? '✓   ' : '□   ')) + label()"
    [accessibilityLabel]="label()" [accessibilityRole]="kind() === 'radio' ? 'radioButton' : 'checkbox'"
    [accessibilityState]="checked() ? 'checked' : 'unchecked'"
    (tap)="activate()"></Button>`,
})
export class SamChoiceComponent {
  readonly label = input.required<string>();
  readonly kind = input<'check' | 'radio'>('check');
  readonly checked = input(false);
  readonly disabled = input(false);
  readonly checkedChange = output<boolean>();
  activate(): void {
    if (!this.disabled()) this.checkedChange.emit(this.kind() === 'radio' || !this.checked());
  }
}
