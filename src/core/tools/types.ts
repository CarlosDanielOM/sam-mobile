export type JsonValue = null | boolean | number | string | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

declare const capabilityBrand: unique symbol;
export type CapabilityId = string & { readonly [capabilityBrand]: true };

export type ToolCorrelation = {
  readonly agentId?: string;
  readonly agentRunId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly messageId?: string;
  readonly modelCallId?: string;
  readonly parentInvocationId?: string;
  readonly parentAgentRunId?: string;
};

export type ToolInvocation = ToolCorrelation & {
  readonly id: string;
  readonly toolName: string;
  readonly arguments: unknown;
  readonly providerToolCallId?: string;
  readonly createdAt: number;
  /** Undefined inherits the tool default; null explicitly disables the timeout. */
  readonly timeoutMs?: number | null;
  readonly metadata?: JsonObject;
};

export type ToolContext = ToolCorrelation & {
  readonly signal?: AbortSignal;
  /** Supplied by trusted application code, never copied from model arguments/metadata. */
  readonly authorization?: {
    readonly principalId?: string;
    readonly attributes?: JsonObject;
  };
  readonly metadata?: JsonObject;
};

export type ToolExecutionContext = ToolContext & {
  readonly invocationId: string;
  readonly signal: AbortSignal;
};

/** Provider-neutral and safe to serialize. Internal metadata is deliberately excluded. */
export type ModelToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
};

export type ToolDefinition = ModelToolDefinition & {
  readonly capabilities: readonly CapabilityId[];
  readonly metadata?: JsonObject;
  readonly defaultTimeoutMs?: number | null;
};

export type ValidationIssue = {
  readonly path: string;
  readonly message: string;
  readonly code?: string;
};

export type ValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly issues: readonly ValidationIssue[] };

export type InputValidationResult =
  | { readonly valid: true; readonly data: JsonValue }
  | Extract<ValidationResult, { valid: false }>;

export type ToolError = {
  readonly code: string;
  readonly message: string;
  readonly details?: JsonValue;
  readonly retryable?: boolean;
};

type OutcomeMetadata = { readonly metadata?: JsonObject };

/** Expected failures are returned, not thrown. Only the executor issues policy outcomes. */
export type ToolOutcome = OutcomeMetadata & (
  | { readonly status: 'success'; readonly data?: JsonValue; readonly text?: string }
  | { readonly status: 'error'; readonly error: ToolError }
  | { readonly status: 'cancelled'; readonly reason?: string }
);

export type ExecutableTool = {
  readonly definition: ToolDefinition;
  /** Pure, side-effect-free validation/normalization. Returned data must satisfy the advertised schema. */
  readonly validateInput: (input: unknown) => InputValidationResult;
  readonly validateOutput?: (output: unknown) => ValidationResult;
  readonly execute: (input: JsonValue, context: ToolExecutionContext) => ToolOutcome | Promise<ToolOutcome>;
};

export type PolicyDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string; readonly metadata?: JsonObject }
  | { readonly kind: 'require_confirmation'; readonly reason: string; readonly metadata?: JsonObject };

export type AuthorizationRequest = {
  /** Arguments are validated/normalized and are the exact immutable value passed to the handler. */
  readonly invocation: ToolInvocation & { readonly arguments: JsonValue };
  readonly tool: ToolDefinition;
  /** A single decision must cover ALL required capabilities, including an empty set. */
  readonly capabilities: readonly CapabilityId[];
  readonly context: ToolExecutionContext;
};

export interface PolicyEngine {
  authorize(request: AuthorizationRequest): PolicyDecision | Promise<PolicyDecision>;
}

export type ToolFailureStage = 'context' | 'lookup' | 'policy' | 'input' | 'execution' | 'output';

export type ToolResult = ToolCorrelation & {
  readonly invocationId: string;
  readonly toolName: string;
  readonly providerToolCallId?: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
  readonly failureStage?: ToolFailureStage;
} & (ToolOutcome
  | { readonly status: 'denied'; readonly decision: Extract<PolicyDecision, { kind: 'deny' }> }
  | { readonly status: 'confirmation_required'; readonly decision: Extract<PolicyDecision, { kind: 'require_confirmation' }> }
);

export type ToolVisibility = (tool: ToolDefinition, context: ToolContext) => boolean;

export type ToolExecutionEvent = {
  readonly invocation: ToolInvocation;
  readonly correlation: ToolCorrelation;
  readonly at: number;
} & (
  | { readonly type: 'invocation_started' }
  | { readonly type: 'authorization_decided'; readonly decision: PolicyDecision }
  | { readonly type: 'execution_started' }
  | { readonly type: 'invocation_finished'; readonly result: ToolResult }
);

export type ToolExecutorOptions = {
  readonly policy?: PolicyEngine;
  /** Observers cannot block execution. Async observers must manage their own persistence ordering. */
  readonly onEvent?: (event: ToolExecutionEvent) => void | Promise<void>;
  readonly now?: () => number;
};
