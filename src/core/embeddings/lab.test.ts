import assert from 'node:assert/strict';
import test from 'node:test';
import { CROSS_DOCUMENTS, CROSS_QUERY, EmbeddingsLabController, labError, sizeBenchmarkInput, summarizeVector, type LabState } from './lab';
import { EmbeddingError, type DeviceDiagnostics, type DownloadableModel, type EmbeddingKind,
  type EmbeddingOptions, type EmbeddingResult, type EmbeddingService, type EmbeddingsEnvironment,
  type InstallerStatus, type RuntimeState } from './types';

const model: DownloadableModel = {
  modelId: 'Official/Model', revision: 'abc123', quantization: 'Q8_0', dimensions: 1024,
  maxTokens: 512, backendRevision: 'backend123', batchMode: 'sequential', repository: 'Official/Model-GGUF',
  filename: 'model.gguf', expectedBytes: 1234, format: 'GGUF', downloadUrl: 'https://example.com/model',
};
const device: DeviceDiagnostics = {
  timestamp: 1, manufacturer: 'Test', model: 'Phone', androidVersion: '15', sdk: 35, abi: 'arm64-v8a',
  supportedAbis: ['arm64-v8a'], totalRamBytes: 8e9, availableRamBytes: 4e9, appPssBytes: 100,
  nativeHeapBytes: 30, javaHeapBytes: 20, batteryLevel: 80, batteryTemperatureC: 30,
  thermalStatus: 0, lowMemory: false, thresholdBytes: 1000,
};

function fake(loaded = false, changed: (state: LabState) => void = () => {}) {
  let state: RuntimeState = loaded ? 'ready' : 'unloaded';
  let warm = false;
  let clock = 0;
  let samples = 0;
  let inferences = 0;
  const calls: string[] = [];
  const batches: number[] = [];
  let singleCalls = 0;
  const hooks: {
    sample?: (n: number) => Partial<DeviceDiagnostics>;
    batch?: (n: number, options?: EmbeddingOptions) => Promise<void>;
    single?: (n: number, options?: EmbeddingOptions) => Promise<void>;
    load?: () => void;
  } = {};
  const tokens = (text: string, kind: EmbeddingKind) => text.split(/\s+/).length * 3 + (kind === 'query' ? 9 : 5);
  const embed = async (text: string, kind: EmbeddingKind, options?: EmbeddingOptions): Promise<EmbeddingResult> => {
    assert.equal(state, 'ready', 'fake deliberately refuses implicit loading');
    if (options?.signal?.aborted) throw new EmbeddingError({ code: 'CANCELLED', message: 'cancelled' });
    calls.push(kind);
    inferences++;
    clock += 4;
    const vector = Array(1024).fill(0);
    vector[text.includes('vegetables') ? 1 : 0] = 1;
    const result = { vector, dimensions: 1024, modelId: model.modelId, revision: model.revision,
      quantization: model.quantization, tokenCount: tokens(text, kind), inferenceDurationMs: 4, warm };
    warm = true;
    return result;
  };
  const service: EmbeddingService = {
    async load() { calls.push('load'); hooks.load?.(); state = 'ready'; warm = false; clock += 50; return { loadDurationMs: 50, modelInfo: model }; },
    async unload() { calls.push('unload'); state = 'unloaded'; warm = false; },
    isLoaded: () => state === 'ready', getState: () => state, getModelInfo: () => model,
    async countTokens(text, kind, options) {
      assert.equal(state, 'ready');
      if (options?.signal?.aborted) throw new EmbeddingError({ code: 'CANCELLED', message: 'cancelled' });
      calls.push('tokens'); clock += 1; return tokens(text, kind);
    },
    embedQuery: (text, options) => embed(text, 'query', options),
    embedDocument: async (text, options) => { await hooks.single?.(++singleCalls, options); return embed(text, 'document', options); },
    async embedDocuments(texts, options) {
      calls.push('batch'); batches.push(texts.length);
      await hooks.batch?.(batches.length, options);
      const results: EmbeddingResult[] = [];
      for (const text of texts) results.push(await embed(text, 'document', options));
      return results;
    },
  };
  const status: InstallerStatus = {
    state: 'installed', busy: false, operation: null, downloadedBytes: 1234, expectedBytes: 1234,
    progressPercent: 100, verifiedBytes: 1234, verificationProgressPercent: 100, elapsedMs: 0,
    recentBytesPerSecond: 0, averageBytesPerSecond: 0, availableStorageBytes: 1e9, installedBytes: 1234, model, metrics: {},
  };
  const environment: EmbeddingsEnvironment = {
    service,
    installer: {
      getStatus: () => status, getModelMetadata: () => model,
      getRequiredStorage: () => ({ availableBytes: 1e9, requiredBytes: 2234, headroomBytes: 1000 }),
      getInstalledModel: () => ({ model, bytes: 1234, storageCategory: 'app-private' }),
      async download() { calls.push('download'); }, cancelDownload() { calls.push('cancelDownload'); },
      async verify() { calls.push('verify'); }, async install() { calls.push('install'); },
      async remove() { await service.unload(); calls.push('remove'); },
    },
    async sampleDevice() {
      calls.push('sample'); clock += 2; samples++;
      return { ...device, appPssBytes: service.isLoaded() ? 150 : 100, ...hooks.sample?.(samples) };
    },
    copyText() {}, async exportJson() {},
  };
  const controller = new EmbeddingsLabController(environment, changed, () => clock);
  return { controller, service, environment, hooks, calls, batches, status, tokens, inferences: () => inferences };
}

test('token sizing searches the actual tokenizer including production prefix tokens, without inference', async () => {
  const f = fake(true);
  for (const size of ['short', '128', '256', 'near512'] as const) {
    const input = await sizeBenchmarkInput(f.service, size, new AbortController().signal);
    assert.equal(input.actualTokens, f.tokens(input.text, 'document'));
    assert.ok(input.actualTokens <= input.targetTokens);
    assert.ok(input.targetTokens - input.actualTokens < 3);
    assert.ok(input.tokenizerCalls <= 30);
    const repeated = await sizeBenchmarkInput(f.service, size, new AbortController().signal);
    assert.equal(input.text, repeated.text);
  }
  assert.equal(f.inferences(), 0);
  assert.ok(!f.calls.includes('load'));
});

test('token sizing fails boundedly for saturated/invalid tokenizers and honours cancellation', async () => {
  const f = fake(true);
  f.service.countTokens = async () => 5;
  await assert.rejects(sizeBenchmarkInput(f.service, '128', new AbortController().signal), { code: 'TOKEN_SIZING' });
  f.service.countTokens = async () => NaN;
  await assert.rejects(sizeBenchmarkInput(f.service, '128', new AbortController().signal), { code: 'TOKEN_SIZING' });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(sizeBenchmarkInput(f.service, 'short', abort.signal), { code: 'CANCELLED' });
});

test('near-limit sizing obeys a smaller model limit and refuses unsupported larger targets', async () => {
  const f = fake(true);
  f.service.getModelInfo = () => ({ ...model, maxTokens: 128 });
  const input = await sizeBenchmarkInput(f.service, 'near512', new AbortController().signal);
  assert.equal(input.targetTokens, 128); assert.ok(input.actualTokens <= 128);
  await assert.rejects(sizeBenchmarkInput(f.service, '256', new AbortController().signal), { code: 'TOKEN_SIZING' });
});

test('warm refuses unloaded, records a failure report, and never loads implicitly', async () => {
  const f = fake();
  await f.controller.benchmark({ mode: 'warm', size: 'short', count: 10 });
  const run = f.controller.state.benchmarks[0];
  assert.equal(run.outcome, 'error'); assert.equal(run.error?.code, 'NOT_LOADED');
  assert.equal(run.completed, 0); assert.equal(run.failures, 1); assert.equal(run.skipped, 9);
  assert.equal(run.latencyMs.mean, null); assert.equal(f.inferences(), 0);
  assert.equal(run.totalTokens, 0); assert.equal(run.tokensPerSecond, 0); assert.equal(run.inferenceTokensPerSecond, null);
  assert.ok(!f.calls.includes('load')); assert.equal(f.controller.state.busy, null);
});

test('cold separately measures unloaded load, first inference and observed PSS delta', async () => {
  const f = fake();
  await f.controller.benchmark({ mode: 'cold', size: '128', count: 1 });
  const run = f.controller.state.benchmarks[0];
  assert.equal(run.outcome, 'success'); assert.equal(run.firstInferenceWarm, false);
  assert.equal(run.coldInferences, 1); assert.equal(run.warmInferences, 0);
  assert.equal(run.load?.loadDurationMs, 50); assert.equal(run.load?.observedPssDeltaBytes, 50);
  assert.equal(run.inferenceOnlyMs, 4); assert.equal(run.completed, 1);
  assert.equal(run.totalTokens, run.actualTokens);
  assert.equal(run.tokensPerSecond, run.totalTokens * 1000 / run.elapsedMs);
  assert.equal(run.inferenceTokensPerSecond, run.totalTokens * 1000 / 4);
  assert.equal(run.diagnosticsMs, run.samples.length * 2);
  assert.equal(run.samplePeakPssBytes, 150);
  assert.ok(run.elapsedMs >= run.inferenceOnlyMs + run.preparationMs + run.diagnosticsMs + 50);
  assert.ok(f.calls.indexOf('load') < f.calls.indexOf('tokens'));
  assert.ok(f.calls.indexOf('tokens') < f.calls.indexOf('document'));
  assert.equal(f.inferences(), 1);
  await f.controller.benchmark({ mode: 'cold', size: 'short', count: 1 });
  assert.equal(f.controller.state.benchmarks.length, 2);
  assert.equal(f.controller.state.benchmarks[1].error?.code, 'COLD_REQUIRES_UNLOADED');
});

test('warm batches 1/10/100 are sequential bounded chunks, never a hidden warm-up', async () => {
  const f = fake(true);
  for (const count of [1, 10, 100] as const) {
    await f.controller.benchmark({ mode: 'warm', size: '256', count });
    const run = f.controller.state.benchmarks.at(-1)!;
    assert.equal(run.outcome, 'success'); assert.equal(run.completed, count);
    assert.equal(run.inferenceOnlyMs, count * 4);
    assert.equal(run.latencyMs.mean, 4); assert.equal(run.latencyMs.median, 4); assert.equal(run.latencyMs.p95, 4);
    assert.equal(run.inferenceDocumentsPerSecond, 250);
    assert.equal(run.totalTokens, count * run.actualTokens!);
    assert.equal(run.tokensPerSecond, run.totalTokens * 1000 / run.elapsedMs);
    assert.equal(run.inferenceTokensPerSecond, run.totalTokens * 1000 / run.inferenceOnlyMs);
    assert.equal(run.batchImplementation, 'sequential');
    assert.equal(run.firstInferenceWarm, count !== 1);
    assert.ok(!JSON.stringify(run).includes('vector'));
  }
  assert.equal(f.inferences(), 111);
  assert.ok(f.batches.every(size => size <= 10));
  assert.ok(!f.calls.includes('load'));
});

test('1000 requires manual confirmation and retains only bounded samples and summaries', async () => {
  const f = fake(true);
  await f.controller.benchmark({ mode: 'warm', size: 'short', count: 1000 });
  assert.equal(f.controller.state.benchmarks[0].error?.code, 'CONFIRM_REQUIRED');
  assert.equal(f.inferences(), 0);
  await f.controller.benchmark({ mode: 'warm', size: 'short', count: 1000, confirmed1000: true });
  const run = f.controller.state.benchmarks.at(-1)!;
  assert.equal(run.completed, 1000); assert.equal(f.batches.length, 0);
  assert.equal(run.totalTokens, 1000 * run.actualTokens!);
  assert.ok(run.samples.length <= 128); assert.equal(run.latencyMs.count, 1000);
  assert.ok(JSON.stringify(run).length < 100000);
  assert.ok(!Object.hasOwn(run, 'vectors')); assert.ok(!Object.hasOwn(run, 'texts'));
});

test('cancel between chunks preserves completed measurements and prevents further native work', async () => {
  const f = fake(true);
  f.hooks.sample = n => { if (n === 2) f.controller.cancel(); return {}; };
  await f.controller.benchmark({ mode: 'warm', size: 'short', count: 100 });
  const run = f.controller.state.benchmarks[0];
  assert.equal(run.outcome, 'cancelled'); assert.equal(run.completed, 10); assert.equal(run.cancelled, 90);
  assert.equal(run.inferenceOnlyMs, 40); assert.equal(f.batches.length, 0);
  assert.equal(run.totalTokens, 10 * run.actualTokens!);
  assert.equal(run.tokensPerSecond, run.totalTokens * 1000 / run.elapsedMs);
  assert.equal(f.controller.state.cancellations, 1); assert.equal(f.controller.state.busy, null);
});

test('cancel an in-flight rejected chunk marks unavailable partial work, then permits retry', async () => {
  const f = fake(true);
  f.hooks.single = async (n, options) => {
    if (n === 11) {
      f.controller.cancel();
      assert.ok(options?.signal?.aborted);
      throw new EmbeddingError({ code: 'CANCELLED', message: '/private/path or secret text' });
    }
  };
  await f.controller.benchmark({ mode: 'warm', size: 'short', count: 100 });
  const run = f.controller.state.benchmarks[0];
  assert.equal(run.completed, 10); assert.equal(run.attempted, 11); assert.equal(run.unreportedItems, 1);
  assert.equal(run.cancelled, 90); assert.equal(run.failures, 0);
  assert.equal(run.totalTokens, run.completed * run.actualTokens!);
  assert.equal(run.inferenceTokensPerSecond, run.totalTokens * 1000 / run.inferenceOnlyMs);
  assert.ok(!JSON.stringify(run.error).includes('/private'));
  f.hooks.single = undefined;
  await f.controller.benchmark({ mode: 'warm', size: 'short', count: 1 });
  assert.equal(f.controller.state.benchmarks.at(-1)?.outcome, 'success');
});

test('failures retain previous chunk timings and load failures retain before/after observations', async () => {
  const f = fake(true);
  f.hooks.single = async n => { if (n === 11) throw new Error('secret'); };
  await f.controller.benchmark({ mode: 'warm', size: 'short', count: 100 });
  const run = f.controller.state.benchmarks[0];
  assert.equal(run.outcome, 'error'); assert.equal(run.completed, 10); assert.equal(run.failures, 1);
  assert.equal(run.skipped, 89); assert.equal(run.inferenceOnlyMs, 40); assert.equal(run.unreportedItems, 1);
  assert.equal(run.totalTokens, run.completed * run.actualTokens!);
  const cold = fake(); cold.hooks.load = () => { throw new Error('native failure'); };
  await cold.controller.benchmark({ mode: 'cold', size: 'short', count: 1 });
  assert.equal(cold.controller.state.benchmarks[0].load?.outcome, 'error');
  assert.ok(cold.controller.state.loads[0].before); assert.ok(cold.controller.state.loads[0].after);
});

test('low-memory and severe-thermal samples stop safely before additional chunks or load', async () => {
  for (const sample of [{ lowMemory: true }, { thermalStatus: 3 }]) {
    const f = fake(true);
    f.hooks.sample = n => n >= 2 ? sample : {};
    await f.controller.benchmark({ mode: 'warm', size: 'short', count: 100 });
    const run = f.controller.state.benchmarks[0];
    assert.equal(run.outcome, 'safety-stop'); assert.equal(run.completed, 10); assert.equal(run.skipped, 90);
    assert.equal(f.batches.length, 0); assert.equal(run.failures, 0);
  }
  const cold = fake(); cold.hooks.sample = () => ({ lowMemory: true });
  await cold.controller.benchmark({ mode: 'cold', size: 'short', count: 1 });
  assert.ok(!cold.calls.includes('load'));
});

test('unavailable diagnostics remain unavailable and errors are retained without fake samples', async () => {
  const f = fake(true);
  f.environment.sampleDevice = async () => { throw new Error('device private path'); };
  await f.controller.benchmark({ mode: 'warm', size: 'short', count: 1 });
  const run = f.controller.state.benchmarks[0];
  assert.equal(run.outcome, 'success'); assert.equal(run.memoryBefore, null); assert.equal(run.samplePeakPssBytes, null);
  assert.equal(run.latestDevice, null);
  assert.equal(run.samples.length, 0); assert.ok(run.diagnosticErrors.length > 0);
});

test('single, similarity, cross-language and repeat diagnostics use production methods and validate vectors', async () => {
  const f = fake(true);
  await f.controller.single('query input', 'query');
  assert.equal(f.controller.state.single?.first12.length, 12); assert.equal(f.controller.state.single?.norm, 1);
  await f.controller.single('document input', 'document', true);
  assert.equal(f.controller.state.warmUp?.kind, 'document');
  await f.controller.similarity(CROSS_QUERY, CROSS_DOCUMENTS, true);
  assert.deepEqual(f.controller.state.crossLanguage.map(row => row.document), [0, 1, 2]);
  await f.controller.correctness();
  assert.equal(f.controller.state.correctness?.stableWithinTolerance, true);
  assert.equal(f.controller.state.correctness?.relatedRanksAboveUnrelated, true);
  const valid = await f.service.embedQuery('test');
  for (const invalid of [{ ...valid, dimensions: 3 }, { ...valid, tokenCount: NaN }, { ...valid, vector: Array(1024).fill(0) },
    { ...valid, vector: Array(1024).fill(Infinity) }, { ...valid, inferenceDurationMs: -1 }]) {
    assert.throws(() => summarizeVector(invalid, 'query'), { code: 'INVALID_VECTOR' });
  }
});

test('controller serializes work, delegates safe removal, and installer polling never samples device', async () => {
  const f = fake(true);
  f.controller.refresh(); f.controller.refresh();
  assert.equal(f.calls.length, 0);
  f.status.busy = true;
  await f.controller.single('test', 'query'); assert.equal(f.inferences(), 0);
  f.status.busy = false;
  let release!: () => void;
  f.hooks.single = () => new Promise<void>(resolve => { release = resolve; });
  const running = f.controller.benchmark({ mode: 'warm', size: 'short', count: 1 });
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  await f.controller.unload(); assert.ok(!f.calls.includes('unload'));
  release(); await running;
  await f.controller.installAction('remove');
  assert.deepEqual(f.calls.slice(-2), ['unload', 'remove']);
});

test('repeat stability alone cannot pass related-ranking diagnostics when all scores tie', async () => {
  const f = fake(true);
  f.service.embedDocuments = async texts => Promise.all(texts.map(() => f.service.embedDocument('constant')));
  await f.controller.correctness();
  assert.equal(f.controller.state.correctness?.stableWithinTolerance, true);
  assert.equal(f.controller.state.correctness?.relatedRanksAboveUnrelated, false);
});

test('running benchmark snapshots publish periodic latest RAM, PSS, temperature and thermal observations', async () => {
  const observations: { completed: number; ram: number | null; pss: number | null; temperature: number | null; thermal: number | null }[] = [];
  const f = fake(true, state => {
    const run = state.benchmarks.at(-1);
    if (run?.outcome === 'running' && run.latestDevice) observations.push({ completed: run.completed,
      ram: run.latestDevice.availableRamBytes, pss: run.latestDevice.appPssBytes,
      temperature: run.latestDevice.batteryTemperatureC, thermal: run.latestDevice.thermalStatus });
  });
  f.hooks.sample = n => ({ availableRamBytes: 4e9 - n, appPssBytes: 100 + n, batteryTemperatureC: 30 + n / 10, thermalStatus: 1 });
  await f.controller.benchmark({ mode: 'warm', size: 'short', count: 100 });
  assert.ok(observations.some(sample => sample.completed === 10 && sample.pss === 102 && sample.ram === 4e9 - 2));
  assert.ok(observations.some(sample => sample.completed === 20 && sample.temperature === 30.3 && sample.thermal === 1));
  const run = f.controller.state.benchmarks[0];
  assert.deepEqual(run.latestDevice, run.memoryAfter);
});

test('a failed latest device sample is unavailable rather than a stale earlier live reading', async () => {
  const f = fake(true);
  f.hooks.sample = n => { if (n > 1) throw new Error('device sampling failed'); return {}; };
  await f.controller.benchmark({ mode: 'warm', size: 'short', count: 10 });
  assert.equal(f.controller.state.benchmarks[0].samples.length, 1);
  assert.equal(f.controller.state.benchmarks[0].latestDevice, null);
});

test('token throughput is unavailable for zero-duration measurements and excludes tokenizer work', async () => {
  const f = fake(true);
  const embed = f.service.embedDocument;
  f.service.embedDocument = async (text, options) => ({ ...await embed(text, options), inferenceDurationMs: 0 });
  const controller = new EmbeddingsLabController(f.environment, () => {}, () => 0);
  await controller.benchmark({ mode: 'warm', size: 'short', count: 10 });
  const run = controller.state.benchmarks[0];
  assert.equal(run.totalTokens, 10 * run.actualTokens!);
  assert.ok(run.tokenizerCalls > 0);
  assert.equal(run.tokensPerSecond, null); assert.equal(run.inferenceTokensPerSecond, null);
});

test('native error codes receive fixed actionable messages without exposing raw input or paths', () => {
  const cases: Record<string, RegExp> = {
    INPUT_TOO_LONG: /Shorten/, EMPTY_INPUT: /nonempty/, MODEL_NOT_LOADED: /Load it/,
    MODEL_NOT_INSTALLED: /Download/, INVALID_PATH: /Verify/, INVALID_MODEL: /Verify/,
    MODEL_LOAD_FAILED: /Free memory/, NATIVE_INIT_FAILED: /device ABI/, HASH_MISMATCH: /checksum/,
    SIZE_MISMATCH: /wrong size/, INSUFFICIENT_STORAGE: /Free storage/, NETWORK_IO: /network connection/,
    HTTP_ERROR: /retry later/, TOKENIZATION_FAILED: /shorter text/, INFERENCE_FAILED: /reload/,
    OUT_OF_MEMORY: /unload/, QUEUE_FULL: /Wait/, UNSUPPORTED_PLATFORM: /ARM64 Android/,
    STORAGE_IO: /free storage/, STORAGE_UNAVAILABLE: /storage to become available/, INSTALL_FAILED: /Verify/,
  };
  for (const [code, action] of Object.entries(cases)) {
    const result = labError({ code, message: 'private-input /data/private/path https://host?signature=secret', actualTokens: 600, maxTokens: 512 });
    assert.equal(result.code, code); assert.match(result.message, action);
    assert.doesNotMatch(result.message, /private-input|\/data|https:|secret/);
    assert.equal(result.actualTokens, 600); assert.equal(result.maxTokens, 512);
  }
  assert.equal(labError({ code: 'SECRET_CREDENTIAL', message: 'secret' }).code, 'OPERATION_FAILED');
});

function measuredFake(changed: (state: LabState) => void = () => {}) {
  const f = fake(true, changed);
  const limits = { nBatch: 1024, nUbatch: 1024, nCtx: 1024, nCtxSeq: 1024,
    maxParallelSequences: 100, backendMaxParallelSequences: 256, backendSequenceExecution: 'serial_ubatches' as const };
  f.service.getModelInfo = () => ({ ...model, batchLimits: limits });
  const original = f.service.embedDocument;
  const ids = new Map<string, number>();
  f.service.embedDocument = async (text, options) => {
    const result = await original(text, options);
    if (!ids.has(text)) ids.set(text, ids.size);
    result.vector.fill(0); result.vector[ids.get(text)!] = 1;
    return result;
  };
  f.service.embedDocumentsMeasured = async (texts, options) => {
    const embeddings = [];
    for (const text of texts) embeddings.push(await f.service.embedDocument(text, options));
    const totalTokens = embeddings.reduce((sum, r) => sum + r.tokenCount, 0);
    const nativeDecodeMs = embeddings.length * 4;
    return { embeddings: embeddings.map(r => ({ ...r, inferenceDurationMs: null })), metrics: {
      mode: options!.batchMode!, requestedBatchSize: options!.batchingPolicy!.maxSequencesPerBatch,
      effectiveBatchSize: texts.length, nativeDecodeCount: 1, totalTokens, totalElapsedMs: nativeDecodeMs,
      nativeDecodeMs, preparationMs: 0, effectiveMsPerDocument: 4, documentsPerSecond: 250,
      tokensPerSecond: totalTokens * 1000 / nativeDecodeMs, limits,
      decodes: [{ sequences: texts.length, tokens: totalTokens, nativeDecodeMs }],
    } };
  };
  return f;
}

test('batch controller APIs publish independent comparisons and target prefixes without changing legacy reports', async () => {
  const snapshots: LabState[] = [];
  const f = measuredFake(state => snapshots.push(state));
  await f.controller.batchComparison('short', 11);
  const full = f.controller.state.batchComparisons[0];
  assert.equal(full.outcome, 'success'); assert.equal(full.correctness.outcome, 'passed');
  assert.deepEqual(full.runs.map(r => r.target), [1, 2, 5, 10, 20, 50, 100]);
  assert.equal(f.controller.state.benchmarks.length, 0); assert.ok(!f.calls.includes('load'));
  assert.ok(snapshots.some(s => s.busy === 'batch-comparison' && s.progress?.completed === 1));
  await f.controller.batchBenchmark('128', 5, 11);
  assert.equal(f.controller.state.batchComparisons.length, 2);
  assert.deepEqual(f.controller.state.batchComparisons[1].runs.map(r => r.target), [1, 2, 5]);
  assert.equal(f.controller.state.batchComparisons[1].requestedTarget, 5);
  assert.equal(f.controller.state.busy, null); assert.equal(f.controller.state.progress, null);
  assert.equal(full.runs[0].completed, 11);
});

test('batch controller cancellation remains busy until native drain and counts one cancellation', async () => {
  const f = measuredFake();
  let release!: () => void;
  let options: EmbeddingOptions | undefined;
  const measured = f.service.embedDocumentsMeasured!;
  f.service.embedDocumentsMeasured = async (texts, active) => {
    if (texts[0].startsWith('science river')) {
      options = active;
      await new Promise<void>(resolve => { release = resolve; });
    }
    return measured(texts, active);
  };
  const running = f.controller.batchBenchmark('short', 2, 11);
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  f.controller.cancel(); assert.ok(options?.signal?.aborted);
  assert.equal(f.controller.state.busy, 'batch-benchmark');
  await f.controller.unload(); assert.ok(!f.calls.includes('unload'));
  release(); await running;
  const report = f.controller.state.batchComparisons[0];
  assert.equal(report.outcome, 'cancelled'); assert.equal(report.runs[0].unreportedItems, 1);
  assert.equal(report.runs[0].completed, 0); assert.equal(report.runs[1].outcome, 'skipped');
  assert.equal(f.controller.state.cancellations, 1); assert.equal(f.controller.state.busy, null);
});

test('batch capability failures surface a sanitized controller error and no implicit load', async () => {
  const f = fake(true);
  await f.controller.batchComparison('short');
  assert.equal(f.controller.state.error?.code, 'BATCH_UNAVAILABLE');
  assert.equal(f.controller.state.batchComparisons[0].requested, 100);
  assert.equal(f.controller.state.batchComparisons[0].outcome, 'error');
  assert.equal(f.inferences(), 0); assert.ok(!f.calls.includes('load'));
});

test('batch summaries accept null timing but the legacy benchmark requires a real single-decode timing', async () => {
  const f = fake(true);
  const result = await f.service.embedDocument('test');
  const summary = summarizeVector({ ...result, inferenceDurationMs: null }, 'document');
  assert.equal(summary.inferenceDurationMs, null); assert.equal(summary.tokensPerMs, null);
  const original = f.service.embedDocument;
  f.service.embedDocument = async (text, options) => {
    assert.equal(options?.batchMode, 'sequential');
    return { ...await original(text, options), inferenceDurationMs: null };
  };
  await f.controller.benchmark({ mode: 'warm', size: 'short', count: 10 });
  const report = f.controller.state.benchmarks[0];
  assert.equal(report.error?.code, 'INVALID_VECTOR'); assert.equal(report.completed, 0);
  assert.equal(report.unreportedItems, 1); assert.equal(report.latencyMs.count, 0);
  assert.equal(f.batches.length, 0);
});
