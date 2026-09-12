import './core/register-oauth';
import { SamUiTheme } from './core/ui/theme.service';
import { AppAppearance } from './core/ui/app-appearance.service';
import {
  bootstrapApplication,
  provideNativeScriptHttpClient,
  provideNativeScriptRouter,
  runNativeScriptAngularApp,
} from '@nativescript/angular';
import { provideZonelessChangeDetection } from '@angular/core';
import { withInterceptorsFromDi } from '@angular/common/http';
import { routes } from './app/app.routes';
import { AppComponent } from './app/app.component';
import { installWarmActivityRelaunch } from './core/android/warm-relaunch';

installWarmActivityRelaunch();
runNativeScriptAngularApp({
  appModuleBootstrap: () => {
    return bootstrapApplication(AppComponent, {
      providers: [
        { provide: SamUiTheme, useExisting: AppAppearance },
        provideNativeScriptHttpClient(withInterceptorsFromDi()),
        provideNativeScriptRouter(routes),
        provideZonelessChangeDetection(),
      ],
    });
  },
});
