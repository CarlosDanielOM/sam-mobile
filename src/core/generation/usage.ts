import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { GenerationUsage } from '../persistence/types';
import { tokenUsageFromAssistant } from '../telemetry/usage';

export function usageFromAssistant(result: AssistantMessage): GenerationUsage | null {
  const normalized = tokenUsageFromAssistant(result);
  const usage = normalized ? result.usage : null;
  if (!usage) {
    return result.responseId || result.stopReason
      ? {
          ...(result.responseId ? { requestId: result.responseId } : {}),
          ...(result.stopReason ? { finishReason: result.rawStopReason || result.stopReason } : {}),
        }
      : null;
  }
  const next: GenerationUsage = {};
  if (typeof usage.input === 'number') {
    next.inputTokens = usage.input;
    next.uncachedInputTokens = usage.input;
  }
  if (typeof usage.output === 'number') {
    next.outputTokens = usage.output;
  }
  if (typeof usage.cacheRead === 'number') {
    next.cachedTokens = usage.cacheRead;
    next.cacheReadTokens = usage.cacheRead;
  }
  if (typeof usage.cacheWrite === 'number') {
    next.cacheWriteTokens = usage.cacheWrite;
  }
  if (typeof usage.reasoning === 'number') {
    next.reasoningTokens = usage.reasoning;
  }
  if (typeof usage.totalTokens === 'number') {
    next.totalTokens = usage.totalTokens;
  }
  if (usage.cost) {
    next.piCost = { ...usage.cost };
  }
  if (result.responseId) {
    next.requestId = result.responseId;
  }
  if (result.stopReason && result.stopReason !== 'pending') {
    next.finishReason = result.rawStopReason || result.stopReason;
  }
  return Object.keys(next).length ? next : null;
}
