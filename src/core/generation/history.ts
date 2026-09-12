import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import type { MessageRecord } from '../persistence/types';

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function messagesToContext(
  records: MessageRecord[],
  excludeMessageIds: Set<string> = new Set(),
): Message[] {
  const history: Message[] = [];
  for (const record of records) {
    if (excludeMessageIds.has(record.id)) {
      continue;
    }
    if (record.role === 'user') {
      history.push({ role: 'user', content: record.content, timestamp: record.createdAt });
      continue;
    }
    if (!record.content && record.status !== 'completed') {
      continue;
    }
    const parsed = parsedReplayableAssistant(record.payloadJson);
    if (parsed) {
      history.push(parsed);
      continue;
    }
    if (!record.content) {
      continue;
    }
    history.push({
      role: 'assistant',
      content: [{ type: 'text', text: record.content }],
      api: 'openai-completions',
      provider: record.provider || 'unknown',
      model: record.model || 'unknown',
      usage: EMPTY_USAGE,
      stopReason: replayableStatus(record.status) ? 'stop' : 'error',
      timestamp: record.createdAt,
    });
  }
  return history;
}

function replayableStatus(status: MessageRecord['status']): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'interrupted';
}

function parsedReplayableAssistant(payloadJson: string | null): AssistantMessage | null {
  if (!payloadJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(payloadJson) as AssistantMessage;
    if (parsed?.role !== 'assistant') {
      return null;
    }
    if (parsed.stopReason === 'error' || parsed.stopReason === 'aborted') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function titleFromText(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= 40) {
    return trimmed;
  }
  return `${trimmed.slice(0, 37).trimEnd()}...`;
}
