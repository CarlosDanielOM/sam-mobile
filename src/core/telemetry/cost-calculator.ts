import type { PricingSnapshotRecord, TokenUsage, UsageSource } from './types';

export type CalculatedCost = {
  amountMicros: number;
  currency: string;
  pricingSnapshotId: string;
  source: UsageSource;
};

type CostDimension = { tokens: number | null; rate: number | null };

function safeNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new Error('Calculated monetary value exceeds the safe integer range.');
  }
  return result;
}

function roundedDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function selectedUsage(usage: TokenUsage): {
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  reasoning: number | null;
  source: UsageSource;
} {
  // Select the best value per dimension: provider-reported values win, local
  // estimates fill gaps. Mixing is tracked so a partially estimated cost is
  // never presented as fully provider-reported.
  const pick = (reported: number | null, estimated: number | null): { value: number | null; reported: boolean } =>
    reported !== null ? { value: reported, reported: true } : { value: estimated, reported: false };
  const input = pick(
    usage.reportedUncachedInputTokens ?? usage.reportedInputTokens,
    usage.estimatedUncachedInputTokens ?? usage.estimatedInputTokens,
  );
  const cacheRead = pick(usage.reportedCacheReadTokens, usage.estimatedCacheReadTokens);
  const cacheWrite = pick(usage.reportedCacheWriteTokens, usage.estimatedCacheWriteTokens);
  const output = pick(usage.reportedOutputTokens, usage.estimatedOutputTokens);
  const reasoning = pick(usage.reportedReasoningTokens, usage.estimatedReasoningTokens);
  const dimensions = [input, cacheRead, cacheWrite, output, reasoning];
  const known = dimensions.filter((dimension) => dimension.value !== null);
  const source: UsageSource = !known.length
    ? 'unknown'
    : known.every((dimension) => dimension.reported)
      ? // Reported values drive every priced dimension; keep record-level 'mixed'
        // provenance visible instead of upgrading it to authoritative.
        usage.source === 'provider_reported' || usage.source === 'unknown'
        ? 'provider_reported'
        : 'mixed'
      : known.every((dimension) => !dimension.reported)
        ? 'locally_estimated'
        : 'mixed';
  return {
    input: input.value,
    cacheRead: cacheRead.value,
    cacheWrite: cacheWrite.value,
    output: output.value,
    reasoning: reasoning.value,
    source,
  };
}

function validDimension({ tokens, rate }: CostDimension): boolean {
  if (tokens === null) {
    return rate === null;
  }
  return tokens === 0 || rate !== null;
}

export function calculateApiEquivalentCost(
  usage: TokenUsage,
  pricing: PricingSnapshotRecord,
): CalculatedCost | null {
  const selected = selectedUsage(usage);
  const hasAnyUsage = [
    selected.input,
    selected.cacheRead,
    selected.cacheWrite,
    selected.output,
    selected.reasoning,
  ].some((value) => value !== null);
  if (!hasAnyUsage) {
    return null;
  }

  let regularOutput = selected.output;
  let separatelyPricedReasoning: number | null = null;
  if (pricing.reasoningPerMillionMicros !== null) {
    if (selected.output === null || selected.reasoning === null) {
      return null;
    }
    regularOutput = Math.max(0, selected.output - selected.reasoning);
    separatelyPricedReasoning = selected.reasoning;
  }

  const dimensions: CostDimension[] = [
    { tokens: selected.input, rate: pricing.inputPerMillionMicros },
    { tokens: selected.cacheRead, rate: pricing.cacheReadPerMillionMicros },
    { tokens: selected.cacheWrite, rate: pricing.cacheWritePerMillionMicros },
    { tokens: regularOutput, rate: pricing.outputPerMillionMicros },
    { tokens: separatelyPricedReasoning, rate: pricing.reasoningPerMillionMicros },
  ];
  if (!dimensions.every(validDimension)) {
    return null;
  }

  let numerator = 0n;
  for (const dimension of dimensions) {
    if (dimension.tokens === null || dimension.tokens === 0 || dimension.rate === null) {
      continue;
    }
    if (
      !Number.isSafeInteger(dimension.tokens) ||
      !Number.isSafeInteger(dimension.rate) ||
      dimension.tokens < 0 ||
      dimension.rate < 0
    ) {
      throw new Error('Token counts and pricing rates must be non-negative safe integers.');
    }
    numerator += BigInt(dimension.tokens) * BigInt(dimension.rate);
  }

  return {
    amountMicros: safeNumber(roundedDivide(numerator, 1_000_000n)),
    currency: pricing.currency,
    pricingSnapshotId: pricing.id,
    source: selected.source,
  };
}
