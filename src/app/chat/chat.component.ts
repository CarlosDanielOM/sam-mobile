import { ChangeDetectionStrategy, Component, NO_ERRORS_SCHEMA, effect, inject, signal } from '@angular/core';
import { NativeScriptCommonModule } from '@nativescript/angular';
import { Color, EventData, Page, ScrollEventData, ScrollView, TextField } from '@nativescript/core';
import { ChatStore } from '../../core/chat.store';
import { ProviderService, type ModelOption } from '../../core/provider.service';
import { DrawerComponent } from '../shell/drawer.component';
import { DrawerService } from '../shell/drawer.service';

@Component({
  selector: 'ns-chat',
  templateUrl: './chat.component.html',
  imports: [NativeScriptCommonModule, DrawerComponent],
  schemas: [NO_ERRORS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatComponent {
  readonly chat = inject(ChatStore);
  readonly providers = inject(ProviderService);
  readonly drawer = inject(DrawerService);
  readonly picking = signal(false);
  readonly inspecting = signal(false);
  readonly atBottom = signal(true);
  private thread?: ScrollView;
  private stickToBottom = true;
  private jumping = false;
  private ring: any = null;

  constructor() {
    const page = inject(Page);
    page.actionBarHidden = true;
    page.backgroundColor = new Color('#0C0C10');
    page.statusBarStyle = 'light';
    page.androidStatusBarBackground = new Color('#0C0C10');
    effect(() => {
      const percent = this.chat.usageSummary()?.contextPercent ?? 0;
      if (this.ring) {
        this.ring.setProgress(Math.min(100, percent));
      }
    });
  }

  createRing(args: unknown): void {
    const event = args as { context?: any; view?: any };
    const context = event.context;
    try {
      const globals: any = globalThis as any;
      const resources = context.getResources();
      const themeId =
        resources.getIdentifier('Theme_MaterialComponents', 'style', context.getPackageName()) ||
        resources.getIdentifier('Theme_Material3_DayNight', 'style', context.getPackageName());
      const themed = themeId
        ? new globals.android.view.ContextThemeWrapper(context, themeId)
        : context;
      const ring = new globals.com.google.android.material.progressindicator.CircularProgressIndicator(themed);
      const density = context.getResources().getDisplayMetrics().density;
      const dp = (value: number) => Math.round(value * density);
      ring.setIndeterminate(false);
      ring.setIndicatorSize(dp(14));
      ring.setTrackThickness(dp(3));
      ring.setTrackColor(globals.android.graphics.Color.parseColor('#241A40'));
      ring.setIndicatorColor([
        globals.android.graphics.Color.parseColor('#C084FC'),
        globals.android.graphics.Color.parseColor('#38BDF8'),
        globals.android.graphics.Color.parseColor('#2DD4BF'),
      ]);
      ring.setProgress(Math.min(100, this.chat.usageSummary()?.contextPercent ?? 0));
      event.view = ring;
      this.ring = ring;
    } catch (error) {
      console.warn('SAM context ring unavailable.', error);
      event.view = new (globalThis as any).android.view.View(context);
    }
  }

  sendClass(): string {
    if (this.chat.sending()) {
      return 'sam-send sam-send-stop';
    }
    return this.chat.draft().trim().length > 0 ? 'sam-send sam-send-live' : 'sam-send sam-send-idle';
  }

  toggleModels(): void {
    if (!this.providers.modelOptions().length) {
      return;
    }
    this.inspecting.set(false);
    this.picking.update((open) => !open);
  }

  toggleUsage(): void {
    if (!this.chat.turnUsage()) {
      return;
    }
    this.picking.set(false);
    this.inspecting.update((open) => !open);
  }

  pickModel(option: ModelOption): void {
    this.providers.selectModel(option.providerId, option.modelId);
    this.picking.set(false);
  }

  onDraft(args: unknown): void {
    const field = (args as { object?: TextField }).object;
    this.chat.setDraft(field?.text ?? '');
  }

  onThreadLoaded(args: unknown): void {
    this.thread = (args as EventData).object as ScrollView;
    this.syncAtBottom();
  }

  onThreadScroll(args: unknown): void {
    this.thread = (args as ScrollEventData).object as ScrollView;
    if (this.jumping) {
      return;
    }
    this.syncAtBottom();
  }

  onThreadLayout(): void {
    if (this.jumping) {
      return;
    }
    if (this.stickToBottom) {
      this.scrollThreadToEnd(false);
      return;
    }
    this.syncAtBottom();
  }

  scrollToLatest(): void {
    this.stickToBottom = true;
    this.atBottom.set(true);
    this.jumping = true;
    this.scrollThreadToEnd(true);
    setTimeout(() => {
      this.jumping = false;
      this.syncAtBottom();
    }, 350);
  }

  private syncAtBottom(): void {
    const sv = this.thread;
    if (!sv) {
      return;
    }
    const max = sv.scrollableHeight;
    const next = max <= 0 || max - sv.verticalOffset <= 72;
    this.stickToBottom = next;
    if (this.atBottom() !== next) {
      this.atBottom.set(next);
    }
  }

  private scrollThreadToEnd(animated: boolean): void {
    const sv = this.thread;
    if (!sv) {
      return;
    }
    sv.scrollToVerticalOffset(sv.scrollableHeight, animated);
  }
}
