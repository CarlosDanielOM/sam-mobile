import { ACCOUNT_CATALOG } from './account-catalog';
import type { AgentRunAttribution, BillingMode } from './telemetry/types';
import { sumKnown, type TurnUsageDetail } from './telemetry/telemetry.service';

export type TurnUsageRow = { label: string; value: string; indent: boolean };

export type TurnUsageView = {
  title: string;
  apiEquivalent: string;
  metered: string;
  showAgents: boolean;
  turnTotal: string | null;
  agents: { label: string; cost: string }[];
  rows: TurnUsageRow[];
};

const DASH = '—';

export function formatMoney(micros: number | null, currency: string | null = 'USD'): string {
  if (micros === null) {
    return DASH;
  }
  const amount = micros / 1_000_000;
  const text =
    amount === 0
      ? '0.0000'
      : amount >= 1
        ? amount.toFixed(2)
        : amount >= 0.0001
          ? amount.toFixed(4)
          : amount.toFixed(6);
  if (!currency || currency === 'USD') {
    return `$${text}`;
  }
  return `${text} ${currency}`;
}

export function formatCount(value: number | null): string {
  return value === null ? DASH : String(value);
}

export function formatTokens(value: number | null): string {
  if (value === null) {
    return DASH;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(value);
}

export function formatDuration(ms: number | null): string {
  if (ms === null) {
    return DASH;
  }
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  return `${Math.round(ms)} ms`;
}

export function formatSpeed(tokensPerSecondMilli: number | null): string {
  if (tokensPerSecondMilli === null) {
    return DASH;
  }
  const rate = tokensPerSecondMilli / 1000;
  const text = rate >= 10 ? String(Math.round(rate)) : rate.toFixed(1);
  return `${text} tok/s`;
}

export function flattenAgentCosts(nodes: AgentRunAttribution[]): { label: string; cost: string }[] {
  const rows: { label: string; cost: string }[] = [];
  const walk = (list: AgentRunAttribution[], prefix: string, rooted: boolean): void => {
    list.forEach((node, index) => {
      const last = index === list.length - 1;
      const name = node.agentRun.agentNameSnapshot;
      const label = rooted ? name : `${prefix}${last ? '└─ ' : '├─ '}${name}`;
      rows.push({
        label,
        cost: formatMoney(node.apiEquivalent.selfMicros, node.apiEquivalent.currency),
      });
      walk(node.children, rooted ? '' : `${prefix}${last ? '   ' : '│  '}`, false);
    });
  };
  walk(nodes, '', true);
  return rows;
}

function billingLabel(mode: BillingMode): string | null {
  if (mode === 'subscription') {
    return 'subscription';
  }
  if (mode === 'api') {
    return 'API';
  }
  if (mode === 'token_plan') {
    return 'token plan';
  }
  if (mode === 'free' || mode === 'local') {
    return mode;
  }
  return null;
}

function providerLabel(providerId: string, fallback: string): string {
  return ACCOUNT_CATALOG.find((entry) => entry.id === providerId)?.name ?? fallback;
}

function accountLine(label: string, mode: BillingMode): string {
  const billing = billingLabel(mode);
  return billing ? `${label} ${billing}` : label;
}

function meteredLine(detail: TurnUsageDetail): string {
  const amount = formatMoney(detail.meteredMicros, detail.meteredCurrency);
  const billing = billingLabel(detail.billingMode);
  if (detail.billingMode === 'subscription' || detail.billingMode === 'token_plan' || detail.billingMode === 'free') {
    return billing ? `${amount} / ${billing}` : amount;
  }
  return amount;
}

export function formatTurnUsage(detail: TurnUsageDetail, modelName?: string | null): TurnUsageView {
  const agents = flattenAgentCosts(detail.attribution);
  const showAgents = agents.length > 1;
  let turnTotal: string | null = null;
  if (showAgents) {
    // Each root already includes its descendants; retries add separate roots.
    const total = sumKnown(detail.attribution.map(({ apiEquivalent }) => ({
      amount: apiEquivalent.currency === null ? null : apiEquivalent.totalMicros,
      currency: apiEquivalent.currency,
    })));
    turnTotal = formatMoney(total.currency === null ? null : total.amount, total.currency);
    if (total.currency !== null && (total.hasUnknown || detail.attribution.some((root) => root.apiEquivalent.hasUnknown))) {
      turnTotal += '+';
    }
  }
  return {
    title: `${detail.agentName} turn`,
    apiEquivalent: formatMoney(detail.apiEquivalentMicros, detail.apiEquivalentCurrency),
    metered: meteredLine(detail),
    showAgents,
    turnTotal,
    agents,
    rows: [
      { label: 'Input', value: '', indent: false },
      { label: 'uncached', value: formatCount(detail.uncachedInputTokens), indent: true },
      { label: 'cache read', value: formatCount(detail.cacheReadTokens), indent: true },
      { label: 'cache write', value: formatCount(detail.cacheWriteTokens), indent: true },
      { label: 'Output', value: formatCount(detail.outputTokens), indent: false },
      { label: 'Reasoning', value: formatCount(detail.reasoningTokens), indent: false },
      { label: 'TTFT', value: formatDuration(detail.ttftMs), indent: false },
      { label: 'Latency', value: formatDuration(detail.latencyMs), indent: false },
      { label: 'Speed', value: formatSpeed(detail.tokensPerSecondMilli), indent: false },
      { label: 'Provider', value: providerLabel(detail.providerId, detail.accountLabel), indent: false },
      { label: 'Model', value: modelName || detail.modelId, indent: false },
      { label: 'Account', value: accountLine(detail.accountLabel, detail.billingMode), indent: false },
    ],
  };
}
