import assert from 'node:assert/strict';
import test from 'node:test';
import { BATCH_TARGETS, checkBatchSafety, clampBatchPolicy, runBatchComparison, type BatchComparison } from './batching';
import { EmbeddingError, type DeviceDiagnostics, type EmbeddingBatchResult, type EmbeddingOptions,
  type EmbeddingResult, type EmbeddingService, type NativeBatchLimits } from './types';

const limits: NativeBatchLimits = { nBatch: 1024, nUbatch: 1024, nCtx: 1024, nCtxSeq: 1024,
  maxParallelSequences: 100, backendMaxParallelSequences: 256, backendSequenceExecution: 'serial_ubatches' };
const device: DeviceDiagnostics = {
  timestamp: 1, manufacturer: 'Test', model: 'Phone', androidVersion: '15', sdk: 35, abi: 'arm64-v8a',
  supportedAbis: ['arm64-v8a'], totalRamBytes: 8e9, availableRamBytes: 4e9, appPssBytes: 100,
  nativeHeapBytes: 30, javaHeapBytes: 20, batteryLevel: 80, batteryTemperatureC: 30,
  thermalStatus: 0, lowMemory: false, thresholdBytes: 1000,
};

function fake() {
  let clock = 0;
  let sampleCount = 0;
  let tokenizerCalls = 0;
  let maximumDecodeSequences = 100;
  const abort = new AbortController();
  const calls: { texts: string[]; options: EmbeddingOptions; workload: boolean }[] = [];
  const singles: string[] = [];
  const ids = new Map<string, number>();
  const hooks: {
    measured?: (call: typeof calls[number], index: number) => Promise<void>;
    result?: (result: EmbeddingBatchResult, workload: boolean) => void;
    sample?: (index: number) => Partial<DeviceDiagnostics> | null | Promise<Partial<DeviceDiagnostics> | null>;
  } = {};
  const tokens = (text: string) => text.split(/\s+/).length + 5;
  const embedding = (text: string, timing: number | null): EmbeddingResult => {
    if (!ids.has(text)) ids.set(text, ids.size);
    const vector = Array<number>(1024).fill(0); vector[ids.get(text)!] = 1;
    return { vector, dimensions: 1024, modelId: 'model', revision: 'rev', quantization: 'Q8',
      tokenCount: tokens(text), inferenceDurationMs: timing, warm: true };
  };
  const service: EmbeddingService = {
    async load() { throw new Error('Must never load implicitly'); }, async unload() {},
    isLoaded: () => true, getState: () => 'ready',
    getModelInfo: () => ({ modelId: 'model', revision: 'rev', quantization: 'Q8', dimensions: 1024, maxTokens: 512, batchLimits: limits }),
    async countTokens(text) { tokenizerCalls++; clock += 100; return tokens(text); },
    async embedDocument(text, options) {
      assert.equal(options?.batchMode, 'sequential');
      singles.push(text); clock += 20; return embedding(text, 20);
    },
    async embedQuery() { throw new Error('Not used'); },
    async embedDocuments() { throw new Error('Must use measured API'); },
    async embedDocumentsMeasured(texts, options) {
      const call = { texts: [...texts], options: options!, workload: texts[0].startsWith('science river') };
      calls.push(call); await hooks.measured?.(call, calls.length);
      if (options?.signal?.aborted) throw new EmbeddingError({ code: 'CANCELLED', message: 'secret' });
      const policy = options!.batchingPolicy!;
      const decodes: EmbeddingBatchResult['metrics']['decodes'] = [];
      for (const text of texts) {
        const tokenCount = tokens(text);
        let d = decodes.at(-1);
        if (!d || options?.batchMode === 'sequential' || d.sequences >= Math.min(policy.maxSequencesPerBatch, maximumDecodeSequences) ||
            d.tokens + tokenCount > policy.maxTokensPerBatch) {
          d = { sequences: 0, tokens: 0, nativeDecodeMs: 1 }; decodes.push(d);
        }
        d.sequences++; d.tokens += tokenCount; d.nativeDecodeMs += 2;
      }
      const totalTokens = texts.reduce((sum, text) => sum + tokens(text), 0);
      const nativeDecodeMs = decodes.reduce((sum, d) => sum + d.nativeDecodeMs, 0);
      const preparationMs = texts.length / 2;
      const totalElapsedMs = nativeDecodeMs + preparationMs;
      clock += totalElapsedMs + 3;
      const result: EmbeddingBatchResult = { embeddings: texts.map(text => embedding(text, texts.length > 1 ? null : nativeDecodeMs)),
        metrics: { mode: options!.batchMode!, requestedBatchSize: policy.maxSequencesPerBatch,
          effectiveBatchSize: Math.max(...decodes.map(d => d.sequences)), nativeDecodeCount: decodes.length,
          totalTokens, totalElapsedMs, nativeDecodeMs, preparationMs, effectiveMsPerDocument: totalElapsedMs / texts.length,
          documentsPerSecond: 1000 * texts.length / totalElapsedMs, tokensPerSecond: 1000 * totalTokens / totalElapsedMs,
          limits: service.getModelInfo().batchLimits!, decodes } };
      hooks.result?.(result, call.workload);
      return result;
    },
  };
  const sampleDevice = async () => {
    clock += 2;
    const index = ++sampleCount;
    const patch = await hooks.sample?.(index);
    if (patch === null) return null;
    return { ...device, timestamp: index, ...patch };
  };
  return { service, sampleDevice, abort, calls, singles, hooks, now: () => clock, tokens,
    advanceMs: (ms: number) => { clock += ms; },
    tokenizerCalls: () => tokenizerCalls, samples: () => sampleCount,
    setMaximumDecodeSequences: (n: number) => { maximumDecodeSequences = n; } };
}

async function run(f: ReturnType<typeof fake>, options: Partial<Parameters<typeof runBatchComparison>[0]> = {}) {
  return runBatchComparison({ service: f.service, sampleDevice: f.sampleDevice, signal: f.abort.signal,
    size: 'short', count: 100, now: f.now, ...options });
}

test('safe matrix and policy clamp are explicit and use every loaded limit, never guessed defaults', () => {
  assert.deepEqual(BATCH_TARGETS, { short: [1, 2, 5, 10, 20, 50, 100], '128': [1, 2, 5, 10, 20, 50],
    '256': [1, 2, 5, 10, 20], near512: [1, 2, 5, 10] });
  assert.deepEqual(clampBatchPolicy(limits, 100), { maxSequencesPerBatch: 100, maxTokensPerBatch: 1024 });
  assert.equal(clampBatchPolicy(limits, 1, 1).maxTokensPerBatch, 1);
  for (const maxTokens of [0, -1, 4097, NaN, 1.5]) assert.throws(() => clampBatchPolicy(limits, 5, maxTokens));
  for (const key of ['nBatch', 'nUbatch', 'nCtx'] as const) {
    assert.equal(clampBatchPolicy({ ...limits, [key]: 256 }, 100).maxTokensPerBatch, 256);
  }
  assert.equal(clampBatchPolicy({ ...limits, maxParallelSequences: 5 }, 100).maxSequencesPerBatch, 5);
  assert.equal(clampBatchPolicy({ ...limits, backendMaxParallelSequences: 2 }, 100).maxSequencesPerBatch, 2);
  assert.throws(() => clampBatchPolicy({ ...limits, nCtxSeq: 0 }, 1), { code: 'BATCH_LIMITS_UNAVAILABLE' });
});

test('one corpus and one tokenizer sizing operation are reused by baseline and all mandatory tiers', async () => {
  const f = fake();
  const snapshots: BatchComparison[] = [];
  const report = await run(f, { publish: r => snapshots.push(r) });
  assert.equal(report.outcome, 'success'); assert.equal(report.correctness.outcome, 'passed');
  assert.equal(report.correctness.completed, 4); assert.equal(report.correctness.minimumCosine, 1);
  assert.equal(f.singles.length, 4); assert.equal(report.tokenizerCalls, f.tokenizerCalls());
  assert.equal(report.sizingMs, report.tokenizerCalls * 100);
  assert.deepEqual(report.runs.map(r => r.target), BATCH_TARGETS.short);
  let baseline: string[] | undefined;
  for (const r of report.runs) {
    assert.equal(r.outcome, 'success'); assert.equal(r.completed, 100); assert.equal(r.requested, 100);
    const calls = f.calls.filter(c => c.workload && c.options.batchingPolicy!.maxSequencesPerBatch === r.target);
    const corpus = calls.flatMap(c => c.texts);
    if (!baseline) baseline = corpus; else assert.deepEqual(corpus, baseline);
    assert.ok(calls.every(c => c.texts.length <= r.chunkSize));
    assert.ok(calls.every(c => c.options.batchMode === (r.target === 1 ? 'sequential' : 'true_batch')));
    assert.equal(r.totalTokens, report.actualTokens! * 100);
    assert.equal(r.nativeDecodeCount, r.decodes.length);
    assert.equal(r.nativeDecodeMs, r.decodes.reduce((sum, d) => sum + d.nativeDecodeMs, 0));
    assert.equal(r.meanTokensPerDecode, r.totalTokens / r.nativeDecodeCount);
    assert.equal(r.meanSequencesPerDecode, 100 / r.nativeDecodeCount);
    assert.equal(r.preparationMs, 50); assert.equal(r.nativeElapsedMs, r.nativeDecodeMs + 50);
    assert.equal(r.apiWallMs, r.nativeElapsedMs + calls.length * 3);
    assert.ok(r.elapsedMs < report.sizingMs);
    assert.equal(r.documentsPerSecond, 100_000 / r.elapsedMs);
    assert.equal(r.tokensPerSecond, r.totalTokens * 1000 / r.elapsedMs);
    assert.equal(r.effectiveMsPerDocument, r.elapsedMs / 100);
    assert.equal(r.backendSequenceExecution, 'serial_ubatches');
    assert.ok(r.energy.reason); assert.equal(r.energy.energyConsumedMwh, null);
  }
  assert.equal(report.runs.at(-1)!.capacitySequences, Math.floor(1024 / report.actualTokens!));
  assert.equal(report.runs.at(-1)!.effectiveBatchSize, Math.floor(1024 / report.actualTokens!));
  assert.equal(snapshots[0].runs.length, 0, 'published snapshots stay immutable');
  assert.ok(snapshots.every(s => s.runs.filter(r => r.outcome === 'running').length <= 1));
  assert.ok(snapshots.filter(s => s.correctness.outcome === 'running').every(s => s.runs.every(r => r.outcome !== 'running')));
  assert.ok(snapshots.some(s => s.runs.some(r => r.outcome === 'running' && r.completed > 0 && r.completed < 100)));
  assert.doesNotMatch(JSON.stringify(report), /science river|Reset your|"vector"|"texts"/);
});

test('mandatory token-limited tiers run capped; optional token-infeasible tiers skip with capacity reasons', async () => {
  for (const [size, optional] of [['128', 50], ['256', 20], ['near512', 10]] as const) {
    const f = fake();
    const report = await run(f, { size });
    assert.equal(report.outcome, 'success');
    const last = report.runs.at(-1)!;
    assert.equal(last.target, optional); assert.equal(last.outcome, 'skipped'); assert.equal(last.completed, 0);
    assert.match(last.reason!, /Native token capacity: target/); assert.match(last.reason!, /loaded token budget 1024/);
    assert.equal(last.skipped, 100);
    for (const r of report.runs.slice(0, -1)) {
      assert.equal(r.completed, 100); assert.ok(r.effectiveBatchSize <= Math.floor(1024 / report.actualTokens!));
    }
    assert.ok(!f.calls.some(c => c.workload && c.options.batchingPolicy!.maxSequencesPerBatch === optional));
  }
});

test('request ceiling still clamps larger loaded limits; feasible optional tiers run and targets escalate in order', async () => {
  const f = fake();
  const model = f.service.getModelInfo();
  f.service.getModelInfo = () => ({ ...model, batchLimits: { ...limits, nBatch: 8192, nUbatch: 8192, nCtx: 8192 } });
  const report = await run(f, { size: '128', target: 50 });
  // The 4096 request ceiling still prevents 50 x 128, even on a larger context.
  assert.equal(report.runs.at(-1)!.outcome, 'skipped');
  f.service.getModelInfo = () => ({ ...model, maxTokens: 128,
    batchLimits: { ...limits, nBatch: 2048, nUbatch: 2048, nCtx: 2048 } });
  const feasible = await run(f, { size: 'near512' });
  assert.equal(feasible.runs.at(-1)!.outcome, 'success'); assert.equal(feasible.runs.at(-1)!.effectiveBatchSize, 10);
  const short = await run(fake(), { target: 5, count: 11 });
  assert.deepEqual(short.runs.map(r => r.target), [1, 2, 5]);
  assert.equal(short.requestedTarget, 5);
});

test('native may use smaller real decodes and a partial final chunk is counted exactly', async () => {
  const f = fake(); f.setMaximumDecodeSequences(2);
  const report = await run(f, { target: 5, count: 11 });
  const r = report.runs.at(-1)!;
  assert.equal(r.completed, 11); assert.equal(r.attempted, 11); assert.equal(r.requestedBatchSize, 5);
  assert.equal(r.effectiveBatchSize, 2); assert.equal(r.nativeDecodeCount, 7);
  assert.deepEqual(f.calls.filter(c => c.workload && c.options.batchingPolicy!.maxSequencesPerBatch === 5).map(c => c.texts.length), [5, 5, 1]);
  assert.deepEqual(r.decodes.map(d => d.sequences), [2, 2, 1, 2, 2, 1, 1]);
  assert.equal(r.totalTokens, 11 * report.actualTokens!);
});

test('current private-KV Android limits cap short targets at eight and max inputs at two', async () => {
  for (const [size, capacity] of [['short', 8], ['128', 8], ['256', 4], ['near512', 2]] as const) {
    const f = fake();
    const model = f.service.getModelInfo();
    f.service.getModelInfo = () => ({ ...model, batchLimits: { ...limits, nCtx: 4096, nCtxSeq: 512, maxParallelSequences: 8 } });
    const report = await run(f, { size, count: 19 });
    assert.equal(report.outcome, 'success');
    const highest = report.runs.filter(row => row.outcome === 'success').at(-1)!;
    assert.equal(highest.effectiveBatchSize, capacity);
    assert.equal(highest.completed, 19);
    assert.equal(highest.nativeDecodeCount, Math.ceil(19 / capacity));
    assert.equal(highest.decodes.at(-1)!.sequences, 19 % capacity || capacity);
    assert.ok(report.runs.every(row => row.effectiveBatchSize <= 8));
  }
});

test('count/order/dimensions/finite/cosine gate failure stops all warm tiers and never retains vectors', async () => {
  const mutations: ((r: EmbeddingBatchResult) => void)[] = [
    r => { r.embeddings.pop(); }, r => { r.embeddings.reverse(); },
    r => { r.embeddings[0].dimensions = 10; }, r => { r.embeddings[0].vector[0] = NaN; },
    r => { r.embeddings[0].vector[0] = 0.99; r.embeddings[0].vector[100] = 0.1; },
  ];
  for (const mutate of mutations) {
    const f = fake(); f.hooks.result = (result, workload) => { if (!workload) mutate(result); };
    const report = await run(f);
    assert.equal(report.outcome, 'error'); assert.equal(report.correctness.outcome, 'failed');
    assert.ok(report.runs.every(r => r.outcome === 'skipped' && r.completed === 0 && r.elapsedMs === 0));
    assert.equal(f.calls.filter(c => c.workload).length, 0);
    assert.doesNotMatch(JSON.stringify(report), /"vector"|Reset your/);
  }
});

test('missing measured support or loaded limits and invalid requests fail without inference or loading', async () => {
  for (const setup of [
    (f: ReturnType<typeof fake>) => { f.service.isLoaded = () => false; },
    (f: ReturnType<typeof fake>) => { f.service.embedDocumentsMeasured = undefined; },
    (f: ReturnType<typeof fake>) => { const model = f.service.getModelInfo(); f.service.getModelInfo = () => ({ ...model, batchLimits: undefined }); },
  ]) {
    const f = fake(); setup(f);
    const report = await run(f);
    assert.equal(report.outcome, 'error'); assert.equal(f.calls.length, 0); assert.equal(f.tokenizerCalls(), 0);
  }
  for (const count of [0, -1, 1001, 1.5, NaN]) assert.equal((await run(fake(), { count })).error?.code, 'INVALID_BENCHMARK');
  assert.equal((await run(fake(), { target: 3 })).error?.code, 'INVALID_BENCHMARK');
});

test('per-sequence context and token budgets can prohibit the corpus without pretending a skipped matrix succeeded', async () => {
  for (const patch of [{ nCtxSeq: 64 }, { nBatch: 64 }]) {
    const f = fake(); const model = f.service.getModelInfo();
    f.service.getModelInfo = () => ({ ...model, batchLimits: { ...limits, ...patch } });
    const report = await run(f, { size: '128' });
    assert.equal(report.outcome, 'error'); assert.equal(report.error?.code, 'BATCH_CAPACITY');
    assert.equal(f.calls.length, 0); assert.ok(report.runs.every(r => r.outcome === 'skipped'));
  }
});

test('safety thresholds are inclusive, RAM includes headroom, and unknown readings fail closed', () => {
  checkBatchSafety(device);
  for (const patch of [{ thermalStatus: 3 }, { batteryTemperatureC: 42 }, { lowMemory: true },
    { availableRamBytes: 512 * 1024 * 1024 - 1 }, { thresholdBytes: 1024 ** 3, availableRamBytes: 1200 * 1024 * 1024 }]) {
    assert.throws(() => checkBatchSafety({ ...device, ...patch }));
  }
  checkBatchSafety({ ...device, availableRamBytes: 512 * 1024 * 1024 });
  for (const key of ['lowMemory', 'thermalStatus', 'batteryTemperatureC', 'availableRamBytes', 'thresholdBytes'] as const) {
    assert.throws(() => checkBatchSafety({ ...device, [key]: null }), { code: 'SAFETY_UNAVAILABLE' });
  }
  assert.throws(() => checkBatchSafety(null), { code: 'SAFETY_UNAVAILABLE' });
});

test('thermal progression during repeated workload stops higher tiers, preserving online observations', async () => {
  const f = fake();
  f.hooks.sample = () => {
    const completedCalls = f.calls.filter(c => c.workload).length;
    return { thermalStatus: completedCalls >= 12 ? 3 : completedCalls >= 6 ? 2 : 0,
      batteryTemperatureC: 30 + completedCalls / 10, appPssBytes: 100 + completedCalls,
      availableRamBytes: 4e9 - completedCalls, javaHeapBytes: 20 + completedCalls, nativeHeapBytes: 30 + completedCalls };
  };
  const report = await run(f);
  assert.equal(report.outcome, 'safety-stop');
  const r = report.runs[0];
  assert.equal(r.completed, 12); assert.equal(r.skipped, 88); assert.equal(r.failures, 0);
  assert.deepEqual(r.thermal, { initial: 0, peak: 3, final: 3 });
  assert.deepEqual(r.temperatureC, { initial: 30, peak: 31.2, final: 31.2 });
  assert.equal(r.peaks.appPssBytes, 112); assert.equal(r.peaks.minimumAvailableRamBytes, 4e9 - 12);
  assert.equal(r.peaks.javaHeapBytes, 32); assert.equal(r.peaks.nativeHeapBytes, 42);
  assert.ok(report.runs.slice(1).every(r => r.outcome === 'skipped'));
});

test('unknown diagnostics at escalation cannot reuse stale safe readings', async () => {
  const f = fake();
  f.hooks.sample = () => f.calls.filter(c => c.workload).length >= 2 ? null : {};
  const report = await run(f, { count: 2 });
  assert.equal(report.outcome, 'safety-stop'); assert.equal(report.error?.code, 'SAFETY_UNAVAILABLE');
  assert.equal(report.runs[0].completed, 2); assert.equal(report.runs[0].latestDevice, null);
  assert.ok(report.runs[0].diagnosticErrors.length > 0);
  assert.ok(!f.calls.some(c => c.workload && c.options.batchMode === 'true_batch'));
});

test('rejected and invalid atomic chunks have honest unreported counts and no invented token/decode totals', async () => {
  for (const invalid of [false, true]) {
    const f = fake(); let targetCalls = 0;
    f.hooks.measured = async c => {
      if (c.workload && c.options.batchingPolicy!.maxSequencesPerBatch === 5 && ++targetCalls === 2 && !invalid) {
        throw new Error('secret input /private/path');
      }
    };
    f.hooks.result = (result, workload) => {
      if (invalid && workload && result.metrics.requestedBatchSize === 5 && targetCalls === 2) result.metrics.totalTokens++;
    };
    const report = await run(f, { count: 11 }); const r = report.runs.find(r => r.target === 5)!;
    assert.equal(report.outcome, 'error'); assert.equal(r.completed, 5); assert.equal(r.attempted, 10);
    assert.equal(r.unreportedItems, 5); assert.equal(r.failures, 5); assert.equal(r.skipped, 1);
    assert.equal(r.totalTokens, 5 * r.actualTokens); assert.equal(r.nativeDecodeCount, 1);
    assert.ok(report.runs.filter(r => r.target > 5).every(r => r.outcome === 'skipped'));
    assert.doesNotMatch(JSON.stringify(report), /secret input|\/private\/path/);
  }
});

test('cancellation rejects an active atomic chunk, drains it, and prevents escalation', async () => {
  const f = fake(); let targetCalls = 0; let drained = false;
  f.hooks.measured = async c => {
    if (c.workload && c.options.batchingPolicy!.maxSequencesPerBatch === 5 && ++targetCalls === 2) {
      f.abort.abort(); assert.ok(c.options.signal?.aborted);
      await new Promise(resolve => setTimeout(resolve, 5)); drained = true;
    }
  };
  const report = await run(f, { count: 11 });
  assert.ok(drained); assert.equal(report.outcome, 'cancelled');
  const r = report.runs.find(r => r.target === 5)!;
  assert.equal(r.completed, 5); assert.equal(r.unreportedItems, 5); assert.equal(r.cancelled, 6); assert.equal(r.failures, 0);
  assert.equal(r.totalTokens, 5 * r.actualTokens);
});

test('periodic nonoverlapping diagnostics abort a long native call and wait for drain', async () => {
  const f = fake(); let active = false; let sampling = 0; let peakSampling = 0; let drained = false;
  f.hooks.sample = async () => {
    peakSampling = Math.max(peakSampling, ++sampling);
    await new Promise(resolve => setTimeout(resolve, 1)); sampling--;
    return active ? { batteryTemperatureC: 42 } : {};
  };
  f.hooks.measured = async c => {
    if (!c.workload) return;
    active = true;
    await new Promise<void>(resolve => c.options.signal!.addEventListener('abort', () => {
      setTimeout(() => { drained = true; active = false; resolve(); }, 10);
    }, { once: true }));
  };
  const report = await run(f);
  assert.equal(report.outcome, 'safety-stop'); assert.equal(report.error?.code, 'THERMAL_LIMIT');
  assert.ok(drained); assert.equal(peakSampling, 1); assert.equal(report.runs[0].completed, 0);
  assert.equal(report.runs[0].unreportedItems, 1); assert.equal(report.runs[0].temperatureC.peak, 42);
});

test('raw samples stay bounded and uniformly spaced with endpoints; discarded peaks are retained online', async () => {
  const f = fake();
  f.hooks.sample = index => ({ appPssBytes: index === 22 ? 9999 : index,
    nativeHeapBytes: index === 22 ? 8888 : 30, javaHeapBytes: index === 22 ? 7777 : 20 });
  const report = await run(f, { target: 1, count: 300 });
  const r = report.runs[0];
  assert.equal(r.completed, 300); assert.ok(r.sampleCount > 300); assert.ok(r.samples.length <= 128);
  assert.equal(r.samples[0], r.memoryBefore); assert.equal(r.samples.at(-1), r.memoryAfter);
  const intervals = r.samples.slice(1, -1).map((s, i) => s.timestamp - r.samples[i].timestamp);
  assert.equal(new Set(intervals).size, 1);
  assert.equal(r.peaks.appPssBytes, 9999); assert.equal(r.peaks.nativeHeapBytes, 8888); assert.equal(r.peaks.javaHeapBytes, 7777);
});

test('throughput phases use contiguous comparable workload blocks and actual wall time, not modulo windows', async () => {
  const report = await run(fake(), { target: 5, count: 31 });
  for (const r of report.runs) {
    assert.deepEqual(r.throughputBlocks.map(b => b.phase), ['initial', 'middle', 'final']);
    assert.equal(r.throughputBlocks[0].startMs, 0);
    assert.equal(r.throughputBlocks.at(-1)!.endMs, r.elapsedMs);
    assert.equal(r.throughputBlocks.reduce((sum, b) => sum + b.completed, 0), r.completed);
    assert.equal(r.throughputBlocks.reduce((sum, b) => sum + b.totalTokens, 0), r.totalTokens);
    for (const [index, b] of r.throughputBlocks.entries()) {
      if (index) assert.equal(b.startMs, r.throughputBlocks[index - 1].endMs);
      assert.equal(b.elapsedMs, b.endMs - b.startMs);
      assert.equal(b.documentsPerSecond, b.completed * 1000 / b.elapsedMs);
    }
  }
  const tiny = await run(fake(), { target: 1, count: 1 });
  assert.equal(tiny.runs[0].throughputBlocks.length, 0); assert.match(tiny.runs[0].throughputReason!, /Fewer than three/);
});

test('warm energy uses only tier endpoints, supports partial counters, and cannot hide a compacted charging sample', async () => {
  for (const variant of ['valid', 'charge-unavailable', 'charging', 'counter-reset'] as const) {
    const f = fake();
    f.hooks.sample = index => ({ batteryEnergy: {
      chargeCounterUah: variant === 'charge-unavailable' ? null : 1_000_000 - index * 10,
      energyCounterNwh: 4_000_000_000 - index * 40_000 + (variant === 'counter-reset' && index === 22 ? 200_000 : 0),
      currentNowUa: -1000, currentAverageUa: -1000,
      plugged: variant === 'charging' && index === 22, status: 3, elapsedRealtimeMs: index * 1000,
    } });
    const report = await run(f, { target: 1, count: 300 });
    const r = report.runs[0];
    assert.equal(report.outcome, 'success');
    assert.ok(!r.samples.some(s => s.timestamp === 22), 'the suspicious sample is actually compacted out');
    if (variant === 'charging') {
      assert.equal(r.energy.energyConsumedMwh, null); assert.equal(r.energy.chargeConsumedMah, null);
      assert.match(r.energy.reason!, /unreliable discharging/);
    } else if (variant === 'counter-reset') {
      assert.equal(r.energy.energyConsumedMwh, null); assert.ok(r.energy.chargeConsumedMah! > 0);
      assert.match(r.energy.energyReason!, /uncompacted/);
    } else {
      const delta = r.memoryAfter!.timestamp - r.memoryBefore!.timestamp;
      assert.equal(r.energy.energyConsumedMwh, delta * 40_000 / 1_000_000);
      assert.equal(r.energy.mwhPer100Documents, r.energy.energyConsumedMwh! / 3);
      assert.equal(r.energy.mwhPer1000Tokens, r.energy.energyConsumedMwh! * 1000 / r.totalTokens);
      if (variant === 'valid') assert.equal(r.energy.chargeConsumedMah, delta * 10 / 1000);
      else assert.equal(r.energy.chargeConsumedMah, null);
    }
  }
});

test('unreported native work invalidates efficiency denominators without inventing completed tokens', async () => {
  const f = fake(); let calls = 0;
  f.hooks.sample = index => ({ batteryEnergy: {
    chargeCounterUah: 1_000_000 - index * 10, energyCounterNwh: 4_000_000_000 - index * 40_000,
    currentNowUa: -1000, currentAverageUa: -1000, plugged: false, status: 3, elapsedRealtimeMs: index * 1000,
  } });
  f.hooks.measured = async c => { if (c.workload && ++calls === 90) throw new Error('native failed'); };
  const report = await run(f, { target: 1 });
  const r = report.runs[0];
  assert.equal(r.completed, 89); assert.equal(r.unreportedItems, 1); assert.equal(r.totalTokens, 89 * r.actualTokens);
  assert.ok(r.energy.chargeConsumedMah! > 0); assert.ok(r.energy.energyConsumedMwh! > 0);
  assert.equal(r.energy.mahPer100Documents, null); assert.equal(r.energy.mwhPer100Documents, null);
  assert.equal(r.energy.mwhPer1000Tokens, null); assert.match(r.energy.reason!, /unreported native work/);
  assert.match(r.throughputReason!, /failed atomic request tail/);
});

test('a successful response racing cancellation is counted; final diagnostics still block escalation', async () => {
  const f = fake();
  f.hooks.result = (_result, workload) => { if (workload) f.abort.abort(); };
  const cancelled = await run(f, { count: 11 });
  assert.equal(cancelled.outcome, 'cancelled'); assert.equal(cancelled.runs[0].completed, 1);
  assert.equal(cancelled.runs[0].unreportedItems, 0); assert.equal(cancelled.runs[0].cancelled, 10);
  const final = fake();
  final.hooks.sample = index => index === 11 ? { availableRamBytes: 10 } : {};
  const stopped = await run(final, { count: 1 });
  assert.equal(stopped.outcome, 'safety-stop'); assert.equal(stopped.runs[0].completed, 1);
  assert.equal(stopped.runs[0].error?.code, 'LOW_MEMORY'); assert.equal(stopped.runs[1].outcome, 'skipped');
});

test('degrading native wall durations appear in contiguous sustain blocks alongside thermal progression', async () => {
  const f = fake(); let completed = 0;
  f.hooks.measured = async c => { if (c.workload) completed++; };
  f.hooks.sample = () => ({ thermalStatus: completed > 20 ? 2 : completed > 10 ? 1 : 0,
    batteryTemperatureC: 30 + completed / 10 });
  const measured = f.service.embedDocumentsMeasured!;
  f.service.embedDocumentsMeasured = async (texts, options) => {
    const result = await measured(texts, options);
    // Fake bridge overhead with real clock advancement, not a fabricated item latency.
    if (texts[0].startsWith('science river')) f.advanceMs(Math.floor(completed / 10) * 100);
    return result;
  };
  const report = await run(f, { target: 1, count: 30 }); const r = report.runs[0];
  assert.equal(r.thermal.initial, 0); assert.equal(r.thermal.peak, 2); assert.equal(r.thermal.final, 2);
  assert.ok(r.throughputBlocks[0].documentsPerSecond! > r.throughputBlocks[1].documentsPerSecond!);
  assert.ok(r.throughputBlocks[1].documentsPerSecond! > r.throughputBlocks[2].documentsPerSecond!);
});

test('inconsistent decode telemetry fails atomically rather than publishing fabricated throughput', async () => {
  for (const mutate of [
    (r: EmbeddingBatchResult) => { r.metrics.nativeDecodeCount++; },
    (r: EmbeddingBatchResult) => { r.metrics.decodes[0].sequences++; },
    (r: EmbeddingBatchResult) => { r.metrics.effectiveBatchSize++; },
    (r: EmbeddingBatchResult) => { r.metrics.nativeDecodeMs = NaN; },
    (r: EmbeddingBatchResult) => { r.metrics.preparationMs = r.metrics.totalElapsedMs; },
  ]) {
    const f = fake(); f.hooks.result = (r, workload) => { if (workload) mutate(r); };
    const report = await run(f, { target: 2, count: 3 });
    assert.equal(report.error?.code, 'INVALID_BATCH_METRICS');
    assert.equal(report.runs[0].completed, 0); assert.equal(report.runs[0].totalTokens, 0);
    assert.equal(report.runs[0].nativeDecodeCount, 0); assert.equal(report.runs[0].unreportedItems, 1);
    assert.equal(report.runs[1].outcome, 'skipped');
  }
});

test('zero wall durations leave rates unavailable without discarding real native decode telemetry', async () => {
  const report = await run(fake(), { target: 1, count: 3, now: () => 0 });
  const r = report.runs[0];
  assert.equal(r.outcome, 'success'); assert.equal(r.documentsPerSecond, null); assert.equal(r.tokensPerSecond, null);
  assert.equal(r.elapsedMs, 0); assert.equal(r.apiWallMs, 0); assert.ok(r.nativeDecodeMs > 0);
  assert.ok(r.throughputBlocks.every(b => b.documentsPerSecond === null && b.tokensPerSecond === null));
});
