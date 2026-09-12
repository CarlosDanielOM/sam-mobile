import { ChangeDetectionStrategy, Component, NO_ERRORS_SCHEMA, OnDestroy, inject, input } from '@angular/core';
import { NativeScriptCommonModule, RouterExtensions } from '@nativescript/angular';
import { Application, Screen, isAndroid, type View } from '@nativescript/core';
import { SamMotion, ViewMotion, SamThemeScopeDirective, SamPressDirective } from '../../core/ui';
import { SessionStore } from '../../core/sessions/session-store';
import { DrawerService } from './drawer.service';

@Component({
  selector: 'ns-drawer',
  templateUrl: './drawer.component.html',
  imports: [NativeScriptCommonModule, SamThemeScopeDirective, SamPressDirective],
  schemas: [NO_ERRORS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DrawerComponent implements OnDestroy {
  readonly active = input.required<'home' | 'providers' | 'agents' | 'embeddings' | 'retrieval' | 'ui-kit' | 'appearance'>();
  readonly drawer = inject(DrawerService);
  readonly sessions = inject(SessionStore);
  private readonly router = inject(RouterExtensions);
  private readonly motion = inject(SamMotion);
  readonly width = Math.min(320, Screen.mainScreen.widthDIPs - 48);
  private panel?: ViewMotion;
  private scrim?: ViewMotion;
  private closing = false;
  private destroyed = false;
  private readonly back = (event: { cancel: boolean }) => { event.cancel = true; void this.close(); };

  constructor() {
    if (isAndroid) Application.android.on('activityBackPressed', this.back);
  }
  mounted(event: unknown): void {
    const root = (event as { object: View }).object;
    const panel = root.getViewById<View>('drawer-panel');
    const scrim = root.getViewById<View>('drawer-scrim');
    this.panel?.cancel(); this.scrim?.cancel();
    this.panel = new ViewMotion(panel); this.scrim = new ViewMotion(scrim);
    const duration = this.motion.duration('drawer');
    panel.translateX = duration ? -this.width : 0;
    scrim.opacity = duration ? 0 : 1;
    void this.panel.play({ translate: { x: 0, y: 0 }, duration });
    void this.scrim.play({ opacity: 1, duration });
  }
  async close(): Promise<boolean> {
    if (this.closing || this.destroyed) return false;
    this.closing = true;
    const duration = this.motion.duration('exit');
    await Promise.all([
      this.panel?.play({ translate: { x: -this.width, y: 0 }, duration }),
      this.scrim?.play({ opacity: 0, duration }),
    ]);
    if (this.destroyed) return false;
    this.drawer.hide();
    return true;
  }
  ngOnDestroy(): void {
    this.destroyed = true;
    this.panel?.cancel(); this.scrim?.cancel();
    if (isAndroid) Application.android.off('activityBackPressed', this.back);
  }
  goAppearance(): void { void this.go('/appearance', 'appearance'); }


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

  goRetrieval(): void { void this.go('/retrieval', 'retrieval'); }

  goUiKit(): void {
    this.go('/ui-kit', 'ui-kit');
  }

  selectSession(id: string): void {
    if (this.closing) return;
    if (this.sessions.select(id)) this.goHome();
  }

  newSession(): void {
    if (this.closing) return;
    if (this.sessions.create()) this.goHome();
  }

  restoreSession(id: string): void {
    if (this.closing) return;
    if (this.sessions.restore(id)) this.goHome();
  }

  private async go(path: string, key: 'home' | 'providers' | 'agents' | 'embeddings' | 'retrieval' | 'ui-kit' | 'appearance'): Promise<void> {
    if (!await this.close()) return;
    if (this.active() === key) {
      return;
    }
    const duration = this.motion.duration('navigation');
    await this.router.navigate([path], { clearHistory: true, animated: duration > 0, transition: { name: 'fade', duration } });
  }
}
