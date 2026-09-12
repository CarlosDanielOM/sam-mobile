import { ChangeDetectionStrategy, Component, NO_ERRORS_SCHEMA, inject, input } from '@angular/core';
import { NativeScriptCommonModule, RouterExtensions } from '@nativescript/angular';
import { SessionStore } from '../../core/sessions/session-store';
import { DrawerService } from './drawer.service';

@Component({
  selector: 'ns-drawer',
  templateUrl: './drawer.component.html',
  imports: [NativeScriptCommonModule],
  schemas: [NO_ERRORS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DrawerComponent {
  readonly active = input.required<'home' | 'providers' | 'agents' | 'embeddings'>();
  readonly drawer = inject(DrawerService);
  readonly sessions = inject(SessionStore);
  private readonly router = inject(RouterExtensions);

  goHome(): void {
    this.go('/chat', 'home');
  }

  goProviders(): void {
    this.go('/providers', 'providers');
  }

  goAgents(): void {
    this.go('/agents', 'agents');
  }

  goEmbeddings(): void {
    this.go('/embeddings', 'embeddings');
  }

  selectSession(id: string): void {
    if (this.sessions.select(id)) this.goHome();
  }

  newSession(): void {
    if (this.sessions.create()) this.goHome();
  }

  restoreSession(id: string): void {
    if (this.sessions.restore(id)) this.goHome();
  }

  private go(path: string, key: 'home' | 'providers' | 'agents' | 'embeddings'): void {
    this.drawer.hide();
    if (this.active() === key) {
      return;
    }
    void this.router.navigate([path], { clearHistory: true });
  }
}
