import assert from 'node:assert/strict';
import test from 'node:test';
import type { BatchComparison, BatchRunReport } from './batching';
import { deriveEnergy } from './energy';
import { initialLabState, type BenchmarkReport } from './lab';
import { buildReport, formatBytes, formatDeviceSample, formatMeasurement, formatSeconds, formatTransferRate, humanReport, serializeReport } from './report';
import type { DeviceDiagnostics, DownloadableModel, InstallAttempt, InstallerStatus } from './types';

function fixture() {
  const secret = 'DO_NOT_EXPORT_8f92';
  const error = { code: 'NETWORK_IO', message: `https://host/download?signature=${secret}`, path: `/data/${secret}` };
  const model: DownloadableModel = {
    modelId: 'LiquidAI/LFM2.5-Embedding-350M', repository: 'LiquidAI/LFM2.5-Embedding-350M-GGUF',
    filename: 'model.gguf', format: 'GGUF', revision: 'abcd1234', quantization: 'Q8_0', dimensions: 1024,
    maxTokens: 512, expectedBytes: 379216640, sha256: 'a'.repeat(64), backendRevision: 'backend123', batchMode: 'sequential',
    downloadUrl: `https://host/download?signature=${secret}`,
  };
  const device: DeviceDiagnostics = {
    timestamp: 12345, manufacturer: 'Google', model: 'Pixel 9', androidVersion: '15', sdk: 35,
    abi: 'arm64-v8a', supportedAbis: ['arm64-v8a'], soc: { model: 'Tensor G4', manufacturer: 'Google' },
    totalRamBytes: 8e9, availableRamBytes: 4e9, appPssBytes: 1048576, rssBytes: null,
    nativeHeapBytes: 2e6, javaHeapBytes: 3e6, batteryLevel: 75, batteryTemperatureC: 31.5,
    thermalStatus: 0, lowMemory: false, thresholdBytes: 1e8,
  };
  Object.assign(device, { deviceId: secret, androidId: secret, serial: secret, chats: [{ text: secret }] });
  const attempt: InstallAttempt = {
    operation: 'download', startedAt: 1, completedAt: 100, outcome: 'error', downloadDurationMs: 50,
    verificationDurationMs: 20, finalizationDurationMs: 5, totalElapsedMs: 75, networkBytes: 100,
    averageBytesPerSecond: 2000, timeToFirstByteMs: null, availableStorageBeforeBytes: -1,
    availableStorageAfterBytes: null, error,
  };
  Object.assign(attempt, { signedUrl: secret, input: secret });
  const installer: InstallerStatus = {
    state: 'partial', busy: false, operation: null, downloadedBytes: 100, expectedBytes: model.expectedBytes,
    progressPercent: 1, verifiedBytes: 0, verificationProgressPercent: 0, elapsedMs: 75,
    recentBytesPerSecond: 0, averageBytesPerSecond: 2000, availableStorageBytes: -1, installedBytes: 0,
    model, error, metrics: {
      downloadAttempts: 2, failures: 1, cancelled: 1, lastAttempt: attempt, lastDownload: attempt,
      lastSuccessfulInstall: { ...attempt, operation: 'install', outcome: 'success' },
      lastInterruptedAttempt: { ...attempt, outcome: 'interrupted' },
      lastVerification: { durationMs: 20, bytes: 100, valid: false, source: `/data/${secret}`, timestamp: 4 },
      lastError: { ...error, timestamp: 4 }, lastPersistenceError: { ...error, timestamp: 5 },
    },
  };
  const state = initialLabState();
  Object.assign(state, { input: secret, vectors: [[987654.321]], credentials: secret, chats: secret });
  state.installer = installer;
  state.device = device;
  state.model = model;
  state.storage = { availableBytes: -1, requiredBytes: 513434368, headroomBytes: 134217728 };
  state.storageCategory = `/data/user/0/${secret}`;
  state.errors = [{ timestamp: 1, operation: 'benchmark', error }];
  state.cancellations = 1;
  state.single = {
    kind: 'query', dimensions: 1024, norm: 1, first12: [987654.321], tokenCount: 12,
    inferenceDurationMs: 4, tokensPerMs: 3, warm: false, modelId: model.modelId, revision: model.revision, quantization: model.quantization,
  };
  state.loads = [{ timestamp: 1, outcome: 'success', elapsedMs: 60, loadDurationMs: 50, before: device,
    after: device, observedPssDeltaBytes: -1024, error }];
  // Extra runtime properties and future contract fields must never cross the whitelist boundary.
  state.benchmarks = [{
    timestamp: 1, mode: 'warm', size: '128', requested: 100, attempted: 20, completed: 10, cancelled: 90,
    failures: 0, skipped: 0, unreportedItems: 10, outcome: 'cancelled', actualTokens: 128,
    elapsedMs: 100, inferenceOnlyMs: 40, inferenceCallElapsedMs: 45, diagnosticsMs: 10, preparationMs: 5,
    nonInferenceMs: 60, documentsPerSecond: 100, inferenceDocumentsPerSecond: 250,
    targetTokens: 128, tokenizerCalls: 9, coldInferences: 0, warmInferences: 10,
    totalTokens: 1280, tokensPerSecond: 12800, inferenceTokensPerSecond: 32000,
    firstInferenceWarm: true, batchImplementation: 'sequential', chunkSize: 10,
    latencyMs: { count: 10, total: 40, mean: 4, median: 4, p95: 4 },
    memoryBefore: device, memoryAfter: device, latestDevice: device, samplePeakPssBytes: 1048576, samples: [device],
    diagnosticErrors: [error], load: state.loads[0], error,
    vectors: [[987654.321]], text: secret, path: secret,
  } as unknown as BenchmarkReport];
  return { state, secret };
}

test('reports whitelist deeply nested metadata, metrics, diagnostics and errors, excluding private payloads', () => {
  const { state, secret } = fixture();
  for (const output of [serializeReport(state), humanReport(state)]) {
    assert.ok(!output.includes(secret));
    assert.ok(!output.includes('987654.321'));
    assert.ok(!output.includes('https://host'));
    assert.ok(!output.includes('/data/'));
    assert.ok(output.includes('LiquidAI/LFM2.5-Embedding-350M'));
    assert.ok(output.includes('NETWORK_IO'));
  }
  const report = buildReport(state, '2026-09-06T12:00:00.000Z');
  assert.equal(report.schemaVersion, 2); assert.equal(report.timestamp, '2026-09-06T12:00:00.000Z');
  assert.equal(report.installation?.storageCategory, 'app-managed');
  assert.equal(report.installation?.['availableStorageBytes'], null);
  assert.equal(report.installation?.metrics.lastDownload?.['availableStorageBeforeBytes'], null);
  assert.equal(report.installation?.metrics.lastDownload?.['timeToFirstByteMs'], null);
  assert.equal(report.loads[0]['observedPssDeltaBytes'], -1024);
  assert.equal(report.benchmarks[0].outcome, 'cancelled');
  assert.equal(report.benchmarks[0]['completed'], 10);
  assert.equal(report.benchmarks[0]['totalTokens'], 1280);
  assert.equal(report.benchmarks[0]['tokensPerSecond'], 12800);
  assert.equal(report.benchmarks[0]['inferenceTokensPerSecond'], 32000);
  assert.equal(report.benchmarks[0].latestDevice?.['availableRamBytes'], 4e9);
  assert.equal(report.device?.['rssBytes'], null);
  const forbidden = new Set(['vector', 'vectors', 'first12', 'text', 'input', 'path', 'downloadUrl', 'signedUrl', 'deviceId', 'androidId', 'serial', 'credentials', 'chats']);
  const inspect = (value: unknown) => {
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      assert.ok(!forbidden.has(key), `unexpected exported key ${key}`); inspect(child);
    }
  };
  inspect(report);
});

test('metadata is sanitized, unknown error codes/messages omitted, numbers stay finite or null', () => {
  const { state, secret } = fixture();
  state.device!.model = `/data/${secret}`;
  state.device!.soc!.model = `https://host/?token=${secret}`;
  state.installer!.model.revision = `https://host/?token=${secret}`;
  state.installer!.model.repository = `../../${secret}`;
  state.installer!.model.filename = `/data/${secret}`;
  state.installer!.model.sha256 = secret;
  state.device!.appPssBytes = NaN;
  state.single!.inferenceDurationMs = Infinity;
  state.errors[0].error.code = secret;
  const json = serializeReport(state);
  assert.ok(!json.includes(secret)); assert.ok(!json.includes('Infinity')); assert.ok(!json.includes('NaN'));
  assert.equal(buildReport(state).device?.['appPssBytes'], null);
  assert.equal(buildReport(state, secret).timestamp, null);
});

test('human copy labels actual units and unavailable values without inventing measurements', () => {
  const { state } = fixture();
  const human = humanReport(state);
  assert.match(human, /^SAM Embeddings Benchmark\n/);
  for (const heading of ['Device', 'Model', 'Installation', 'Runtime', 'Inference', 'Benchmarks', 'Thermal', 'Errors']) {
    assert.ok(human.includes(`\n${heading}\n`));
  }
  assert.match(human, /Official size: 379.216640 MB/);
  assert.match(human, /TTFB: unavailable/);
  assert.match(human, /Latency avg\/median\/P95: 4.00 ms \/ 4.00 ms \/ 4.00 ms/);
  assert.match(human, /native sum: 40.00 ms; total: 100.00 ms; inference API: 45.00 ms/);
  assert.match(human, /Throughput total: 100.00 documents\/s, 12800.00 tokens\/s; inference: 250.00 documents\/s, 32000.00 tokens\/s/);
  assert.match(human, /Completed\/attempted: 10\/20; failures\/cancelled\/skipped\/unreported: 0\/90\/0\/10/);
  assert.match(human, /total: 1280 tokens/);
  assert.match(human, /12800.00 tokens\/s/);
  assert.match(human, /32000.00 tokens\/s/);
  assert.match(human, /Last download \(error\): 0.050 s; average: 0.002 MB\/s/);
  assert.match(human, /Last operation \(download, error\): verify: 0.020 s; finalize: 0.005 s; total: 0.075 s/);
  assert.match(human, /Storage before\/after \(last operation\): unavailable \/ unavailable/);
  assert.match(human, /Last load \(success\): native: 50.00 ms; total with samples: 60.00 ms/);
  assert.match(human, /temperature: 31.50 C/);
  assert.match(human, /battery: 75.00 %/);
  assert.match(human, /App PSS: 1.000 MiB/);
  assert.match(human, /observed delta: -0.001 MiB/);
  assert.equal(formatMeasurement(null, 'ms'), 'unavailable');
  assert.equal(formatMeasurement(NaN), 'unavailable');
  assert.equal(formatBytes(-1), 'unavailable');
  assert.equal(formatBytes(0), '0.00 MiB (0 bytes)');
  const empty = humanReport(initialLabState());
  assert.match(empty, /Device\nunavailable/);
  assert.match(empty, /Official size: unavailable/);
  assert.match(empty, /Last load: unavailable/);
  assert.match(empty, /Benchmarks\nNo benchmarks recorded/);
});

test('human copy derives artifact size from metadata and leaves unmeasured benchmark/thermal values unavailable', () => {
  const { state } = fixture();
  state.installer!.model.expectedBytes = 1234567;
  state.device!.thermalStatus = null;
  state.device!.batteryTemperatureC = null;
  state.benchmarks[0].latencyMs = { count: 0, total: 0, mean: null, median: null, p95: null };
  state.benchmarks[0].tokensPerSecond = null;
  state.benchmarks[0].inferenceTokensPerSecond = null;
  const human = humanReport(state);
  assert.match(human, /Official size: 1.234567 MB/);
  assert.doesNotMatch(human, /379.216640/);
  assert.match(human, /Latency avg\/median\/P95: unavailable \/ unavailable \/ unavailable/);
  assert.match(human, /Thermal status before\/after\/peak: unavailable \/ unavailable \/ unavailable/);
  assert.match(human, /temperature before\/after\/peak: unavailable \/ unavailable \/ unavailable/);
  assert.doesNotMatch(human, /\bnull\b|\bundefined\b|NaN|Infinity/);
});

test('human copy stays compact and the size budget retains whole legacy benchmarks with explicit omissions', () => {
  const { state, secret } = fixture();
  state.benchmarks = Array.from({ length: 20 }, (_, i) => ({ ...state.benchmarks[0], timestamp: i + 1,
    samples: Array.from({ length: 128 }, (_, j) => ({ ...state.device!, timestamp: 900000000 + j,
      thermalStatus: j === 64 ? 3 : 0, batteryTemperatureC: j === 64 ? 42 : 31.5 })),
    diagnosticErrors: Array(128).fill(state.errors[0].error),
  }));
  state.loads = Array.from({ length: 20 }, (_, i) => ({ ...state.loads[0], loadDurationMs: i === 19 ? 50 : 98765 }));
  state.errors = Array(50).fill(state.errors[0]);
  const before = buildReport(state, '2026-09-06T12:00:00.000Z');
  const human = humanReport(state);
  assert.ok(human.length < 30000, `Human report is ${human.length} characters`);
  assert.ok(human.split('\n').length < 250, 'Human copy must summarize rather than dump samples');
  assert.equal((human.match(/^#\d+ /gm) ?? []).length, before.benchmarks.length);
  assert.equal((human.match(/Last load \(/g) ?? []).length, 1);
  assert.doesNotMatch(human, /98765|900000000|samples\.\d|memoryBefore\.|DO_NOT_EXPORT|987654\.321/);
  assert.ok(!human.includes(secret));
  assert.match(human, /status before\/after\/peak: 0 \/ 0 \/ 3/);
  assert.match(human, /temperature before\/after\/peak: 31.50 C \/ 31.50 C \/ 42.00 C/);
  const json = JSON.parse(serializeReport(state));
  assert.equal(json.benchmarks.length + json.retention.omittedBenchmarks, 20);
  assert.ok(Buffer.byteLength(serializeReport(state)) <= 1024 * 1024);
  assert.ok(json.benchmarks.every((run: { samples: unknown[] }) => run.samples.length === 128));
  assert.equal(json.benchmarks[0].samples[64].batteryTemperatureC, 42);
  assert.deepEqual(buildReport(state, '2026-09-06T12:00:00.000Z'), before);
});

test('export retention is bounded and serialization does not mutate or invoke adapter toJSON', () => {
  const { state } = fixture();
  Object.assign(state.installer!.model, { toJSON() { throw new Error('must not serialize adapter'); } });
  state.benchmarks = Array(30).fill(state.benchmarks[0]);
  state.benchmarks[0].samples = Array(200).fill(state.device);
  state.loads = Array(30).fill(state.loads[0]);
  state.errors = Array(60).fill(state.errors[0]);
  const report = buildReport(state);
  assert.equal(report.benchmarks.length + report.retention.omittedBenchmarks, 30); assert.equal(report.benchmarks[0].samples.length, 128);
  assert.equal(report.benchmarks[0].retention.omittedSamples, 72);
  assert.equal(report.loads.length, 20); assert.equal(report.errors.length, 50);
  assert.equal(state.benchmarks.length, 30); assert.equal(state.benchmarks[0].samples.length, 200);
  assert.doesNotThrow(() => serializeReport(state));
});

test('transfer/elapsed display conversions use decimal MB/s and seconds, preserving unavailable states', () => {
  assert.equal(formatTransferRate(12_500_000), '12.500 MB/s');
  assert.equal(formatTransferRate(1_048_576), '1.049 MB/s');
  assert.equal(formatTransferRate(0), '0.000 MB/s');
  assert.equal(formatSeconds(12500), '12.50 s');
  assert.equal(formatSeconds(0), '0.00 s');
  for (const missing of [null, undefined, NaN, Infinity, -1]) {
    assert.equal(formatTransferRate(missing), 'unavailable');
    assert.equal(formatSeconds(missing), 'unavailable');
  }
});

test('live device summary displays the latest measurements and explicit unavailable values', () => {
  const { state } = fixture();
  const summary = formatDeviceSample(state.device);
  assert.match(summary, /Available RAM:/); assert.match(summary, /App PSS: 1.00 MiB/);
  assert.match(summary, /Thermal status: 0/); assert.match(summary, /Battery temperature: 31.50 C/);
  assert.match(summary, /12345 Unix ms/); assert.match(summary, /Low memory: false/);
  assert.equal(formatDeviceSample(null), 'Latest device sample: unavailable.');
  assert.match(formatDeviceSample({ ...state.device!, thermalStatus: null, batteryTemperatureC: null }), /Thermal status: unavailable\nBattery temperature: unavailable/);
});

test('exports preserve known native codes with actionable safe messages but never native exception text', () => {
  const { state } = fixture();
  for (const code of ['INPUT_TOO_LONG', 'EMPTY_INPUT', 'MODEL_NOT_LOADED', 'MODEL_LOAD_FAILED', 'NATIVE_INIT_FAILED', 'INVALID_PATH']) {
    state.errors = [{ timestamp: 1, operation: 'single', error: { code, message: '/data/private/text secret', actualTokens: 600, maxTokens: 512 } }];
    const error = buildReport(state).errors[0].error!;
    assert.equal(error.code, code); assert.ok(error.message.length > 20);
    assert.doesNotMatch(error.message, /\/data|secret/);
    assert.equal(error.actualTokens, 600); assert.equal(error.maxTokens, 512);
  }
});

function batchFixture(count = 100) {
  const { state, secret } = fixture();
  const limits = { nBatch: 1024, nUbatch: 1024, nCtx: 4096, nCtxSeq: 512,
    maxParallelSequences: 8, backendMaxParallelSequences: 256, backendSequenceExecution: 'serial_ubatches' as const };
  state.model!.batchMode = 'true_batch'; state.model!.batchLimits = limits;
  const comparison: BatchComparison = {
    timestamp: 12345, size: 'short', requested: count, requestedTarget: null, outcome: 'success',
    actualTokens: 24, targetTokens: 24, tokenizerCalls: 4, sizingMs: 5, limits,
    correctness: { outcome: 'passed', documents: 4, completed: 4, tolerance: 0.99999, minimumCosine: 1,
      elapsedMs: 20, nativeDecodeCount: 1, scope: 'representative-multilingual-count-order-dimensions-finite-cosine' },
    runs: [1, 2, 5, 10, 20, 50, 100].map((target): BatchRunReport => {
      const capacity = Math.min(target, 8);
      const elapsedMs = target === 1 ? 120000 : target === 2 ? 90000 : target === 5 ? 85000 : 80000;
      const decodes = Array.from({ length: Math.ceil(count / capacity) }, (_, i) => {
        const sequences = Math.min(capacity, count - i * capacity);
        return { sequences, tokens: sequences * 24, nativeDecodeMs: sequences * 0.123456789 };
      });
      const samples = Array.from({ length: 11 }, (_, i) => ({ ...state.device!, timestamp: 100000 + i * elapsedMs / 10,
        thermalStatus: i === 5 ? 2 : 0, batteryTemperatureC: i === 5 ? 37.5 : 31.5,
        batteryEnergy: { chargeCounterUah: 4000000 - i * 1, currentNowUa: -100001, currentAverageUa: null,
          energyCounterNwh: 15000000000 - i * 4000, plugged: false, status: 3, elapsedRealtimeMs: i * elapsedMs / 10 },
      }));
      return {
        target, mode: target === 1 ? 'sequential' : 'true_batch', optional: false, outcome: 'success', reason: null,
        requested: count, attempted: count, completed: count, unreportedItems: 0, failures: 0, cancelled: 0, skipped: 0,
        actualTokens: 24, totalTokens: count * 24,
        requestedPolicy: { maxSequencesPerBatch: target, maxTokensPerBatch: 4096 },
        effectivePolicy: { maxSequencesPerBatch: capacity, maxTokensPerBatch: 1024 }, limits,
        backendSequenceExecution: 'serial_ubatches', capacitySequences: capacity, chunkSize: capacity,
        requestedBatchSize: target, effectiveBatchSize: capacity, meanSequencesPerDecode: count / decodes.length,
        meanTokensPerDecode: count * 24 / decodes.length, nativeDecodeCount: decodes.length, decodes,
        nativeDecodeMs: count * 0.123456789, nativeElapsedMs: 20, preparationMs: 3, apiWallMs: 25, elapsedMs,
        documentsPerSecond: count * 1000 / elapsedMs, tokensPerSecond: count * 24000 / elapsedMs,
        effectiveMsPerDocument: elapsedMs / count,
        throughputBlocks: ['initial', 'middle', 'final'].map((phase, i) => ({ phase: phase as 'initial' | 'middle' | 'final',
          startMs: i * elapsedMs / 3, endMs: (i + 1) * elapsedMs / 3, elapsedMs: elapsedMs / 3, completed: 1,
          totalTokens: 24, documentsPerSecond: 1 + i, tokensPerSecond: 24 * (1 + i) })), throughputReason: null,
        memoryBefore: samples[0], memoryAfter: samples.at(-1)!, latestDevice: samples.at(-1)!, samplePeakPssBytes: 1048576,
        peaks: { appPssBytes: 1048576, nativeHeapBytes: 2e6, javaHeapBytes: 3e6, minimumAvailableRamBytes: 4e9,
          batteryTemperatureC: 37.5, thermalStatus: 2 }, thermal: { initial: 0, peak: 2, final: 0 },
        temperatureC: { initial: 31.5, peak: 37.5, final: 31.5 }, samples, sampleCount: 11,
        diagnosticErrors: [], energy: deriveEnergy(samples, count, count * 24),
      };
    }),
  };
  state.batchComparisons = [comparison];
  return { state, secret, comparison };
}

test('schema 2 exports all seven tiers, loaded limits, policies, raw energy, decode precision and progression', () => {
  const { state, comparison } = batchFixture();
  const report = buildReport(state);
  const exported = report.batchComparisons[0];
  assert.deepEqual(report.runtimeModel?.batchLimits, comparison.limits);
  assert.equal(report.runtimeModel?.batchMode, 'true_batch');
  assert.deepEqual(exported.runs.map(run => run['target']), [1, 2, 5, 10, 20, 50, 100]);
  assert.deepEqual(exported.limits, comparison.limits);
  const run = exported.runs[6]; const source = comparison.runs[6];
  for (const key of Object.keys(source)) assert.ok(Object.hasOwn(run, key), `missing BatchRunReport field: ${key}`);
  for (const key of Object.keys(comparison)) assert.ok(Object.hasOwn(exported, key), `missing BatchComparison field: ${key}`);
  assert.equal(run['requestedBatchSize'], 100); assert.equal(run['effectiveBatchSize'], 8);
  assert.deepEqual(run.requestedPolicy, source.requestedPolicy); assert.deepEqual(run.effectivePolicy, source.effectivePolicy);
  assert.deepEqual(run.decodes, source.decodes);
  assert.deepEqual(run.samples[0]?.batteryEnergy, source.samples[0].batteryEnergy);
  assert.deepEqual(run.energy, source.energy);
  assert.equal(run.energy['chargeConsumedMah'], 0.01); assert.equal(run.energy['energyConsumedMwh'], 0.04);
  assert.deepEqual(run.thermal, source.thermal); assert.deepEqual(run.temperatureC, source.temperatureC);
  assert.deepEqual(run.peaks, source.peaks); assert.deepEqual(run.throughputBlocks, source.throughputBlocks);
  assert.deepEqual(run.retention, { omittedDecodes: 0, omittedSamples: 0, omittedDiagnosticErrors: 0, omittedThroughputBlocks: 0 });
  const human = humanReport(state);
  assert.match(human, /Loaded nBatch\/nUbatch\/nCtx\/nCtxSeq: 1024\/1024\/4096\/512/);
  assert.match(human, /sequence limit\/backend ceiling: 8\/256; execution: serial_ubatches/);
  assert.match(human, /100 \/ 8 \| success/); assert.match(human, /0\.010000 \| 0\.040000/);
  assert.match(human, /Initial\/middle\/final documents\/s: 1.00\/2.00\/3.00; thermal: 0\/2\/0/);
  assert.match(human, /No production winner or profile pending replicated/);
});

test('batch and energy whitelist rejects arbitrary nested properties, malicious strings and serialization hooks', () => {
  const { state, secret, comparison } = batchFixture();
  const inject = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    for (const child of Object.values(value)) inject(child);
    Object.assign(value, { input: secret, vector: [987654.321], privatePath: `/data/${secret}`,
      toJSON() { throw new Error('adapter serialization invoked'); } });
  };
  inject(comparison);
  for (const malicious of [secret, `/data/${secret}`, `https://host/?token=${secret}`, `ok\n${secret}`, `ok\u0000${secret}`]) {
    const run = comparison.runs[0];
    run.reason = malicious; run.throughputReason = malicious;
    run.energy.reason = malicious; run.energy.chargeReason = malicious; run.energy.energyReason = malicious;
    Object.assign(run, { backendSequenceExecution: malicious, mode: malicious });
    Object.assign(run.energy, { scope: malicious, resolution: malicious, confidence: malicious });
    Object.assign(run.samples[0].batteryEnergy!, { chargeCounterUah: malicious, plugged: malicious });
    run.error = { code: malicious, message: malicious };
    for (const output of [serializeReport(state), humanReport(state)]) {
      assert.doesNotMatch(output, /DO_NOT_EXPORT|987654\.321|\/data\/|https:\/\/host|privatePath|toJSON/);
    }
    const exported = buildReport(state).batchComparisons[0].runs[0];
    assert.equal(exported.samples[0]?.batteryEnergy?.['chargeCounterUah'], null);
    assert.equal(exported.samples[0]?.batteryEnergy?.plugged, null);
    assert.equal(exported.reason, 'Reason omitted (unrecognized diagnostic text).');
    assert.equal(exported.backendSequenceExecution, null);
  }
});

test('null/nonfinite energy and throughput remain unavailable without percentage-derived estimates', () => {
  const { state, comparison } = batchFixture();
  for (const run of comparison.runs) {
    run.energy = deriveEnergy([], run.completed, run.totalTokens);
    run.documentsPerSecond = null; run.tokensPerSecond = NaN; run.effectiveMsPerDocument = Infinity;
    run.samples[0].batteryEnergy!.energyCounterNwh = null;
    run.samples[0].batteryEnergy!.currentNowUa = -100001;
  }
  const exported = buildReport(state).batchComparisons[0].runs[0];
  assert.equal(exported.energy['energyConsumedMwh'], null); assert.equal(exported.energy['mahPer100Documents'], null);
  assert.equal(exported['tokensPerSecond'], null); assert.equal(exported['effectiveMsPerDocument'], null);
  assert.equal(exported.samples[0]?.batteryEnergy?.['currentNowUa'], -100001);
  const human = humanReport(state);
  assert.match(human, /Energy conclusion: unavailable; no energy ranking/);
  assert.match(human, /At least three reliable discharging samples are required/);
  assert.doesNotMatch(human, /Fastest observed in this sweep:|\bnull\b|\bundefined\b|NaN|Infinity/);
});

test('retention preserves 1000 decodes and all tiers per retained comparison within the actual 1 MiB cap', () => {
  const { state, comparison } = batchFixture(1000);
  for (const run of comparison.runs) {
    run.samples = Array.from({ length: 128 }, (_, i) => ({ ...run.samples[0], timestamp: i }));
    run.sampleCount = 128;
  }
  state.batchComparisons = Array.from({ length: 12 }, (_, i) => ({ ...comparison, timestamp: i }));
  const report = buildReport(state);
  assert.ok(report.batchComparisons.length > 0);
  assert.equal(report.batchComparisons.length + report.retention.omittedBatchComparisons, 12);
  assert.equal(report.batchComparisons.at(-1)?.['timestamp'], 11);
  for (const retained of report.batchComparisons) {
    assert.equal(retained.runs.length, 7);
    assert.equal(retained.runs[0].decodes.length, 1000);
    assert.equal(retained.runs[0].retention.omittedDecodes, 0);
    assert.equal(retained.runs[6].samples.length, 128);
  }
  assert.ok(Buffer.byteLength(serializeReport(state), 'utf8') <= 1024 * 1024);
  assert.equal(state.batchComparisons.length, 12); assert.equal(comparison.runs[0].decodes.length, 1000);
  assert.match(humanReport(state), /Retention omissions \(comparisons\/benchmarks\/loads\/errors\):/);
  state.batchComparisons = Array.from({ length: 10 }, (_, i) => ({ ...comparison, timestamp: i,
    runs: comparison.runs.map(run => ({ ...run, decodes: run.decodes.slice(0, 1), samples: [] })) }));
  assert.equal(buildReport(state).batchComparisons.length, 10);
  assert.equal(buildReport(state).batchComparisons[0].runs.length, 7);
  const human = humanReport(state);
  assert.ok(human.length < 60000, `Human report is ${human.length} characters`);
  assert.ok(human.split('\n').length < 300, 'Summarize all 70 tiers without dumping samples or decodes');
});

test('out-of-contract arrays are bounded explicitly and sample endpoints survive export compaction', () => {
  const { state, comparison } = batchFixture();
  const run = comparison.runs[0];
  run.decodes = Array(1001).fill(run.decodes[0]);
  run.samples = Array.from({ length: 200 }, (_, i) => ({ ...run.samples[0], timestamp: i }));
  run.sampleCount = 400;
  run.diagnosticErrors = Array(200).fill({ code: 'SAFETY_UNAVAILABLE', message: 'secret' });
  run.throughputBlocks.push(run.throughputBlocks[0]);
  comparison.runs.push(run);
  const exported = buildReport(state).batchComparisons[0];
  assert.equal(exported.omittedRuns, 1); assert.equal(exported.runs.length, 7);
  assert.deepEqual(exported.runs[0].retention, { omittedDecodes: 1, omittedSamples: 72, omittedDiagnosticErrors: 72, omittedThroughputBlocks: 1 });
  assert.equal(exported.runs[0]['sampleCount'], 400);
  assert.equal(exported.runs[0].samples[0]?.['timestamp'], 0);
  assert.equal(exported.runs[0].samples.at(-1)?.['timestamp'], 199);
  assert.doesNotMatch(humanReport(state), /Fastest observed in this sweep:/);
});

test('a separated successful same-work sweep has only a fastest observation, never a production winner', () => {
  const { state, comparison } = batchFixture();
  comparison.runs = comparison.runs.slice(0, 2);
  const human = humanReport(state);
  assert.match(human, /Fastest observed in this sweep: target 2, effective 2/);
  assert.match(human, /Descriptive only, not a replicated leader or production recommendation/);
  assert.match(human, /Interactive warm single-query native latency: unavailable/);
  state.single!.warm = true;
  assert.match(humanReport(state), /Interactive warm single-query native latency: 4.00 ms/);
  state.single!.kind = 'document';
  assert.match(humanReport(state), /Interactive warm single-query native latency: unavailable/);
  state.warmUp = { ...state.single!, kind: 'query', warm: true, inferenceDurationMs: 7 };
  assert.match(humanReport(state), /Interactive warm single-query native latency: 7.00 ms/);
  assert.match(humanReport(state), /amortized warm wall time, NOT single-query latency/);
});

test('noise, mismatched work/configuration, failed correctness and capped identical policies cannot create a fastest claim', () => {
  const changes: ((comparison: BatchComparison) => void)[] = [
    c => { c.runs[1].documentsPerSecond = c.runs[0].documentsPerSecond! * 1.1; c.runs[1].elapsedMs = 100000 / c.runs[1].documentsPerSecond!; c.runs[1].tokensPerSecond = c.runs[1].documentsPerSecond! * 24; },
    c => { c.runs[1].documentsPerSecond = null; },
    c => { c.runs[1].tokensPerSecond = null; },
    c => { c.runs[1].actualTokens = 128; c.runs[1].totalTokens = 12800; },
    c => { c.runs[1].requested = 99; },
    c => { c.runs[1].limits = { ...c.runs[1].limits, nUbatch: 512 }; },
    c => { c.runs[1].effectivePolicy.maxTokensPerBatch = 512; },
    c => { c.runs[1].requestedPolicy.maxTokensPerBatch = 512; },
    c => { c.runs[1].unreportedItems = 1; },
    c => { c.runs[1].outcome = 'error'; },
    c => { c.correctness.outcome = 'failed'; },
    c => { c.correctness.minimumCosine = null; },
    c => { c.runs[1].cancelled = 1; },
    c => { c.runs = [c.runs[3], c.runs[4]]; c.runs[1].documentsPerSecond = 2; c.runs[1].elapsedMs = 50000; c.runs[1].tokensPerSecond = 48; },
    c => {
      c.size = '256'; c.actualTokens = 256; c.runs = [c.runs[2], c.runs[3]];
      for (const run of c.runs) {
        run.actualTokens = 256; run.totalTokens = 25600; run.tokensPerSecond = run.documentsPerSecond! * 256;
        run.capacitySequences = run.effectiveBatchSize = run.chunkSize = 4;
      }
      c.runs[1].documentsPerSecond = 2; c.runs[1].elapsedMs = 50000; c.runs[1].tokensPerSecond = 512;
    },
  ];
  for (const change of changes) {
    const { state, comparison } = batchFixture();
    change(comparison);
    comparison.runs = comparison.runs.slice(0, 2);
    assert.doesNotMatch(humanReport(state), /Fastest observed in this sweep:/, change.toString());
  }
  const a = batchFixture(); const b = batchFixture();
  a.comparison.runs = a.comparison.runs.slice(0, 1);
  b.comparison.size = '128'; b.comparison.actualTokens = 128; b.comparison.runs = b.comparison.runs.slice(1, 2);
  a.state.batchComparisons.push(b.comparison);
  assert.doesNotMatch(humanReport(a.state), /Fastest observed in this sweep:/, 'never rank across historical corpora/configurations');
});

test('skips, cancellations, atomic unreported work and known reasons remain visible without leaking error text', () => {
  const { state, comparison } = batchFixture();
  comparison.outcome = 'cancelled'; comparison.error = { code: 'CANCELLED', message: '/data/private' };
  const run = comparison.runs[0];
  run.outcome = 'cancelled'; run.cancelled = 90; run.completed = 10; run.unreportedItems = 10;
  run.error = comparison.error;
  run.energy = { ...deriveEnergy([], 0, 0), reason: 'Window includes unreported native work; efficiency normalization is unavailable.' };
  const skipped = comparison.runs[6];
  skipped.outcome = 'skipped'; skipped.skipped = 100; skipped.optional = true;
  skipped.reason = 'Native token capacity: target 100 x 24 tokens requires 2400; loaded token budget 1024, per-sequence context 512, sequence limit 8, fitting capacity 8.';
  comparison.runs[1].reason = 'Not started: Cancelled. Completed measurements remain available.';
  const exported = buildReport(state).batchComparisons[0];
  assert.equal(exported.runs[0]['unreportedItems'], 10); assert.equal(exported.runs[0]['cancelled'], 90);
  assert.equal(exported.runs[6].reason, skipped.reason); assert.equal(exported.runs[6].optional, true);
  assert.equal(exported.runs[1].reason, comparison.runs[1].reason);
  const human = humanReport(state);
  assert.match(human, /Failures\/skipped\/cancelled\/unreported: 0\/0\/90\/10/);
  assert.match(human, /Native token capacity: target 100/);
  assert.match(human, /Window includes unreported native work/);
  assert.doesNotMatch(human, /\/data\/private|Fastest observed in this sweep:/);
});

test('metadata and reason validation rejects trailing newlines rather than accepting a regex end-of-line match', () => {
  const { state, comparison } = batchFixture();
  state.model!.modelId = 'valid/model\n'; state.device!.model = 'Valid Model\r\n';
  state.installer!.model.sha256 = 'a'.repeat(64) + '\n';
  comparison.runs[0].reason = 'Native token capacity: target 100 x 24 tokens requires 2400; loaded token budget 1024, per-sequence context 512, sequence limit 8, fitting capacity 8.\n';
  const report = buildReport(state, '2026-09-06T12:00:00.000Z\n');
  assert.equal(report.timestamp, null); assert.equal(report.runtimeModel?.modelId, null);
  assert.equal(report.device?.model, null); assert.equal(report.installation?.source?.sha256, null);
  assert.equal(report.batchComparisons[0].runs[0].reason, 'Reason omitted (unrecognized diagnostic text).');
  for (const terminator of ['\u2028', '\u2029']) {
    state.model!.modelId = `valid/model${terminator}`; state.device!.model = `Valid Model${terminator}`;
    comparison.runs[0].reason = comparison.runs[0].reason!.slice(0, -1) + terminator;
    assert.equal(buildReport(state).runtimeModel?.modelId, null);
    assert.equal(buildReport(state).device?.model, null);
    assert.doesNotMatch(serializeReport(state), /[^\x00-\x7f]/, 'ASCII output makes character and UTF-8 byte budgets identical');
  }
});
