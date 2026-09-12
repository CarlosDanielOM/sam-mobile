export type ModelCostRates = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export function catalogHasPrice(cost: ModelCostRates | null | undefined): boolean {
  if (!cost) {
    return false;
  }
  return cost.input > 0 || cost.output > 0 || cost.cacheRead > 0 || cost.cacheWrite > 0;
}

export function microsToUsd(micros: number): number {
  return micros / 1_000_000;
}

export function usdToMicros(usd: number): number {
  const micros = Math.round(usd * 1_000_000);
  if (!Number.isSafeInteger(micros) || micros < 0) {
    throw new Error('Pricing rates must be non-negative integer micro-units.');
  }
  return micros;
}

export function parseUsdPerMillion(raw: string): number | null {
  const text = raw.trim().toLowerCase().replace(/,/g, '');
  if (!text) {
    return null;
  }
  const cents = text.match(/^\$?\s*(\d+(?:\.\d+)?)\s*(?:c|¢|cents?)$/);
  if (cents) {
    const value = Number(cents[1]) / 100;
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  const dollars = text.match(/^\$?\s*(\d+(?:\.\d+)?|\.\d+)\s*(?:usd)?$/);
  if (!dollars) {
    return null;
  }
  const value = Number(dollars[1]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function formatUsd(usd: number): string {
  if (usd === 0) {
    return '$0';
  }
  if (usd >= 0.01) {
    return `$${usd.toFixed(2)}`;
  }
  if (usd >= 0.0001) {
    return `$${usd.toFixed(4)}`;
  }
  return `$${usd.toFixed(6)}`;
}

export function pricedRate(usd: number | null | undefined): number | null {
  if (usd === null || usd === undefined || usd <= 0) {
    return null;
  }
  return usd;
}

export function formatModelPrice(inputUsd: number | null, outputUsd: number | null): string {
  if (inputUsd === null && outputUsd === null) {
    return 'No price yet';
  }
  const input = inputUsd === null ? '— in' : `${formatUsd(inputUsd)} in`;
  const output = outputUsd === null ? '— out' : `${formatUsd(outputUsd)} out`;
  return `${input} · ${output}`;
}

export function formatCachePrice(cacheReadUsd: number | null, cacheWriteUsd: number | null): string | null {
  const parts: string[] = [];
  if (pricedRate(cacheReadUsd) !== null) {
    parts.push(`${formatUsd(cacheReadUsd!)} cache read`);
  }
  if (pricedRate(cacheWriteUsd) !== null) {
    parts.push(`${formatUsd(cacheWriteUsd!)} cache write`);
  }
  return parts.length ? parts.join(' · ') : null;
}

export function parseOptionalUsdPerMillion(raw: string): { ok: true; value: number | null } | { ok: false } {
  if (!raw.trim()) {
    return { ok: true, value: null };
  }
  const value = parseUsdPerMillion(raw);
  return value === null ? { ok: false } : { ok: true, value };
}

export function formatDraft(usd: number | null): string {
  if (usd === null) {
    return '';
  }
  if (Number.isInteger(usd)) {
    return String(usd);
  }
  const text = usd.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return text;
}
