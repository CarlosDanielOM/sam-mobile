import { Injectable, signal } from '@angular/core';
import { inputType, prompt } from '@nativescript/core/ui/dialogs';
import type { AuthEvent, AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai';

export type DeviceCodeState = {
  userCode: string;
  verificationUri: string;
};

@Injectable({ providedIn: 'root' })
export class SamAuthInteraction implements AuthInteraction {
  readonly device = signal<DeviceCodeState | null>(null);
  readonly status = signal('');

  async prompt(authPrompt: AuthPrompt): Promise<string> {
    if (authPrompt.type === 'select') {
      const device = authPrompt.options.find((option) => option.id === 'device_code');
      return device?.id ?? authPrompt.options[0]?.id ?? '';
    }
    if (authPrompt.type === 'secret' || authPrompt.type === 'text') {
      const result = await prompt({
        title: 'SAM',
        message: authPrompt.message,
        okButtonText: 'Save',
        cancelButtonText: 'Cancel',
        inputType: authPrompt.type === 'secret' ? inputType.password : inputType.text,
      });
      if (!result.result) {
        throw new Error('Sign-in cancelled');
      }
      const value = result.text.trim();
      if (!value) {
        throw new Error('No value entered');
      }
      return value;
    }
    throw new Error(`Unsupported login prompt: ${authPrompt.type}`);
  }

  notify(event: AuthEvent): void {
    if (event.type === 'device_code') {
      this.device.set({
        userCode: event.userCode,
        verificationUri: event.verificationUri,
      });
      this.status.set('Enter this code on the provider website, then return here.');
      return;
    }
    if (event.type === 'info' || event.type === 'progress') {
      this.status.set(event.message);
    }
  }

  reset(): void {
    this.device.set(null);
    this.status.set('');
  }
}
