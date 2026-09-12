# Tool Runtime

`index.ts` is the provider-neutral entry point. This layer registers no production
tools and is not wired into generation, Android UI, persistence, or an agent loop.
The registry and executor are plain TypeScript objects that can be shared for the
application lifetime. No Angular service or session instance is required.

## Contracts

- Names and capability IDs contain at least two dot-separated lowercase segments.
  Each segment starts with a letter and may contain digits or underscores.
  Integrations should own a namespace; capabilities use `capabilityId()` to validate
  dynamic identifiers. Neither tools nor agents have a fixed enum.
- `ExecutableTool` separates `definition`, `validateInput`, optional
  `validateOutput`, and `execute`. Handlers and validators are standalone functions;
  compose explicit service dependencies through closures when registering a tool,
  rather than putting arbitrary application services in `ToolContext`.
- Definitions advertise JSON Schema objects. There is no existing schema library
  in the application, so validation is a required synchronous port, not a homemade
  JSON Schema interpreter. A future Zod/Ajv/native adapter can implement it. The
  input adapter must be pure and side-effect-free: it runs before authorization.
  On success it returns `{ valid: true, data }`, where `data` is the validated,
  optionally normalized value satisfying the advertised schema. The executor
  snapshots that value once for both policy and execution; neither receives raw
  arguments as trusted input. An advertised output schema requires an output validator.
- Model definitions contain only name, description, input schema, and optional
  output schema. Internal capabilities, metadata, timeout settings, validators,
  and handlers are not serialized. Provider-specific schema/name adaptation belongs
  outside this layer, as does provider tool-call normalization.
- `createToolInvocation()` uses the existing application `createId('tool')`
  convention, independent of session identity and `providerToolCallId`. Create a
  fresh invocation for each execution attempt; this is not an idempotency service.
- Invocation and context accept optional `agentId`, `agentRunId`, `sessionId`,
  `turnId`, `messageId`, `modelCallId`, `parentInvocationId`, and `parentAgentRunId`.
  IDs can be supplied in either location, but conflicting values fail closed.
  Normalizers must attach trusted identity, not accept identity from model arguments.
  Authorization principal/attributes come only from the application context.

## Registration And Visibility

`ToolRegistry` supports register, unregister, resolve, has, list, and
modelDefinitions. Duplicate names throw; explicit replacement is unregister then
register. Registered definitions are immutable snapshots. Existing in-flight calls
retain the tool they resolved, while subsequent calls see registration changes.
Unregistering is not a revocation/cancellation mechanism.

`list(context, visible)` and `modelDefinitions(context, visible)` accept a
context-aware visibility predicate. Omission returns all registered definitions;
model-facing callers should supply their agent visibility rule. Visibility is not
execution authority: even visible or zero-capability tools must pass policy.

## Execution And Policy

The executor snapshots JSON input and trusted context, resolves the tool, installs
its deadline, validates/normalizes input, and then calls `PolicyEngine.authorize()`
before execution. Policy sees the tool, all required capabilities, validated immutable
input in `invocation.arguments`, correlation IDs, authorization attributes, and a
cancellation signal. The handler receives that exact same input value, not a second
parse or the original arguments. Parameter-sensitive policies can therefore decide
on the values the handler will use. A single allow decision must cover **all**
capabilities and the requested action.

`DenyAllPolicy` is the default. `AllowAllPolicy` requires explicit opt-in and is
only for development/tests. Denial and confirmation decisions occur after validation
and never run handlers. Unknown tools, invalid input/context/deadlines, validation
failures, and already cancelled requests stop without policy. Every request that
can reach a handler goes through policy, including hidden and zero-capability tools.
Policy failures/malformed decisions never fall back to allow. A future coarse
pre-validation access gate may reject requests early, but must not replace this
parameter-sensitive authorization of validated input.

Results are discriminated by `status`: `success`, `error`, `cancelled`, `denied`, or
`confirmation_required`. Success supports JSON data, optional text and metadata.
Expected handler errors carry a stable code, message, optional details/retryability;
thrown exceptions are normalized with a failure stage and exception type. No raw
stack is exposed. The executor owns invocation identity and timing on all results.
Adapters return finite, acyclic JSON, omitting absent optional properties rather
than explicitly returning `undefined`.

Confirmation is a decision/result contract only: no approval UI, pending queue,
resume token, or implicit retry exists. A future approval service must validate the
approval and reauthorize a fresh invocation against the approved immutable action.

## Cancellation And Timeouts

Each execution gets its own `AbortController`, linked to `context.signal`.
Cancellation races both async policy and handler completion; late resolutions or
rejections cannot produce a second terminal event. Listeners and timers are cleaned
up on completion. Handler-reported cancellation is also supported. An unrelated
thrown `AbortError` without a cancelled signal remains an execution error.

`defaultTimeoutMs` applies to validation plus authorization/execution/output work.
An invocation can override it with `timeoutMs`; `null` disables it and `undefined`
inherits the default. Unset defaults mean no timeout. Timeout returns `cancelled`
with reason `timeout`, and aborts the same signal the policy/handler receives.
Timeouts must be positive integer milliseconds within the platform timer range.

Cancellation is cooperative, not rollback or forced termination. A handler that
ignores its signal can continue side effects after the caller receives cancellation.
Synchronous work cannot be preempted by an event-loop timer. Future native/HTTP
adapters must propagate signals and handle their own cleanup. Tools are trusted
in-process implementations, not sandboxed plugins; arbitrary code can call a
handler directly, so application call sites must use the executor.

## Observability And Sessions

Optional `onEvent` receives `invocation_started`, `authorization_decided`,
`execution_started`, and exactly one `invocation_finished` for each call. The terminal
result distinguishes success, denial, confirmation, failure and cancellation and
includes start/end/duration. Every event carries invocation and correlation IDs;
events deliberately omit authorization credentials. Arguments/metadata/results may
be sensitive: a persistence adapter must redact them as appropriate.
If preflight cannot snapshot input/context, events use `null` arguments and omit
invocation metadata rather than exposing raw, possibly cyclic caller objects.
The start event carries the unvalidated JSON snapshot; after successful validation,
authorization/execution events carry normalized arguments. Observers must not treat
start-event arguments as trusted validated input.

Observer delivery is ordered and best-effort. Exceptions/rejections are isolated;
async observers are not awaited and must queue their own ordered persistence.
No SQLite schema, existing model-call telemetry, or persistence service changes
are needed. Hooks are not a durable security audit log.

Session management should populate optional IDs consistently and pass a per-call
or per-session signal. Closing/deleting a session should abort the signals it owns,
not unregister tools or rebuild this runtime. Multiple sessions and background
workers share the registry/executor without sharing execution cancellation. There
is no global active-call store or persisted session dependency in this foundation.

## Checks

Run focused tests with the existing Node TypeScript resolution loader:

```sh
node --import ./src/test-loader.mjs --test src/core/tools/runtime.test.ts
```

The root tsconfig follows app imports, and this foundation is intentionally not yet
wired into the app. Check the standalone layer (including its tests) explicitly:

```sh
./node_modules/.bin/tsc --ignoreConfig --noEmit --strict --target ES2022 --module esnext --moduleResolution bundler --skipLibCheck --types node --allowImportingTsExtensions src/core/tools/index.ts src/core/tools/runtime.test.ts
./node_modules/.bin/tsc --noEmit
```
