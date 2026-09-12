import { Component, NO_ERRORS_SCHEMA, inject } from '@angular/core';
import { PageRouterOutlet } from '@nativescript/angular';
import { SessionNotificationNavigation } from '../core/android/session-notification-navigation';
import { GenerationManager } from '../core/generation/generation-manager';

@Component({
  selector: 'ns-app',
  templateUrl: './app.component.html',
  imports: [PageRouterOutlet],
  schemas: [NO_ERRORS_SCHEMA],
})
export class AppComponent {
  constructor() {
    inject(GenerationManager);
    inject(SessionNotificationNavigation);
  }
}
