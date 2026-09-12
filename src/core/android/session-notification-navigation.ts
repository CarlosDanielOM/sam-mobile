import { DestroyRef, Injectable, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { RouterExtensions } from '@nativescript/angular';
import { Application, isAndroid, type AndroidActivityNewIntentEventData, type ApplicationEventData } from '@nativescript/core';
import { SessionStore } from '../sessions/session-store';

const CONVERSATION_ID_EXTRA = 'sam.conversationId';

@Injectable({ providedIn: 'root' })
export class SessionNotificationNavigation {
  constructor() {
    if (!isAndroid || !Application.android) return;

    const sessions = inject(SessionStore);
    const router = inject(Router);
    const navigation = inject(RouterExtensions);
    const androidApp = Application.android;
    let pendingId: string | null = null;

    const openPending = () => {
      // AppComponent is constructed before initial navigation and its outlet are ready.
      if (!pendingId || !router.navigated) return;
      const id = pendingId;
      pendingId = null;
      if (sessions.selectedSessionId() !== id || !sessions.activeSessions().some((session) => session.id === id)) return;
      if (!router.isActive('/chat', { paths: 'exact', queryParams: 'ignored', matrixParams: 'ignored', fragment: 'ignored' })) {
        void navigation.navigate(['/chat'], { clearHistory: true }).catch((error) => {
          console.warn('Unable to open notification session.', error);
        });
      }
    };
    const consume = (intent?: android.content.Intent) => {
      if (!intent?.hasExtra(CONVERSATION_ID_EXTRA)) return;
      const id = intent.getStringExtra(CONVERSATION_ID_EXTRA);
      // NativeScript also exposes this intent on resume. Consume even stale targets.
      intent.removeExtra(CONVERSATION_ID_EXTRA);
      if (!id || !sessions.activeSessions().some((session) => session.id === id)) return;
      if (!sessions.select(id)) return;
      pendingId = id;
      openPending();
    };
    const currentIntent = () => (androidApp.foregroundActivity ?? androidApp.startActivity)?.getIntent();
    const onLaunch = (args: ApplicationEventData) => consume(args.android);
    const onResume = (args: ApplicationEventData) => consume(args.android?.getIntent() ?? currentIntent());
    const onNewIntent = (args: AndroidActivityNewIntentEventData) => consume(args.intent);
    const subscription = router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) openPending();
    });

    Application.on(Application.launchEvent, onLaunch);
    Application.on(Application.resumeEvent, onResume);
    androidApp.on(androidApp.activityNewIntentEvent, onNewIntent);
    inject(DestroyRef).onDestroy(() => {
      Application.off(Application.launchEvent, onLaunch);
      Application.off(Application.resumeEvent, onResume);
      androidApp.off(androidApp.activityNewIntentEvent, onNewIntent);
      subscription.unsubscribe();
      pendingId = null;
    });

    // Cold launch may have been emitted before Angular created this root adapter.
    consume(currentIntent());
  }
}
