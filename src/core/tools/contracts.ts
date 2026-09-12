import { createId } from '../generation/ids';
import type { CapabilityId, JsonValue, ToolCorrelation, ToolInvocation } from './types';

// At least two lowercase segments; providers can use underscores within a segment.
const namespacedId = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export function assertToolName(name: string): void {
  if (typeof name !== 'string' || !namespacedId.test(name)) {
    throw new Error(`Invalid namespaced tool name: ${name}`);
  }
}

export function capabilityId(value: string): CapabilityId {
  if (typeof value !== 'string' || !namespacedId.test(value)) {
    throw new Error(`Invalid namespaced capability ID: ${value}`);
  }
  return value as CapabilityId;
}

export function assertTimeout(value: number | null | undefined): void {
  if (value != null && (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647)) {
    throw new Error('Timeout must be a positive integer up to 2147483647 ms, null, or undefined');
  }
}

export function createToolInvocation(
  input: Omit<ToolInvocation, 'id' | 'createdAt'>,
): ToolInvocation {
  assertToolName(input.toolName);
  assertTimeout(input.timeoutMs);
  return Object.freeze({ ...input, id: createId('tool'), createdAt: Date.now() });
}

export const correlationKeys = [
  'agentId', 'agentRunId', 'sessionId', 'turnId', 'messageId', 'modelCallId',
  'parentInvocationId', 'parentAgentRunId',
] as const satisfies readonly (keyof ToolCorrelation)[];

/** Snapshot JSON at async boundaries so authorization and execution see the same values. */
export function snapshotJson(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('Expected finite, acyclic JSON data');
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error('Expected a plain JSON object');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(Array.from(value, (item) => snapshotJson(item, ancestors)));
    }
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, snapshotJson(item, ancestors)]),
    ));
  } finally {
    ancestors.delete(value);
  }
}
