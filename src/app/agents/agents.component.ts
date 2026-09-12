import { SamThemeScopeDirective, SamPressDirective, SamRevealDirective } from '../../core/ui';
import { ChangeDetectionStrategy, Component, NO_ERRORS_SCHEMA, inject, signal } from '@angular/core';
import { NativeScriptCommonModule } from '@nativescript/angular';
import { TextView } from '@nativescript/core';
import { AgentPromptService } from '../../core/agent-prompt.service';
import { AGENT_CATALOG } from '../../core/agents';
import { DrawerComponent } from '../shell/drawer.component';
import { DrawerService } from '../shell/drawer.service';

@Component({
  selector: 'ns-agents',
  templateUrl: './agents.component.html',
  imports: [NativeScriptCommonModule, DrawerComponent, SamThemeScopeDirective, SamPressDirective, SamRevealDirective],
  schemas: [NO_ERRORS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AgentsComponent {
  readonly prompts = inject(AgentPromptService);
  readonly drawer = inject(DrawerService);
  readonly editingId = signal<string | null>(null);
  readonly draft = signal('');
  readonly saved = signal(false);


  beginEdit(id: string): void {
    this.editingId.set(id);
    this.draft.set(this.prompts.get(id));
    this.saved.set(false);
  }

  onDraft(args: unknown): void {
    this.draft.set((args as { object?: TextView }).object?.text ?? '');
  }

  save(): void {
    const id = this.editingId();
    if (!id) {
      return;
    }
    this.prompts.save(id, this.draft());
    this.draft.set(this.prompts.get(id));
    this.saved.set(true);
  }

  reset(): void {
    const id = this.editingId();
    if (!id) {
      return;
    }
    this.prompts.reset(id);
    this.draft.set(this.prompts.get(id));
    this.saved.set(true);
  }

  cancel(): void {
    this.editingId.set(null);
    this.draft.set('');
    this.saved.set(false);
  }

  nameFor(id: string): string {
    return AGENT_CATALOG.find((agent) => agent.id === id)?.name ?? id;
  }
}
