import { SamThemeScopeDirective, SamPressDirective, SamRevealDirective } from '../../core/ui';
import { ChangeDetectionStrategy, Component, NO_ERRORS_SCHEMA, inject, signal } from '@angular/core';
import { NativeScriptCommonModule } from '@nativescript/angular';
import { Utils, isAndroid } from '@nativescript/core';
import { ACCOUNT_CATALOG, type AccountEntry } from '../../core/account-catalog';
import { SamAuthInteraction } from '../../core/auth-interaction';
import { ModelPricingService } from '../../core/model-pricing.service';
import { ProviderService } from '../../core/provider.service';
import { DrawerComponent } from '../shell/drawer.component';
import { DrawerService } from '../shell/drawer.service';

@Component({
  selector: 'ns-providers',
  templateUrl: './providers.component.html',
  imports: [NativeScriptCommonModule, DrawerComponent, SamThemeScopeDirective, SamPressDirective, SamRevealDirective],
  schemas: [NO_ERRORS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProvidersComponent {
  readonly providers = inject(ProviderService);
  readonly pricing = inject(ModelPricingService);
  readonly auth = inject(SamAuthInteraction);
  readonly catalog = ACCOUNT_CATALOG;
  readonly drawer = inject(DrawerService);


  readonly copied = signal(false);

  formatCode(code: string): string {
    return code.replace(/(.{3})/g, '$1 ').trim();
  }

  oauthLabel(item: AccountEntry): string {
    return item.methods.length > 1 ? 'Connect subscription' : 'Connect';
  }

  connectionLabel(credentialType: 'oauth' | 'api_key' | null): string {
    return credentialType === 'api_key' ? 'Connected · API key' : 'Connected · subscription';
  }

  copyCode(): void {
    const code = this.auth.device()?.userCode;
    if (!code) {
      return;
    }
    if (isAndroid) {
      const context = Utils.android.getApplicationContext();
      const clipboard = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE);
      clipboard.setPrimaryClip(android.content.ClipData.newPlainText('sam', code));
    } else {
      UIPasteboard.generalPasteboard.string = code;
    }
    this.copied.set(true);
  }

  openVerificationUrl(): void {
    const device = this.auth.device();
    if (!device) {
      return;
    }
    const url = device.userCode
      ? `${device.verificationUri}?user_code=${encodeURIComponent(device.userCode)}`
      : device.verificationUri;
    if (isAndroid) {
      const activity = Utils.android.getCurrentActivity();
      const intent = new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url));
      try {
        intent.setPackage('com.android.chrome');
        activity.startActivity(intent);
        return;
      } catch {
        intent.setPackage(null);
      }
    }
    Utils.openUrl(url);
  }
}
