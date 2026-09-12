import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { TokenUsage, UsageSource } from './types';

export function emptyTokenUsage(source: UsageSource = 'unknown'): TokenUsage {
  return {
    reportedInputTokens: null,
    reportedUncachedInputTokens: null,
    reportedCacheReadTokens: null,
    reportedCacheWriteTokens: null,
    reportedOutputTokens: null,
    reportedReasoningTokens: null,
    reportedTotalTokens: null,
    estimatedInputTokens: null,
    estimatedUncachedInputTokens: null,
    estimatedCacheReadTokens: null,
    estimatedCacheWriteTokens: null,
    estimatedOutputTokens: null,
    estimatedReasoningTokens: null,
    estimatedTotalTokens: null,
    source,
    provenanceJson: null,
    providerUsageJson: null,
    contextComponentsJson: null,
    modalityUsageJson: null,
  };
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function tokenUsageFromAssistant(result: AssistantMessage): TokenUsage | null {
  const usage = result.usage as Partial<AssistantMessage['usage']> | undefined;
  if (!usage) {
    return null;
  }
  const reportedValues = [
    usage.input,
    usage.cacheRead,
    usage.cacheWrite,
    usage.output,
    usage.reasoning,
    usage.totalTokens,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  // Pi uses all-zero usage before receiving measurements, even after a response
  // id arrives. It does not expose a flag distinguishing that from measured zero.
  if (reportedValues.length > 0 && reportedValues.every((value) => value === 0)) {
    return null;
  }
  const normalized = emptyTokenUsage('provider_reported');
  // Pi normalizes `input` as uncached input and exposes cache reads/writes separately.
  normalized.reportedUncachedInputTokens = finite(usage.input);
  normalized.reportedCacheReadTokens = finite(usage.cacheRead);
  normalized.reportedCacheWriteTokens = finite(usage.cacheWrite);
  normalized.reportedOutputTokens = finite(usage.output);
  normalized.reportedReasoningTokens = finite(usage.reasoning);
  normalized.reportedTotalTokens = finite(usage.totalTokens);

  const provenance: Record<string, UsageSource> = {};
  for (const [key, value] of Object.entries({
    uncachedInputTokens: normalized.reportedUncachedInputTokens,
    cacheReadTokens: normalized.reportedCacheReadTokens,
    cacheWriteTokens: normalized.reportedCacheWriteTokens,
    outputTokens: normalized.reportedOutputTokens,
    reasoningTokens: normalized.reportedReasoningTokens,
    totalTokens: normalized.reportedTotalTokens,
  })) {
    if (value !== null) {
      provenance[key] = 'provider_reported';
    }
  }
  normalized.provenanceJson = Object.keys(provenance).length ? JSON.stringify(provenance) : null;
  normalized.providerUsageJson = JSON.stringify(usage);
  return Object.values(normalized).some((value) => typeof value === 'number') ? normalized : null;
}

const TOKEN_KEYS = [
  'reportedInputTokens',
  'reportedUncachedInputTokens',
  'reportedCacheReadTokens',
  'reportedCacheWriteTokens',
  'reportedOutputTokens',
  'reportedReasoningTokens',
  'reportedTotalTokens',
  'estimatedInputTokens',
  'estimatedUncachedInputTokens',
  'estimatedCacheReadTokens',
  'estimatedCacheWriteTokens',
  'estimatedOutputTokens',
  'estimatedReasoningTokens',
  'estimatedTotalTokens',
] as const;

export function aggregateTokenUsage(usages: (TokenUsage | null)[]): TokenUsage | null {
  if (!usages.length || usages.every((usage) => usage === null)) {
    return null;
  }
  const result = emptyTokenUsage();
  for (const key of TOKEN_KEYS) {
    const values = usages.map((usage) => usage?.[key] ?? null);
    result[key] = values.some((value) => value === null)
      ? null
      : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  }
  const sources = new Set(usages.filter(Boolean).map((usage) => usage!.source));
  result.source = sources.size === 1 && !usages.includes(null) ? [...sources][0] : 'mixed';
  result.provenanceJson = JSON.stringify({ aggregation: result.source, attemptCount: usages.length });
  return result;
}
