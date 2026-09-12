import { assertTimeout, correlationKeys, snapshotJson } from './contracts';
import { DenyAllPolicy } from './policy';
import type { ToolRegistry } from './registry';
import type {
  JsonObject, JsonValue, PolicyDecision, PolicyEngine, ToolContext, ToolCorrelation, ToolError, ToolExecutionContext,
  ToolExecutionEvent, ToolExecutorOptions, ToolFailureStage, ToolInvocation, ToolOutcome, ToolResult,
} from './types';

export class ToolExecutor {
  private readonly registry: ToolRegistry;
  private readonly options: ToolExecutorOptions;
  private readonly policy: PolicyEngine;

  constructor(registry: ToolRegistry, options: ToolExecutorOptions = {}) {
    this.registry = registry;
    this.options = options;
    this.policy = options.policy ?? new DenyAllPolicy();
  }

  async execute(invocation: ToolInvocation, context: ToolContext = {}): Promise<ToolResult> {
    const now = this.options.now ?? Date.now;
    const startedAt = now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let stage: ToolFailureStage = 'context';
    const correlation: ToolCorrelation = Object.freeze(Object.fromEntries(correlationKeys
      .map((key) => [key, context[key] ?? invocation[key]])
      .filter(([, value]) => value !== undefined)));
    // Preflight failures still emit safe events, without retaining raw caller objects.
    let request: ToolInvocation & { readonly arguments: JsonValue } = Object.freeze({
      id: invocation.id, toolName: invocation.toolName, createdAt: invocation.createdAt,
      ...correlation, arguments: null,
      ...(invocation.providerToolCallId === undefined ? {} : { providerToolCallId: invocation.providerToolCallId }),
      ...(invocation.timeoutMs === undefined ? {} : { timeoutMs: invocation.timeoutMs }),
    });
    let result: ToolResult;
    let stopWaiting!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      stopWaiting = () => reject(new Error('Tool execution cancelled'));
    });
    // Also observe pre-aborted executions that never enter an async phase.
    void cancelled.catch(() => {});
    controller.signal.addEventListener('abort', stopWaiting, { once: true });
    const abort = () => controller.abort();
    context.signal?.addEventListener('abort', abort, { once: true });
    if (context.signal?.aborted) abort();

    const emit = (event: ToolExecutionEvent): void => {
      try {
        const pending = this.options.onEvent?.(Object.freeze(event));
        if (pending) void Promise.resolve(pending).catch(() => {});
      } catch {
        // Telemetry is best-effort and must not affect authorization or tool results.
      }
    };
    const eventBase = () => ({ invocation: request, correlation, at: now() });
    let started = false;
    const emitStarted = () => {
      if (started) return;
      started = true;
      emit({ ...eventBase(), at: startedAt, type: 'invocation_started' });
    };
    const finish = (outcome: ToolOutcome | { status: 'denied'; decision: Extract<PolicyDecision, { kind: 'deny' }> }
      | { status: 'confirmation_required'; decision: Extract<PolicyDecision, { kind: 'require_confirmation' }> },
    failureStage?: ToolFailureStage): ToolResult => {
      const completedAt = now();
      return Object.freeze({
        ...outcome, ...correlation, invocationId: request.id, toolName: request.toolName,
        ...(outcome.status === 'error' ? { error: snapshotJson(outcome.error) as ToolError } : {}),
        ...(request.providerToolCallId === undefined ? {} : { providerToolCallId: request.providerToolCallId }),
        startedAt, completedAt, durationMs: Math.max(0, completedAt - startedAt),
        ...(failureStage ? { failureStage } : {}),
      });
    };

    const run = async (): Promise<ToolResult> => {
      for (const key of correlationKeys) {
        if (context[key] !== undefined && invocation[key] !== undefined && context[key] !== invocation[key]) {
          throw new Error(`Conflicting ${key} in invocation and execution context`);
        }
      }
      const executionContext: ToolExecutionContext = Object.freeze({
        ...correlation, invocationId: request.id, signal: controller.signal,
        ...(context.authorization === undefined ? {} : { authorization: snapshotJson(context.authorization) as ToolContext['authorization'] }),
        ...(context.metadata === undefined ? {} : { metadata: snapshotJson(context.metadata) as JsonObject }),
      });
      stage = 'input';
      const input = snapshotJson(invocation.arguments);
      request = Object.freeze({
        ...request, ...correlation, arguments: input,
        ...(invocation.metadata === undefined ? {} : { metadata: snapshotJson(invocation.metadata) as JsonObject }),
      });
      emitStarted();
      if (controller.signal.aborted) throw new Error('Cancelled');
      stage = 'lookup';
      const tool = this.registry.resolve(request.toolName);
      if (!tool) return finish({ status: 'error', error: { code: 'unknown_tool', message: `Unknown tool: ${request.toolName}` } }, stage);
      stage = 'input';
      const timeout = request.timeoutMs === undefined ? tool.definition.defaultTimeoutMs : request.timeoutMs;
      assertTimeout(timeout);
      if (timeout != null) timer = setTimeout(() => { timedOut = true; abort(); }, timeout);
      const validation = tool.validateInput(input);
      if (controller.signal.aborted) throw new Error('Cancelled');
      if (validation.valid === false) {
        return finish({ status: 'error', error: {
          code: 'invalid_arguments', message: 'Tool arguments failed validation', details: snapshotJson(validation.issues),
        } }, stage);
      }
      if (validation.valid !== true) throw new Error('Input validator returned an invalid result');
      // Snapshot once: policy and execution must use the same normalized value.
      const validatedInput = snapshotJson(validation.data);
      request = Object.freeze({ ...request, arguments: validatedInput });
      if (controller.signal.aborted) throw new Error('Cancelled');
      stage = 'policy';
      const rawDecision = await Promise.race([
        this.policy.authorize(Object.freeze({
          invocation: request, tool: tool.definition, capabilities: tool.definition.capabilities, context: executionContext,
        })),
        cancelled,
      ]);
      if (controller.signal.aborted) throw new Error('Cancelled');
      const checked = snapshotJson(rawDecision) as PolicyDecision;
      if (!checked || !['allow', 'deny', 'require_confirmation'].includes(checked.kind)
        || (checked.kind !== 'allow' && (typeof checked.reason !== 'string'
          || (checked.metadata !== undefined && (!checked.metadata || typeof checked.metadata !== 'object' || Array.isArray(checked.metadata)))))) {
        throw new Error('Policy returned an invalid decision');
      }
      const decision: PolicyDecision = Object.freeze(checked.kind === 'allow' ? { kind: 'allow' } : {
        kind: checked.kind, reason: checked.reason,
        ...(checked.metadata === undefined ? {} : { metadata: checked.metadata }),
      });
      emit({ ...eventBase(), type: 'authorization_decided', decision });
      if (controller.signal.aborted) throw new Error('Cancelled');
      if (decision.kind === 'deny') return finish({ status: 'denied', decision });
      if (decision.kind === 'require_confirmation') return finish({ status: 'confirmation_required', decision });
      stage = 'execution';
      emit({ ...eventBase(), type: 'execution_started' });
      if (controller.signal.aborted) throw new Error('Cancelled');
      const rawOutcome = await Promise.race([tool.execute(validatedInput, executionContext), cancelled]);
      if (controller.signal.aborted) throw new Error('Cancelled');
      stage = 'output';
      const outcome = snapshotJson(rawOutcome) as ToolOutcome;
      if (!outcome || !['success', 'error', 'cancelled'].includes(outcome.status)
        || (outcome.metadata !== undefined && (!outcome.metadata || typeof outcome.metadata !== 'object' || Array.isArray(outcome.metadata)))
        || (outcome.status === 'error' && (!outcome.error || typeof outcome.error.code !== 'string' || typeof outcome.error.message !== 'string'))
        || (outcome.status === 'error' && outcome.error.retryable !== undefined && typeof outcome.error.retryable !== 'boolean')
        || (outcome.status === 'success' && outcome.text !== undefined && typeof outcome.text !== 'string')
        || (outcome.status === 'cancelled' && outcome.reason !== undefined && typeof outcome.reason !== 'string')) {
        throw new Error('Tool returned an invalid outcome');
      }
      if (outcome.status === 'success' && tool.validateOutput) {
        const validation = tool.validateOutput(outcome.data);
        if (validation.valid === false) {
          return finish({ status: 'error', error: {
            code: 'invalid_output', message: 'Tool output failed validation', details: snapshotJson(validation.issues),
          } }, stage);
        }
        if (validation.valid !== true) throw new Error('Output validator returned an invalid result');
      }
      if (controller.signal.aborted) throw new Error('Cancelled');
      const metadata = outcome.metadata === undefined ? {} : { metadata: outcome.metadata };
      if (outcome.status === 'success') return finish({ status: 'success', ...metadata,
        ...(outcome.data === undefined ? {} : { data: outcome.data }),
        ...(outcome.text === undefined ? {} : { text: outcome.text }),
      });
      if (outcome.status === 'cancelled') return finish({ status: 'cancelled', ...metadata,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      });
      return finish({ status: 'error', error: Object.freeze({
        code: outcome.error.code, message: outcome.error.message,
        ...(outcome.error.details === undefined ? {} : { details: outcome.error.details }),
        ...(outcome.error.retryable === undefined ? {} : { retryable: outcome.error.retryable }),
      }), ...metadata }, 'execution');
    };

    try {
      result = await run();
    } catch (error) {
      emitStarted();
      if (controller.signal.aborted) {
        result = finish({ status: 'cancelled', reason: timedOut ? 'timeout' : 'aborted' }, stage);
      } else {
        result = finish({ status: 'error', error: {
          code: ({ policy: 'policy_error', input: 'invalid_arguments', output: 'invalid_output',
            context: 'invalid_context', lookup: 'unknown_tool', execution: 'tool_exception' })[stage],
          message: error instanceof Error ? error.message : 'Tool runtime failed with a non-Error exception',
          details: error instanceof Error ? { name: error.name } : { thrownType: typeof error },
        } }, stage);
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      context.signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', stopWaiting);
    }
    emit({ ...eventBase(), type: 'invocation_finished', result });
    return result;
  }
}
