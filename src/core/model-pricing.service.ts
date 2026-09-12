import { Injectable, computed, inject, signal } from '@angular/core';
import { persistence } from './persistence/store';
import { ProviderService } from './provider.service';
import { TelemetryService } from './telemetry/telemetry.service';
import {
  catalogHasPrice,
  formatCachePrice,
  formatDraft,
  formatModelPrice,
  microsToUsd,
  parseOptionalUsdPerMillion,
  parseUsdPerMillion,
  pricedRate,
  usdToMicros,
  type ModelCostRates,
} from './model-pricing';

export type ModelPriceRow = {
  key: string;
  providerId: string;
  modelId: string;
  name: string;
  inputUsd: number | null;
  outputUsd: number | null;
  cacheReadUsd: number | null;
  cacheWriteUsd: number | null;
  source: 'user' | 'catalog' | 'none';
  priceLabel: string;
  cacheLabel: string | null;
  sourceLabel: string | null;
  actionLabel: string;
};

@Injectable({ providedIn: 'root' })
export class ModelPricingService {
  private readonly providers = inject(ProviderService);
  private readonly telemetry = new TelemetryService(persistence().telemetry);
  private readonly revision = signal(0);

  readonly editingKey = signal<string | null>(null);
  readonly draftInput = signal('');
  readonly draftOutput = signal('');
  readonly draftCacheRead = signal('');
  readonly draftCacheWrite = signal('');
  readonly editError = signal<string | null>(null);

  readonly byProvider = computed(() => {
    this.revision();
    const states = this.providers.states();
    const map: Record<string, ModelPriceRow[]> = {};
    for (const [providerId, state] of Object.entries(states)) {
      map[providerId] = state.models.map((model) => this.rowFor(providerId, model.id, model.name));
    }
    return map;
  });

  models(providerId: string): ModelPriceRow[] {
    return this.byProvider()[providerId] ?? [];
  }

  beginEdit(row: ModelPriceRow): void {
    this.editingKey.set(row.key);
    this.draftInput.set(formatDraft(row.inputUsd));
    this.draftOutput.set(formatDraft(row.outputUsd));
    this.draftCacheRead.set(formatDraft(row.cacheReadUsd));
    this.draftCacheWrite.set(formatDraft(row.cacheWriteUsd));
    this.editError.set(null);
  }

  cancelEdit(): void {
    this.editingKey.set(null);
    this.draftInput.set('');
    this.draftOutput.set('');
    this.draftCacheRead.set('');
    this.draftCacheWrite.set('');
    this.editError.set(null);
  }

  onDraftInput(args: unknown): void {
    this.draftInput.set(fieldText(args));
  }

  onDraftOutput(args: unknown): void {
    this.draftOutput.set(fieldText(args));
  }

  onDraftCacheRead(args: unknown): void {
    this.draftCacheRead.set(fieldText(args));
  }

  onDraftCacheWrite(args: unknown): void {
    this.draftCacheWrite.set(fieldText(args));
  }

  saveEdit(row: ModelPriceRow): void {
    const inputUsd = parseUsdPerMillion(this.draftInput());
    const outputUsd = parseUsdPerMillion(this.draftOutput());
    const cacheRead = parseOptionalUsdPerMillion(this.draftCacheRead());
    const cacheWrite = parseOptionalUsdPerMillion(this.draftCacheWrite());
    if (inputUsd === null || outputUsd === null || !cacheRead.ok || !cacheWrite.ok) {
      this.editError.set('Enter USD per million tokens. Leave cache fields blank if the model has no cache price.');
      return;
    }
    try {
      this.telemetry.saveUserModelPricing({
        provider: row.providerId,
        model: row.modelId,
        inputPerMillionMicros: usdToMicros(inputUsd),
        outputPerMillionMicros: usdToMicros(outputUsd),
        cacheReadPerMillionMicros: optionalMicros(cacheRead.value),
        cacheWritePerMillionMicros: optionalMicros(cacheWrite.value),
      });
    } catch (error) {
      this.editError.set(error instanceof Error ? error.message : String(error));
      return;
    }
    this.revision.update((value) => value + 1);
    this.cancelEdit();
  }

  private rowFor(providerId: string, modelId: string, name: string): ModelPriceRow {
    const snapshot = this.telemetry.currentPricing(providerId, modelId);
    const catalog = this.catalogRates(providerId, modelId);
    const user = snapshot?.source === 'user_override' ? snapshot : null;
    const inputUsd = user
      ? usdOrNull(user.inputPerMillionMicros)
      : catalogHasPrice(catalog)
        ? catalog!.input
        : null;
    const outputUsd = user
      ? usdOrNull(user.outputPerMillionMicros)
      : catalogHasPrice(catalog)
        ? catalog!.output
        : null;
    const cacheReadUsd = user
      ? pricedRate(usdOrNull(user.cacheReadPerMillionMicros))
      : pricedRate(catalog?.cacheRead);
    const cacheWriteUsd = user
      ? pricedRate(usdOrNull(user.cacheWritePerMillionMicros))
      : pricedRate(catalog?.cacheWrite);
    const source: ModelPriceRow['source'] = user ? 'user' : catalogHasPrice(catalog) ? 'catalog' : 'none';
    return {
      key: `${providerId}:${modelId}`,
      providerId,
      modelId,
      name,
      inputUsd,
      outputUsd,
      cacheReadUsd,
      cacheWriteUsd,
      source,
      priceLabel: formatModelPrice(inputUsd, outputUsd),
      cacheLabel: formatCachePrice(cacheReadUsd, cacheWriteUsd),
      sourceLabel: source === 'user' ? 'Your price' : source === 'catalog' ? 'Catalog' : null,
      actionLabel: source === 'none' ? 'Add price' : 'Edit price',
    };
  }

  private catalogRates(providerId: string, modelId: string): ModelCostRates | null {
    const model = this.providers.runtime.getModel(providerId, modelId);
    return model?.cost ?? null;
  }
}

function usdOrNull(micros: number | null): number | null {
  return micros === null ? null : microsToUsd(micros);
}

function optionalMicros(usd: number | null): number | null {
  return usd === null ? null : usdToMicros(usd);
}

function fieldText(args: unknown): string {
  return (args as { object?: { text?: string } }).object?.text ?? '';
}
