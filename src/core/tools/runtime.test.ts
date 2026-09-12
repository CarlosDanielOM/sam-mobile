import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AllowAllPolicy, capabilityId, createToolInvocation, ToolExecutor, ToolRegistry,
} from './index.ts';
import type {
  AuthorizationRequest, ExecutableTool, InputValidationResult, JsonObject, JsonValue, PolicyDecision, ToolContext,
  ToolExecutionContext, ToolExecutionEvent, ToolOutcome, ToolVisibility,
} from './index.ts';

function fakeTool(overrides: Partial<ExecutableTool> = {}): ExecutableTool {
  return {
    definition: {
      name: 'test.echo', description: 'Fake tool for runtime tests only',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      capabilities: [capabilityId('test.read')], metadata: { source: 'private-test-provider' },
    },
    validateInput: (input) => {
      if (input && typeof input === 'object' && !Array.isArray(input)
        && typeof (input as JsonObject).value === 'string' && Object.keys(input).length === 1) return { valid: true, data: input as JsonObject };
      return { valid: false, issues: [{ path: '/value', code: 'required_string', message: 'Expected a single string value' }] };
    },
    execute: (input) => ({ status: 'success', data: input, text: 'Test output' }),
    ...overrides,
  };
}

function invocation(input: Partial<Parameters<typeof createToolInvocation>[0]> = {}) {
  return createToolInvocation({ toolName: 'test.echo', arguments: { value: 'hello' }, ...input });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(tool = fakeTool()) {
  const registry = new ToolRegistry();
  registry.register(tool);
  return { registry, executor: new ToolExecutor(registry, { policy: new AllowAllPolicy() }) };
}

test('registry registers, resolves, lists and unregisters tools without executing them', () => {
  let calls = 0;
  const { registry } = setup(fakeTool({ execute: () => { calls++; return { status: 'success' }; } }));
  assert.equal(registry.has('test.echo'), true);
  assert.equal(registry.resolve('test.echo')?.definition.name, 'test.echo');
  assert.equal(registry.list().length, 1);
  assert.equal(registry.unregister('test.echo'), true);
  assert.equal(registry.unregister('test.echo'), false);
  assert.equal(registry.has('test.echo'), false);
  assert.equal(registry.resolve('test.echo'), undefined);
  assert.deepEqual(registry.list(), []);
  assert.equal(calls, 0);
});

test('duplicates are rejected; unregister then register is explicit replacement', () => {
  const { registry } = setup();
  assert.throws(() => registry.register(fakeTool()), /already registered/);
  registry.unregister('test.echo');
  const replacement = fakeTool({ execute: () => ({ status: 'success', text: 'replacement' }) });
  registry.register(replacement);
  assert.equal(registry.resolve('test.echo')?.execute, replacement.execute);
});

test('names and capabilities are extensible validated identifiers, not enums', () => {
  const { registry } = setup();
  for (const name of ['vendor_42.worker_9.inspect', 'test.other']) {
    registry.register(fakeTool({ definition: { ...fakeTool().definition, name, capabilities: [capabilityId('vendor_42.custom_action')] } }));
    assert.equal(registry.has(name), true);
  }
  for (const name of ['echo', 'Test.echo', 'test..echo', 'test.echo-', '.test', 'test.echo\n']) {
    assert.throws(() => registry.register(fakeTool({ definition: { ...fakeTool().definition, name } })));
    assert.throws(() => capabilityId(name));
  }
});

test('registration snapshots contracts and model definitions expose only public fields', () => {
  const inputSchema = { type: 'object', properties: { value: { type: 'string' } } };
  const capabilities = [capabilityId('test.read')];
  const { registry } = setup(fakeTool({ definition: { ...fakeTool().definition, inputSchema, capabilities } }));
  inputSchema.properties.value.type = 'number';
  capabilities.length = 0;
  assert.deepEqual(registry.list()[0].capabilities, [capabilityId('test.read')]);
  assert.deepEqual(JSON.parse(JSON.stringify(registry.modelDefinitions())), [{
    name: 'test.echo', description: 'Fake tool for runtime tests only',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  }]);
  assert.ok(Object.isFrozen(registry.resolve('test.echo')));
  assert.ok(Object.isFrozen(registry.list()[0].inputSchema));
});

test('input validation is mandatory and advertised output schemas require a validator', () => {
  const registry = new ToolRegistry();
  assert.throws(() => registry.register(fakeTool({ validateInput: undefined })), /validator/);
  assert.throws(() => registry.register(fakeTool({ definition: {
    ...fakeTool().definition, outputSchema: { type: 'object' },
  } })), /output validator/);
});

test('visibility can differ by arbitrary agent and session without granting execution', async () => {
  const { registry } = setup();
  registry.register(fakeTool({ definition: { ...fakeTool().definition, name: 'other.inspect' } }));
  const visible: ToolVisibility = (tool, context) => context.agentId === 'temporary-worker-943'
    ? tool.name === 'test.echo' : context.sessionId === 'session-b' && tool.name === 'other.inspect';
  assert.deepEqual(registry.modelDefinitions({ agentId: 'temporary-worker-943' }, visible).map((tool) => tool.name), ['test.echo']);
  assert.deepEqual(registry.list({ sessionId: 'session-b' }, visible).map((tool) => tool.name), ['other.inspect']);
  assert.deepEqual(registry.modelDefinitions({}, visible), []);
  assert.equal((await new ToolExecutor(registry).execute(invocation(), { agentId: 'temporary-worker-943' })).status, 'denied');
});

test('invocation IDs are independent of provider calls and sessions', () => {
  const calls = Array.from({ length: 1000 }, () => invocation({ providerToolCallId: 'provider-call-1' }));
  assert.equal(new Set(calls.map((call) => call.id)).size, calls.length);
  assert.ok(calls.every((call) => call.id.startsWith('tool_') && call.id !== call.providerToolCallId));
  assert.equal(calls[0].sessionId, undefined);
  assert.equal(calls[0].turnId, undefined);
  assert.equal(typeof calls[0].createdAt, 'number');
});

test('valid arguments return structured success, text, correlation and timing', async () => {
  const { registry } = setup();
  let now = 100;
  const executor = new ToolExecutor(registry, { policy: new AllowAllPolicy(), now: () => now++ });
  const call = invocation({ providerToolCallId: 'external-17' });
  const result = await executor.execute(call);
  assert.equal(result.status, 'success');
  if (result.status !== 'success') return;
  assert.deepEqual(result.data, { value: 'hello' });
  assert.equal(result.text, 'Test output');
  assert.equal(result.invocationId, call.id);
  assert.equal(result.providerToolCallId, 'external-17');
  assert.equal(result.startedAt, 100);
  assert.equal(result.durationMs, result.completedAt - result.startedAt);
  assert.ok(result.durationMs >= 0);
});

for (const [label, args] of [['wrong type', { value: 42 }], ['missing required', {}], ['extra field', { value: 'ok', extra: true }]] as const) {
  test(`invalid arguments: ${label}; neither policy nor handler is called`, async () => {
    let calls = 0;
    let authorizations = 0;
    const { registry } = setup(fakeTool({ execute: () => { calls++; return { status: 'success' }; } }));
    const result = await new ToolExecutor(registry, { policy: { authorize: () => { authorizations++; return { kind: 'allow' }; } } })
      .execute(invocation({ arguments: args }));
    assert.equal(result.status, 'error');
    if (result.status !== 'error') return;
    assert.equal(result.error.code, 'invalid_arguments');
    assert.equal(result.failureStage, 'input');
    assert.deepEqual(result.error.details, [{ path: '/value', code: 'required_string', message: 'Expected a single string value' }]);
    assert.equal(calls, 0);
    assert.equal(authorizations, 0);
  });
}

test('non-JSON arguments are rejected at the transport boundary', async () => {
  const { executor } = setup();
  for (const arguments_ of [undefined, { value: NaN }, { value: new Date() }, { value: () => {} }]) {
    const result = await executor.execute(invocation({ arguments: arguments_ }));
    assert.equal(result.status, 'error');
    if (result.status === 'error') assert.equal(result.error.code, 'invalid_arguments');
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal((await executor.execute(invocation({ arguments: cyclic }))).status, 'error');
});

const blockedDecisions: PolicyDecision[] = [
  { kind: 'deny', reason: 'Agent lacks authority', metadata: { ruleId: 'rule-1' } },
  { kind: 'require_confirmation', reason: 'Approval needed', metadata: { requestId: 'approval-1' } },
];
for (const decision of blockedDecisions) {
  test(`${decision.kind} follows validation and prevents execution`, async () => {
    const calls: string[] = [];
    const { registry } = setup(fakeTool({
      validateInput: (input) => { calls.push('validate'); return fakeTool().validateInput(input); },
      execute: () => { calls.push('execute'); return { status: 'success' }; },
    }));
    const result = await new ToolExecutor(registry, { policy: { authorize: () => { calls.push('policy'); return decision; } } }).execute(invocation());
    assert.equal(result.status, decision.kind === 'deny' ? 'denied' : 'confirmation_required');
    if (result.status === 'denied' || result.status === 'confirmation_required') assert.deepEqual(result.decision, decision);
    assert.deepEqual(calls, ['validate', 'policy']);
  });
}

test('policy receives all capabilities, action input, agent and trusted authorization', async () => {
  let request: AuthorizationRequest | undefined;
  const capabilities = [capabilityId('test.read'), capabilityId('test.write')];
  const { registry } = setup(fakeTool({ definition: { ...fakeTool().definition, capabilities } }));
  const result = await new ToolExecutor(registry, { policy: { authorize: (input) => { request = input; return { kind: 'allow' }; } } })
    .execute(invocation({ metadata: { principalId: 'untrusted' } }), {
      agentId: 'arbitrary-agent-xyz', authorization: { principalId: 'trusted', attributes: { role: 'test' } },
    });
  assert.equal(result.status, 'success');
  assert.deepEqual(request?.capabilities, capabilities);
  assert.deepEqual(request?.invocation.arguments, { value: 'hello' });
  assert.equal(request?.context.agentId, 'arbitrary-agent-xyz');
  assert.equal(request?.invocation.agentId, 'arbitrary-agent-xyz');
  assert.equal(request?.context.authorization?.principalId, 'trusted');
  assert.equal(request?.tool.name, 'test.echo');
});

test('zero-capability tools still go through policy, including the default deny policy', async () => {
  const { registry } = setup(fakeTool({ definition: { ...fakeTool().definition, capabilities: [] } }));
  let calls = 0;
  const executor = new ToolExecutor(registry, { policy: { authorize: (request) => {
    calls++;
    assert.deepEqual(request.capabilities, []);
    return { kind: 'allow' };
  } } });
  assert.equal((await executor.execute(invocation())).status, 'success');
  assert.equal(calls, 1);
  assert.equal((await new ToolExecutor(registry).execute(invocation())).status, 'denied');
});

test('policy exceptions and malformed decisions fail closed', async () => {
  let executions = 0;
  const { registry } = setup(fakeTool({ execute: () => { executions++; return { status: 'success' }; } }));
  for (const authorize of [
    () => { throw new Error('Policy unavailable'); },
    async () => { throw new Error('Async policy unavailable'); },
    () => ({ kind: 'unexpected' }) as unknown as PolicyDecision,
    () => null as unknown as PolicyDecision,
  ]) {
    const result = await new ToolExecutor(registry, { policy: { authorize } }).execute(invocation());
    assert.equal(result.status, 'error');
    if (result.status === 'error') {
      assert.equal(result.error.code, 'policy_error');
      assert.equal(result.failureStage, 'policy');
    }
  }
  assert.equal(executions, 0);
});

test('expected tool failures preserve structured error and metadata', async () => {
  const error = { code: 'test_unavailable', message: 'Fake backend unavailable', retryable: true, details: { source: 'fake' } };
  const { executor } = setup(fakeTool({ execute: () => ({ status: 'error', error, metadata: { traceId: 'trace-1' } }) }));
  const result = await executor.execute(invocation());
  assert.equal(result.status, 'error');
  if (result.status !== 'error') return;
  assert.deepEqual(result.error, error);
  assert.deepEqual(result.metadata, { traceId: 'trace-1' });
  assert.equal(result.failureStage, 'execution');
});

for (const thrown of [new TypeError('Fake failure'), 'non-Error failure']) {
  test(`sync and async tool exceptions are normalized (${typeof thrown})`, async () => {
    for (const execute of [() => { throw thrown; }, async () => { throw thrown; }]) {
      const { executor } = setup(fakeTool({ execute }));
      const result = await executor.execute(invocation());
      assert.equal(result.status, 'error');
      if (result.status !== 'error') return;
      assert.equal(result.error.code, 'tool_exception');
      assert.equal(result.failureStage, 'execution');
      assert.ok(result.error.details);
    }
  });
}

test('invalid handler outcomes and advertised output validation are normalized', async () => {
  for (const outcome of [undefined, { status: 'denied' }, { status: 'error' }, { status: 'success', text: 1 }]) {
    const { executor } = setup(fakeTool({ execute: () => outcome as unknown as ToolOutcome }));
    const result = await executor.execute(invocation());
    assert.equal(result.status, 'error');
    if (result.status === 'error') assert.equal(result.error.code, 'invalid_output');
  }
  const { executor, registry } = setup(fakeTool({
    definition: { ...fakeTool().definition, outputSchema: { type: 'number' } },
    validateOutput: () => ({ valid: false, issues: [{ path: '', message: 'Expected number' }] }),
  }));
  assert.deepEqual(registry.modelDefinitions()[0].outputSchema, { type: 'number' });
  const result = await executor.execute(invocation());
  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.equal(result.error.code, 'invalid_output');
});

test('unknown tools return a normalized lookup error', async () => {
  const result = await new ToolExecutor(new ToolRegistry()).execute(invocation());
  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.equal(result.error.code, 'unknown_tool');
  assert.equal(result.failureStage, 'lookup');
});

test('registry changes are visible to the same executor and in-flight resolutions remain stable', async () => {
  const registry = new ToolRegistry();
  const gate = deferred<PolicyDecision>();
  const entered = deferred<void>();
  const executor = new ToolExecutor(registry, { policy: { authorize: () => { entered.resolve(); return gate.promise; } } });
  registry.register(fakeTool());
  const running = executor.execute(invocation());
  await entered.promise;
  registry.unregister('test.echo');
  registry.register(fakeTool({ execute: () => ({ status: 'success', text: 'new' }) }));
  gate.resolve({ kind: 'allow' });
  const first = await running;
  const second = await executor.execute(invocation());
  assert.equal(first.status === 'success' && first.text, 'Test output');
  assert.equal(second.status === 'success' && second.text, 'new');
  registry.unregister('test.echo');
  assert.equal((await executor.execute(invocation())).status, 'error');
});

test('optional correlation IDs propagate without coupling registry or executor to sessions', async () => {
  const contexts: ToolExecutionContext[] = [];
  const { executor } = setup(fakeTool({ execute: (_, context) => { contexts.push(context); return { status: 'success' }; } }));
  const ids = {
    agentId: 'temporary/agent/963', agentRunId: 'run-1', sessionId: 'session-1', turnId: 'turn-1',
    messageId: 'message-1', modelCallId: 'model-1', parentInvocationId: 'parent-tool-1', parentAgentRunId: 'parent-run-1',
  };
  const first = invocation(ids);
  const results = await Promise.all([
    executor.execute(first), executor.execute(invocation(), { sessionId: 'session-2', agentId: 'another-worker' }),
    executor.execute(invocation()),
  ]);
  for (const key of Object.keys(ids) as (keyof typeof ids)[]) {
    assert.equal(contexts[0][key], ids[key]);
    assert.equal(results[0][key], ids[key]);
  }
  assert.equal(contexts[0].invocationId, first.id);
  assert.equal(contexts[1].sessionId, 'session-2');
  assert.equal(contexts[2].sessionId, undefined);
  assert.equal(contexts[2].turnId, undefined);
  assert.ok(results.every((result) => result.status === 'success'));
});

test('conflicting invocation/context identities fail before authorization', async () => {
  let calls = 0;
  const { registry } = setup();
  const result = await new ToolExecutor(registry, { policy: { authorize: () => { calls++; return { kind: 'allow' }; } } })
    .execute(invocation({ agentId: 'worker-a' }), { agentId: 'worker-b' });
  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.equal(result.error.code, 'invalid_context');
  assert.equal(calls, 0);
});

test('arguments and authorization are immutable snapshots across asynchronous policy', async () => {
  const gate = deferred<PolicyDecision>();
  const entered = deferred<void>();
  const args = { value: 'authorized' };
  const authorization = { principalId: 'trusted' };
  let request: AuthorizationRequest | undefined;
  const { registry } = setup();
  const running = new ToolExecutor(registry, { policy: { authorize: (value) => {
    request = value; entered.resolve(); return gate.promise;
  } } }).execute(invocation({ arguments: args }), { authorization });
  await entered.promise;
  args.value = 'changed';
  authorization.principalId = 'changed';
  assert.ok(Object.isFrozen(request?.invocation.arguments));
  assert.equal(request?.context.authorization?.principalId, 'trusted');
  gate.resolve({ kind: 'allow' });
  const result = await running;
  assert.equal(result.status, 'success');
  if (result.status === 'success') assert.deepEqual(result.data, { value: 'authorized' });
});

test('pre-cancelled invocations never enter policy or handler', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const { registry } = setup(fakeTool({ execute: () => { calls++; return { status: 'success' }; } }));
  const result = await new ToolExecutor(registry, { policy: { authorize: () => { calls++; return { kind: 'allow' }; } } })
    .execute(invocation(), { signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  assert.equal(calls, 0);
});

test('cancellation while policy is pending prevents any later execution', async () => {
  const gate = deferred<PolicyDecision>();
  const entered = deferred<void>();
  const controller = new AbortController();
  let calls = 0;
  const { registry } = setup(fakeTool({ execute: () => { calls++; return { status: 'success' }; } }));
  const running = new ToolExecutor(registry, { policy: { authorize: () => { entered.resolve(); return gate.promise; } } })
    .execute(invocation(), { signal: controller.signal });
  await entered.promise;
  controller.abort();
  assert.equal((await running).status, 'cancelled');
  gate.resolve({ kind: 'allow' });
  await Promise.resolve();
  assert.equal(calls, 0);
});

test('cancellation propagates, returns promptly, isolates sessions and ignores late rejection', async () => {
  const entered = deferred<ToolExecutionContext>();
  const gate = deferred<ToolOutcome>();
  const events: ToolExecutionEvent[] = [];
  const controller = new AbortController();
  const { registry } = setup(fakeTool({ execute: (_, context) => {
    if (context.sessionId === 'session-b') return { status: 'success' };
    entered.resolve(context); return gate.promise;
  } }));
  const executor = new ToolExecutor(registry, { policy: new AllowAllPolicy(), onEvent: (event) => { events.push(event); } });
  const call = invocation({ sessionId: 'session-a' });
  const running = executor.execute(call, { signal: controller.signal });
  const executionContext = await entered.promise;
  controller.abort();
  controller.abort();
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(executionContext.signal.aborted, true);
  assert.equal((await executor.execute(invocation({ sessionId: 'session-b' }))).status, 'success');
  gate.reject(new Error('Late fake failure'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event.invocation.id === call.id && event.type === 'invocation_finished').length, 1);
});

test('handler-reported cancellation is distinct from an exception', async () => {
  const { executor } = setup(fakeTool({ execute: () => ({ status: 'cancelled', reason: 'native_cancel' }) }));
  const result = await executor.execute(invocation());
  assert.equal(result.status, 'cancelled');
  if (result.status === 'cancelled') assert.equal(result.reason, 'native_cancel');
});

test('default timeout and invocation override abort the execution signal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = deferred<ToolExecutionContext>();
  const { executor } = setup(fakeTool({
    definition: { ...fakeTool().definition, defaultTimeoutMs: 100 },
    execute: (_, context) => { entered.resolve(context); return new Promise(() => {}); },
  }));
  const running = executor.execute(invocation({ timeoutMs: 5 }));
  const context = await entered.promise;
  t.mock.timers.tick(5);
  const result = await running;
  assert.equal(result.status, 'cancelled');
  if (result.status === 'cancelled') assert.equal(result.reason, 'timeout');
  assert.equal(context.signal.aborted, true);
  const second = executor.execute(invocation());
  await Promise.resolve();
  t.mock.timers.tick(100);
  assert.equal((await second).status, 'cancelled');
});

test('null timeout disables the default; policy waits are also timed out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = deferred<ToolOutcome>();
  const entered = deferred<ToolExecutionContext>();
  const { registry } = setup(fakeTool({
    definition: { ...fakeTool().definition, defaultTimeoutMs: 5 },
    execute: (_, context) => { entered.resolve(context); return gate.promise; },
  }));
  const running = new ToolExecutor(registry, { policy: new AllowAllPolicy() }).execute(invocation({ timeoutMs: null }));
  const context = await entered.promise;
  t.mock.timers.tick(100);
  assert.equal(context.signal.aborted, false);
  gate.resolve({ status: 'success' });
  assert.equal((await running).status, 'success');
  const pendingPolicy = new ToolExecutor(registry, { policy: { authorize: () => new Promise(() => {}) } }).execute(invocation());
  t.mock.timers.tick(5);
  assert.equal((await pendingPolicy).status, 'cancelled');
});

test('invalid timeouts are rejected rather than silently overflowing timers', () => {
  for (const timeoutMs of [0, -1, Infinity, 0.5, 2_147_483_648]) {
    assert.throws(() => invocation({ timeoutMs }), /Timeout/);
    assert.throws(() => new ToolRegistry().register(fakeTool({ definition: { ...fakeTool().definition, defaultTimeoutMs: timeoutMs } })), /Timeout/);
  }
});

test('lifecycle events carry IDs in order and observers cannot change the result', async () => {
  const events: ToolExecutionEvent[] = [];
  const { registry } = setup();
  const context: ToolContext = { agentId: 'worker-9', sessionId: 'session-9', modelCallId: 'model-9' };
  const executor = new ToolExecutor(registry, { policy: new AllowAllPolicy(), onEvent: (event) => {
    events.push(event);
    if (event.type === 'authorization_decided') throw new Error('Broken observer');
    return Promise.reject(new Error('Broken async observer'));
  } });
  const result = await executor.execute(invocation(), context);
  assert.equal(result.status, 'success');
  assert.deepEqual(events.map((event) => event.type), ['invocation_started', 'authorization_decided', 'execution_started', 'invocation_finished']);
  assert.ok(events.every((event) => event.correlation.agentId === context.agentId
    && event.correlation.sessionId === context.sessionId && event.correlation.modelCallId === context.modelCallId));
  assert.equal(events[3].type === 'invocation_finished' && events[3].result, result);
});

test('denied, failed and cancelled lifecycles each emit one terminal event', async () => {
  for (const mode of ['denied', 'failed', 'cancelled'] as const) {
    const events: ToolExecutionEvent[] = [];
    const { registry } = setup(fakeTool({ execute: () => { throw new Error('Fake failure'); } }));
    const controller = new AbortController();
    if (mode === 'cancelled') controller.abort();
    await new ToolExecutor(registry, {
      policy: { authorize: () => mode === 'denied' ? { kind: 'deny', reason: 'Test' } : { kind: 'allow' } },
      onEvent: (event) => { events.push(event); },
    }).execute(invocation(), { signal: controller.signal });
    assert.equal(events[0].type, 'invocation_started');
    assert.equal(events.at(-1)?.type, 'invocation_finished');
    assert.equal(events.filter((event) => event.type === 'invocation_finished').length, 1);
    assert.equal(events.some((event) => event.type === 'execution_started'), mode === 'failed');
  }
});

test('normalization strips undeclared policy and error fields', async () => {
  const { registry } = setup(fakeTool({ execute: () => ({
    status: 'error', error: { code: 'fake', message: 'Failure', stack: 'private stack', retryable: true },
  }) }));
  const result = await new ToolExecutor(registry, { policy: new AllowAllPolicy() }).execute(invocation());
  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.deepEqual(result.error, { code: 'fake', message: 'Failure', retryable: true });
  const events: ToolExecutionEvent[] = [];
  const denied = await new ToolExecutor(registry, {
    policy: { authorize: () => ({ kind: 'deny', reason: 'Blocked', internalRule: 'private' }) },
    onEvent: (event) => { events.push(event); },
  }).execute(invocation());
  assert.equal(denied.status, 'denied');
  if (denied.status === 'denied') assert.deepEqual(denied.decision, { kind: 'deny', reason: 'Blocked' });
  const authorization = events.find((event) => event.type === 'authorization_decided');
  assert.deepEqual(authorization?.decision, { kind: 'deny', reason: 'Blocked' });
});

test('malformed optional error and policy fields fail closed', async () => {
  const { executor, registry } = setup(fakeTool({ execute: () => ({
    status: 'error', error: { code: 'fake', message: 'Failure', retryable: 'yes' },
  }) as unknown as ToolOutcome }));
  const error = await executor.execute(invocation());
  assert.equal(error.status, 'error');
  if (error.status === 'error') assert.equal(error.error.code, 'invalid_output');
  const policy = await new ToolExecutor(registry, { policy: {
    authorize: () => ({ kind: 'deny', reason: 'Blocked', metadata: 'bad' }) as unknown as PolicyDecision,
  } }).execute(invocation());
  assert.equal(policy.status, 'error');
  if (policy.status === 'error') assert.equal(policy.error.code, 'policy_error');
});

test('invalid transport data never leaks raw references into telemetry', async () => {
  const events: ToolExecutionEvent[] = [];
  const { registry } = setup();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const result = await new ToolExecutor(registry, {
    onEvent: (event) => { events.push(event); },
  }).execute(invocation({ arguments: cyclic, metadata: { secret: 'not-copied-on-preflight-failure' } }));
  assert.equal(result.status, 'error');
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.invocation.arguments, null);
    assert.equal(event.invocation.metadata, undefined);
    assert.doesNotThrow(() => JSON.stringify(event));
  }
});

test('observers cannot mutate normalized runtime errors', async () => {
  const { registry } = setup(fakeTool({ execute: () => { throw new TypeError('Fake failure'); } }));
  const result = await new ToolExecutor(registry, {
    policy: new AllowAllPolicy(),
    onEvent: (event) => {
      if (event.type === 'invocation_finished' && event.result.status === 'error') {
        (event.result.error as { code: string }).code = 'changed_by_observer';
      }
    },
  }).execute(invocation());
  assert.equal(result.status, 'error');
  if (result.status === 'error') {
    assert.equal(result.error.code, 'tool_exception');
    assert.ok(Object.isFrozen(result.error));
    assert.ok(Object.isFrozen(result.error.details));
  }
});

test('output schema must be an object at registration', () => {
  for (const outputSchema of [null, 'string', []]) {
    assert.throws(() => new ToolRegistry().register(fakeTool({
      definition: { ...fakeTool().definition, outputSchema: outputSchema as unknown as JsonObject },
      validateOutput: () => ({ valid: true }),
    })), /outputSchema/);
  }
});

test('parameter-sensitive policy and handler receive the exact same normalized immutable value', async () => {
  const calls: string[] = [];
  const entered = deferred<AuthorizationRequest>();
  const gate = deferred<void>();
  const raw = { value: '  ALLOWED  ' };
  let normalized: { value: string };
  let executed: JsonValue | undefined;
  const { registry } = setup(fakeTool({
    validateInput: (input) => {
      calls.push('validate');
      const validation = fakeTool().validateInput(input);
      if (validation.valid === false) return validation;
      normalized = { value: ((input as JsonObject).value as string).trim().toLowerCase() };
      return { valid: true, data: normalized };
    },
    execute: (input) => { calls.push('execute'); executed = input; return { status: 'success', data: input }; },
  }));
  const pending = new ToolExecutor(registry, { policy: { authorize: async (request) => {
    calls.push('policy');
    entered.resolve(request);
    const allowed = (request.invocation.arguments as JsonObject).value === 'allowed';
    await gate.promise;
    return allowed ? { kind: 'allow' } : { kind: 'deny', reason: 'Value is not allowed' };
  } } }).execute(invocation({ arguments: raw }));
  const request = await entered.promise;
  assert.deepEqual(calls, ['validate', 'policy']);
  assert.deepEqual(request.invocation.arguments, { value: 'allowed' });
  assert.notEqual(request.invocation.arguments, raw);
  assert.notEqual(request.invocation.arguments, normalized!);
  assert.ok(Object.isFrozen(request.invocation.arguments));
  raw.value = 'changed by caller';
  normalized!.value = 'changed by validator';
  assert.throws(() => { (request.invocation.arguments as { value: string }).value = 'changed by policy'; }, TypeError);
  gate.resolve();
  const result = await pending;
  assert.equal(result.status, 'success');
  assert.deepEqual(calls, ['validate', 'policy', 'execute']);
  assert.equal(executed, request.invocation.arguments);
  assert.deepEqual(executed, { value: 'allowed' });
});

test('nested objects and arrays cannot change between authorization and execution', async () => {
  const raw = { order: { merchant: 'X', items: [{ id: 'coffee', quantity: 1 }] } };
  const normalized = { order: { merchant: 'X', items: [{ id: 'coffee', quantity: 1 }] } };
  let approved: typeof raw | undefined;
  let executed: JsonValue | undefined;
  const mutations: boolean[] = [];
  let pushRejected = false;
  const { registry } = setup(fakeTool({
    definition: { ...fakeTool().definition, inputSchema: { type: 'object' } },
    validateInput: () => ({ valid: true, data: normalized }),
    execute: (input) => { executed = input; return { status: 'success', data: input }; },
  }));
  const result = await new ToolExecutor(registry, {
    policy: { authorize: (request) => {
      approved = request.invocation.arguments as typeof raw;
      return approved.order.items[0].quantity === 1
        ? { kind: 'allow' } : { kind: 'deny', reason: 'Unexpected quantity' };
    } },
    onEvent: (event) => {
      if (event.type !== 'authorization_decided') return;
      const input = event.invocation.arguments as typeof raw;
      mutations.push(
        Reflect.set(input.order, 'merchant', 'changed'),
        Reflect.set(input.order.items[0], 'quantity', 20),
        Reflect.set(input.order.items, '0', { id: 'coffee', quantity: 20 }),
        Reflect.set(input.order.items, 'length', 0),
      );
      try {
        input.order.items.push({ id: 'extra', quantity: 20 });
      } catch (error) {
        pushRejected = error instanceof TypeError;
      }
      // Retained caller/validator references must also be detached from the snapshot.
      raw.order.items[0].quantity = 20;
      normalized.order.items[0].quantity = 20;
      normalized.order.items.push({ id: 'extra', quantity: 20 });
    },
  }).execute(invocation({ arguments: raw }));
  assert.equal(result.status, 'success');
  assert.deepEqual(mutations, [false, false, false, false]);
  assert.equal(pushRejected, true);
  assert.ok(approved);
  for (const value of [approved, approved.order, approved.order.items, approved.order.items[0]]) {
    assert.ok(Object.isFrozen(value));
  }
  assert.notEqual(approved.order.items[0], raw.order.items[0]);
  assert.notEqual(approved.order.items[0], normalized.order.items[0]);
  assert.equal(executed, approved);
  assert.deepEqual(executed, { order: { merchant: 'X', items: [{ id: 'coffee', quantity: 1 }] } });
});

test('throwing validators and invalid normalized values never reach policy or handler', async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const validators: ExecutableTool['validateInput'][] = [
    () => { throw new Error('Invalid input'); },
    () => ({ valid: 'yes', data: {} }) as unknown as InputValidationResult,
    ...[undefined, { value: NaN }, cyclic].map((data) => () => ({ valid: true, data }) as InputValidationResult),
  ];
  for (const validateInput of validators) {
    const events: ToolExecutionEvent[] = [];
    let calls = 0;
    const { registry } = setup(fakeTool({ validateInput, execute: () => { calls++; return { status: 'success' }; } }));
    const result = await new ToolExecutor(registry, {
      policy: { authorize: () => { calls++; return { kind: 'allow' }; } },
      onEvent: (event) => { events.push(event); },
    }).execute(invocation());
    assert.equal(result.status, 'error');
    if (result.status === 'error') assert.equal(result.error.code, 'invalid_arguments');
    assert.equal(result.failureStage, 'input');
    assert.equal(calls, 0);
    assert.deepEqual(events.map((event) => event.type), ['invocation_started', 'invocation_finished']);
  }
});

test('hidden tools still require policy authorization after validation', async () => {
  const calls: string[] = [];
  const { registry } = setup(fakeTool({
    validateInput: (input) => { calls.push('validate'); return fakeTool().validateInput(input); },
    execute: () => { calls.push('execute'); return { status: 'success' }; },
  }));
  const context = { agentId: 'hidden-tool-worker' };
  assert.deepEqual(registry.modelDefinitions(context, () => false), []);
  const result = await new ToolExecutor(registry, { policy: { authorize: () => {
    calls.push('policy'); return { kind: 'deny', reason: 'No authority' };
  } } }).execute(invocation(), context);
  assert.equal(result.status, 'denied');
  assert.deepEqual(calls, ['validate', 'policy']);
});

test('cancellation during validation prevents authorization and execution', async () => {
  const controller = new AbortController();
  let calls = 0;
  const { registry } = setup(fakeTool({
    validateInput: (input) => { controller.abort(); return fakeTool().validateInput(input); },
    execute: () => { calls++; return { status: 'success' }; },
  }));
  const result = await new ToolExecutor(registry, { policy: { authorize: () => { calls++; return { kind: 'allow' }; } } })
    .execute(invocation(), { signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  assert.equal(calls, 0);
});
