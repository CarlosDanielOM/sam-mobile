import { cosine } from './math';
import { labError, sizeBenchmarkInput, summarizeVector, type BenchmarkSize } from './lab';
import { deriveEnergy, type EnergyEfficiency } from './energy';
import {
  EmbeddingError, type BatchMode, type BatchingPolicy, type DeviceDiagnostics,
  type EmbeddingBatchResult, type EmbeddingErrorInfo, type EmbeddingService,
  type NativeBatchLimits, type NativeDecodeMeasurement,
} from './types';

export const BATCH_TARGETS: Readonly<Record<BenchmarkSize, readonly number[]>> = {
  short: [1, 2, 5, 10, 20, 50, 100], '128': [1, 2, 5, 10, 20, 50],
  '256': [1, 2, 5, 10, 20], near512: [1, 2, 5, 10],
};
const OPTIONAL_TARGET: Partial<Record<BenchmarkSize, number>> = { '128': 50, '256': 20, near512: 10 };
const MIB = 1024 * 1024;
const SAMPLE_LIMIT = 128;
const LIMIT_KEYS = ['nBatch', 'nUbatch', 'nCtx', 'nCtxSeq', 'maxParallelSequences', 'backendMaxParallelSequences'] as const;

export type BatchOutcome = 'running' | 'success' | 'error' | 'cancelled' | 'safety-stop' | 'skipped';
export interface BatchCorrectness {
  outcome: 'pending' | 'running' | 'passed' | 'failed' | 'cancelled' | 'safety-stop';
  documents: number;
  completed: number;
  tolerance: number;
  minimumCosine: number | null;
  elapsedMs: number;
  nativeDecodeCount: number;
  /** A representative diagnostic, not a claim of production correctness. */
  scope: 'representative-multilingual-count-order-dimensions-finite-cosine';
  error?: EmbeddingErrorInfo;
}
export interface BatchThroughputBlock {
  phase: 'initial' | 'middle' | 'final';
  startMs: number;
  endMs: number;
  elapsedMs: number;
  completed: number;
  totalTokens: number;
  documentsPerSecond: number | null;
  tokensPerSecond: number | null;
}
export interface BatchSamplePeaks {
  appPssBytes: number | null;
  nativeHeapBytes: number | null;
  javaHeapBytes: number | null;
  minimumAvailableRamBytes: number | null;
  batteryTemperatureC: number | null;
  thermalStatus: number | null;
}
/** No corpus text or embeddings are retained. All timings below exclude sizing and the correctness gate. */
export interface BatchRunReport {
  target: number;
  mode: BatchMode;
  optional: boolean;
  outcome: 'pending' | BatchOutcome;
  reason: string | null;
  requested: number;
  attempted: number;
  completed: number;
  /** Atomic rejected/invalid chunks may have executed work, but expose no trustworthy item results. */
  unreportedItems: number;
  failures: number;
  cancelled: number;
  skipped: number;
  actualTokens: number;
  totalTokens: number;
  requestedPolicy: BatchingPolicy;
  effectivePolicy: BatchingPolicy;
  limits: NativeBatchLimits;
  backendSequenceExecution: 'serial_ubatches';
  capacitySequences: number;
  chunkSize: number;
  requestedBatchSize: number;
  /** Maximum observed sequences in a real decode, not target or chunk length. */
  effectiveBatchSize: number;
  meanSequencesPerDecode: number | null;
  meanTokensPerDecode: number | null;
  nativeDecodeCount: number;
  decodes: NativeDecodeMeasurement[];
  nativeDecodeMs: number;
  /** Sum of successful native API totalElapsedMs values, excluding bridge and diagnostics. */
  nativeElapsedMs: number;
  /** Native tokenization/packing time, not the one-time corpus sizingMs. */
  preparationMs: number;
  /** Awaited native API wall time, including rejected calls; no fabricated item latencies. */
  apiWallMs: number;
  /** Warm wall interval including safety checkpoints and drained failed calls. */
  elapsedMs: number;
  documentsPerSecond: number | null;
  tokensPerSecond: number | null;
  /** Amortized warm wall time per completed document, not a single-document inference latency. */
  effectiveMsPerDocument: number | null;
  throughputBlocks: BatchThroughputBlock[];
  throughputReason: string | null;
  memoryBefore: DeviceDiagnostics | null;
  memoryAfter: DeviceDiagnostics | null;
  latestDevice: DeviceDiagnostics | null;
  samplePeakPssBytes: number | null;
  peaks: BatchSamplePeaks;
  thermal: { initial: number | null; peak: number | null; final: number | null };
  temperatureC: { initial: number | null; peak: number | null; final: number | null };
  /** Uniform index-grid compaction with both endpoints; peaks are accumulated before compaction. */
  samples: DeviceDiagnostics[];
  sampleCount: number;
  diagnosticErrors: EmbeddingErrorInfo[];
  energy: EnergyEfficiency;
  error?: EmbeddingErrorInfo;
}
/** UI integration: LabState.batchComparisons holds these, including running snapshots. */
export interface BatchComparison {
  timestamp: number;
  size: BenchmarkSize;
  requested: number;
  /** null means the whole matrix; a target means the ascending prefix through that target. */
  requestedTarget: number | null;
  outcome: BatchOutcome;
  actualTokens: number | null;
  targetTokens: number | null;
  tokenizerCalls: number;
  sizingMs: number;
  limits: NativeBatchLimits | null;
  correctness: BatchCorrectness;
  runs: BatchRunReport[];
  error?: EmbeddingErrorInfo;
}

function fail(code: string): never { throw new EmbeddingError(labError({ code })); }
function checkCancelled(signal: AbortSignal): void { if (signal.aborted) fail('CANCELLED'); }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function positiveInteger(value: unknown): value is number { return finite(value) && Number.isInteger(value) && value > 0; }

/** The API permits 1..4096 requested tokens; actual loaded limits always win. */
export function clampBatchPolicy(limits: NativeBatchLimits, target: number, maxTokens = 4096): BatchingPolicy {
  if (!limits || LIMIT_KEYS.some(key => !positiveInteger(limits[key])) || limits.backendSequenceExecution !== 'serial_ubatches') {
    fail('BATCH_LIMITS_UNAVAILABLE');
  }
  if (!positiveInteger(target) || target > 100 || !positiveInteger(maxTokens) || maxTokens > 4096) fail('INVALID_BENCHMARK');
  return {
    maxSequencesPerBatch: Math.min(target, limits.maxParallelSequences, limits.backendMaxParallelSequences),
    maxTokensPerBatch: Math.min(maxTokens, limits.nBatch, limits.nUbatch, limits.nCtx),
  };
}

/** Unknown safety readings cannot authorize native batching or escalation. */
export function checkBatchSafety(device: DeviceDiagnostics | null): void {
  if (device?.lowMemory === true || (finite(device?.availableRamBytes) && finite(device?.thresholdBytes) &&
      device.availableRamBytes < Math.max(device.thresholdBytes + 256 * MIB, 512 * MIB))) fail('LOW_MEMORY');
  if ((finite(device?.thermalStatus) && device.thermalStatus >= 3) ||
      (finite(device?.batteryTemperatureC) && device.batteryTemperatureC >= 42)) fail('THERMAL_LIMIT');
  if (!device || device.lowMemory !== false || !finite(device.availableRamBytes) || device.availableRamBytes < 0 ||
      !finite(device.thresholdBytes) || device.thresholdBytes < 0 || !finite(device.thermalStatus) || device.thermalStatus < 0 ||
      !finite(device.batteryTemperatureC)) fail('SAFETY_UNAVAILABLE');
}

function outcome(error: EmbeddingErrorInfo): 'error' | 'cancelled' | 'safety-stop' {
  return error.code === 'CANCELLED' ? 'cancelled'
    : ['LOW_MEMORY', 'THERMAL_LIMIT', 'SAFETY_UNAVAILABLE'].includes(error.code) ? 'safety-stop' : 'error';
}

function validateBatch(result: EmbeddingBatchResult, count: number, mode: BatchMode, policy: BatchingPolicy,
  limits: NativeBatchLimits, expectedTokens?: number): void {
  const m = result?.metrics;
  if (!Array.isArray(result?.embeddings) || result.embeddings.length !== count || !m || m.mode !== mode ||
      m.requestedBatchSize !== policy.maxSequencesPerBatch || !Array.isArray(m.decodes) || !m.decodes.length ||
      m.nativeDecodeCount !== m.decodes.length || !positiveInteger(m.totalTokens) ||
      [m.totalElapsedMs, m.nativeDecodeMs, m.preparationMs, m.effectiveMsPerDocument, m.documentsPerSecond, m.tokensPerSecond]
        .some(value => !finite(value) || value < 0) || !m.limits ||
      LIMIT_KEYS.some(key => m.limits[key] !== limits[key]) || m.limits.backendSequenceExecution !== limits.backendSequenceExecution) fail('INVALID_BATCH_METRICS');
  let tokens = 0;
  for (const item of result.embeddings) {
    summarizeVector(item, 'document');
    if (item.tokenCount > limits.nCtxSeq || (expectedTokens !== undefined && item.tokenCount !== expectedTokens)) fail('TOKEN_SIZING');
    tokens += item.tokenCount;
  }
  let sequences = 0;
  let decodeTokens = 0;
  let decodeMs = 0;
  let maximum = 0;
  for (const d of m.decodes) {
    if (!positiveInteger(d.sequences) || d.sequences > policy.maxSequencesPerBatch || (mode === 'sequential' && d.sequences !== 1) ||
        !positiveInteger(d.tokens) || d.tokens > policy.maxTokensPerBatch || !finite(d.nativeDecodeMs) || d.nativeDecodeMs < 0 ||
        (expectedTokens !== undefined && d.tokens !== d.sequences * expectedTokens)) fail('INVALID_BATCH_METRICS');
    sequences += d.sequences; decodeTokens += d.tokens; decodeMs += d.nativeDecodeMs;
    maximum = Math.max(maximum, d.sequences);
  }
  if (sequences !== count || tokens !== m.totalTokens || decodeTokens !== tokens || m.effectiveBatchSize !== maximum ||
      Math.abs(decodeMs - m.nativeDecodeMs) > Math.max(0.01, decodeMs * 1e-6) ||
      m.nativeDecodeMs + m.preparationMs > m.totalElapsedMs + 0.01) fail('INVALID_BATCH_METRICS');
}

/** Samples during native calls with a recursive timer, never overlapping diagnostic requests.
 * Abort requests cancellation but always await the native promise and any active sample before returning. */
async function monitored<T>(signal: AbortSignal, sample: () => Promise<DeviceDiagnostics | null>,
  work: (signal: AbortSignal, checkpoint: () => Promise<void>) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  let stopped: EmbeddingErrorInfo | undefined;
  const cancel = () => { stopped ??= labError({ code: 'CANCELLED' }); abort.abort(); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sampling: Promise<void> | undefined;
  let finished = false;
  const checkpoint = async () => {
    if (!sampling) sampling = (async () => {
      try { checkBatchSafety(await sample().catch(() => null)); }
      catch (error) { stopped ??= labError(error); abort.abort(); }
    })();
    try { await sampling; } finally { sampling = undefined; }
    if (stopped) throw new EmbeddingError(stopped);
    checkCancelled(abort.signal);
  };
  const schedule = () => {
    timer = setTimeout(async () => {
      try { await checkpoint(); } catch { /* Delivered after native work drains. */ }
      if (!finished && !stopped) schedule();
    }, 1000);
  };
  try {
    await checkpoint();
    schedule();
    const result = await work(abort.signal, checkpoint);
    await checkpoint();
    return result;
  } catch (error) {
    throw stopped ? new EmbeddingError(stopped) : error;
  } finally {
    finished = true;
    clearTimeout(timer);
    await sampling;
    signal.removeEventListener('abort', cancel);
  }
}

// Public, distinct inputs only. Baseline vectors remain local and are discarded before measurement.
const GATE_DOCUMENTS = [
  'Reset your account password using the email recovery link.',
  'Las verduras se cocinan en el horno con aceite de oliva.',
  'Die Sterne einer fernen Galaxie leuchten am Nachthimmel.',
  '\u96e8\u306e\u5f8c\u3001\u5ead\u306e\u82b1\u304c\u54b2\u304d\u307e\u3057\u305f\u3002',
];

export interface BatchRunnerOptions {
  service: EmbeddingService;
  sampleDevice: () => Promise<DeviceDiagnostics | null>;
  signal: AbortSignal;
  size: BenchmarkSize;
  count?: number;
  target?: number;
  now?: () => number;
  timestamp?: number;
  publish?: (comparison: BatchComparison, phase: string) => void;
}

/** Both UI methods use this runner. A selected target still runs the lower tiers first. */
export async function runBatchComparison(options: BatchRunnerOptions): Promise<BatchComparison> {
  const { service, sampleDevice, signal, size, target } = options;
  const count = options.count ?? 100;
  const now = options.now ?? (() => globalThis.performance?.now() ?? Date.now());
  const report: BatchComparison = {
    timestamp: options.timestamp ?? Date.now(), size, requested: count, requestedTarget: target ?? null,
    outcome: 'running', actualTokens: null, targetTokens: null, tokenizerCalls: 0, sizingMs: 0, limits: null,
    correctness: { outcome: 'pending', documents: GATE_DOCUMENTS.length, completed: 0, tolerance: 0.99999,
      minimumCosine: null, elapsedMs: 0, nativeDecodeCount: 0,
      scope: 'representative-multilingual-count-order-dimensions-finite-cosine' }, runs: [],
  };
  // Reports contain plain data only. Running snapshots must not mutate under UI observers.
  const publish = (phase: string) => options.publish?.({ ...report, correctness: { ...report.correctness },
    runs: report.runs.map(run => ({ ...run, decodes: [...run.decodes], samples: [...run.samples],
      diagnosticErrors: [...run.diagnosticErrors], throughputBlocks: [...run.throughputBlocks],
      peaks: { ...run.peaks }, thermal: { ...run.thermal }, temperatureC: { ...run.temperatureC } })),
  }, phase);
  publish('Preparing batching comparison');
  try {
    if (!Object.hasOwn(BATCH_TARGETS, size) || !positiveInteger(count) || count > 1000 ||
        (target !== undefined && !BATCH_TARGETS[size].includes(target))) fail('INVALID_BENCHMARK');
    if (!service.isLoaded()) fail('NOT_LOADED');
    if (!service.embedDocumentsMeasured) fail('BATCH_UNAVAILABLE');
    const limits = service.getModelInfo().batchLimits;
    if (!limits) fail('BATCH_LIMITS_UNAVAILABLE');
    clampBatchPolicy(limits, 1);
    report.limits = { ...limits };
    checkCancelled(signal);
    checkBatchSafety(await sampleDevice().catch(() => null));
    const prep = now();
    let input: Awaited<ReturnType<typeof sizeBenchmarkInput>>;
    try {
      input = await sizeBenchmarkInput(service, size, signal, calls => { report.tokenizerCalls = calls; });
    } finally { report.sizingMs = now() - prep; }
    report.actualTokens = input.actualTokens;
    report.targetTokens = input.targetTokens;
    // Generated once, reused verbatim by baseline and every tier. No sizing/load energy in runs.
    const corpus = Array<string>(count).fill(input.text);
    const tiers = BATCH_TARGETS[size].filter(tier => target === undefined || tier <= target);
    for (const tier of tiers) {
      const effectivePolicy = clampBatchPolicy(limits, tier);
      const capacity = input.actualTokens <= limits.nCtxSeq
        ? Math.min(effectivePolicy.maxSequencesPerBatch, Math.floor(effectivePolicy.maxTokensPerBatch / input.actualTokens)) : 0;
      const run: BatchRunReport = {
        target: tier, mode: tier === 1 ? 'sequential' : 'true_batch', optional: OPTIONAL_TARGET[size] === tier,
        outcome: 'pending', reason: null, requested: count, attempted: 0, completed: 0,
        unreportedItems: 0, failures: 0, cancelled: 0, skipped: 0, actualTokens: input.actualTokens, totalTokens: 0,
        requestedPolicy: { maxSequencesPerBatch: tier, maxTokensPerBatch: 4096 }, effectivePolicy,
        limits: { ...limits }, backendSequenceExecution: limits.backendSequenceExecution,
        capacitySequences: capacity, chunkSize: Math.min(tier, capacity, count), requestedBatchSize: tier,
        effectiveBatchSize: 0, meanSequencesPerDecode: null, meanTokensPerDecode: null,
        nativeDecodeCount: 0, decodes: [], nativeDecodeMs: 0, nativeElapsedMs: 0, preparationMs: 0,
        apiWallMs: 0, elapsedMs: 0, documentsPerSecond: null, tokensPerSecond: null, effectiveMsPerDocument: null,
        throughputBlocks: [], throughputReason: null, memoryBefore: null, memoryAfter: null, latestDevice: null,
        samplePeakPssBytes: null, peaks: { appPssBytes: null, nativeHeapBytes: null, javaHeapBytes: null,
          minimumAvailableRamBytes: null, batteryTemperatureC: null, thermalStatus: null },
        thermal: { initial: null, peak: null, final: null }, temperatureC: { initial: null, peak: null, final: null },
        samples: [], sampleCount: 0, diagnosticErrors: [], energy: deriveEnergy([], 0, 0),
      };
      if (!capacity || (run.optional && capacity < tier)) {
        run.outcome = 'skipped'; run.skipped = count;
        run.reason = `Native token capacity: target ${tier} x ${input.actualTokens} tokens requires ${tier * input.actualTokens}; ` +
          `loaded token budget ${effectivePolicy.maxTokensPerBatch}, per-sequence context ${limits.nCtxSeq}, ` +
          `sequence limit ${effectivePolicy.maxSequencesPerBatch}, fitting capacity ${capacity}.`;
      }
      report.runs.push(run);
    }
    if (!report.runs[0].capacitySequences) fail('BATCH_CAPACITY');

    const gate = report.correctness;
    const gateStart = now();
    gate.outcome = 'running';
    publish('Correctness gate (excluded from warm timing and energy)');
    try {
      await monitored(signal, sampleDevice, async (active, checkpoint) => {
        const baseline = [];
        for (const text of GATE_DOCUMENTS) {
          checkCancelled(active);
          const item = await service.embedDocument(text, { signal: active, batchMode: 'sequential' });
          summarizeVector(item, 'document'); baseline.push(item);
          await checkpoint();
        }
        for (let i = 0; i < baseline.length; i++) {
          for (let j = 0; j < i; j++) {
            if (cosine(baseline[i].vector, baseline[j].vector) >= gate.tolerance) fail('BATCH_CORRECTNESS');
          }
        }
        const policy = clampBatchPolicy(limits, GATE_DOCUMENTS.length);
        const result = await service.embedDocumentsMeasured!(GATE_DOCUMENTS.slice(), { signal: active,
          batchMode: 'true_batch', batchingPolicy: policy });
        validateBatch(result, baseline.length, 'true_batch', policy, limits);
        gate.nativeDecodeCount = result.metrics.nativeDecodeCount;
        if (result.metrics.effectiveBatchSize < 2) fail('BATCH_CORRECTNESS');
        for (let i = 0; i < baseline.length; i++) {
          const item = result.embeddings[i];
          const similarity = cosine(baseline[i].vector, item.vector);
          gate.minimumCosine = Math.min(gate.minimumCosine ?? 1, similarity);
          if (!finite(similarity) || similarity < gate.tolerance || item.tokenCount !== baseline[i].tokenCount ||
              item.dimensions !== baseline[i].dimensions) fail('BATCH_CORRECTNESS');
          gate.completed++;
        }
      });
      gate.outcome = 'passed';
    } catch (error) {
      gate.error = labError(error);
      const status = outcome(gate.error);
      gate.outcome = status === 'error' ? 'failed' : status;
      throw error;
    } finally { gate.elapsedMs = now() - gateStart; }

    for (const run of report.runs) {
      if (run.outcome === 'skipped') continue;
      run.outcome = 'running';
      let start: number | undefined;
      let stride = 1;
      let retained: { index: number; device: DeviceDiagnostics }[] = [];
      let previousEnergy: DeviceDiagnostics['batteryEnergy'];
      let energyIssue: string | null = null;
      const counterIssues: { charge: string | null; energy: string | null } = { charge: null, energy: null };
      const chunks: { startMs: number; endMs: number; completed: number; totalTokens: number }[] = [];
      const updateRates = () => {
        run.elapsedMs = start === undefined ? 0 : Math.max(0, now() - start);
        run.documentsPerSecond = run.elapsedMs > 0 ? run.completed * 1000 / run.elapsedMs : null;
        run.tokensPerSecond = run.elapsedMs > 0 ? run.totalTokens * 1000 / run.elapsedMs : null;
        run.effectiveMsPerDocument = run.completed ? run.elapsedMs / run.completed : null;
        run.meanSequencesPerDecode = run.nativeDecodeCount ? run.completed / run.nativeDecodeCount : null;
        run.meanTokensPerDecode = run.nativeDecodeCount ? run.totalTokens / run.nativeDecodeCount : null;
      };
      const sample = async () => {
        let device: DeviceDiagnostics | null = null;
        try { device = await sampleDevice(); }
        catch { /* Diagnostics errors are deliberately sanitized below. */ }
        run.latestDevice = device;
        // Compaction must not hide a missing/charging/reset sample or an implausible short interval.
        // Final counter resolution/normalization remains the energy module's responsibility.
        const reading = device?.batteryEnergy;
        if (!reading || reading.plugged !== false || reading.status !== 3 ||
            !Number.isSafeInteger(reading.elapsedRealtimeMs) || reading.elapsedRealtimeMs < 0 ||
            [reading.currentNowUa, reading.currentAverageUa].some(value => finite(value) && value > 0)) {
          energyIssue ??= 'The warm window includes missing or unreliable discharging diagnostics.';
        } else {
          for (const [kind, key, maximum, maxPerMs] of [
            ['charge', 'chargeCounterUah', 100_000_000, 10_000 * 1000 / 3_600_000],
            ['energy', 'energyCounterNwh', 1_000_000_000_000, 50_000 * 1_000_000 / 3_600_000],
          ] as const) {
            const value = reading[key];
            const previous = previousEnergy?.[key];
            const dt = previousEnergy ? reading.elapsedRealtimeMs - previousEnergy.elapsedRealtimeMs : null;
            if (!Number.isSafeInteger(value) || value! <= 0 || value! > maximum || value === 2_147_483_647 ||
                (dt !== null && (dt <= 0 || (finite(previous) && (value! > previous || previous - value! > maxPerMs * dt))))) {
              counterIssues[kind] ??= `${kind} counter was invalid, reset, or had an implausible interval in the uncompacted warm samples.`;
            }
          }
        }
        previousEnergy = reading;
        if (!device) run.diagnosticErrors = [...run.diagnosticErrors.slice(-19), labError({ code: 'SAFETY_UNAVAILABLE' })];
        else {
          const index = run.sampleCount++;
          if (index === 0) {
            run.memoryBefore = device;
            run.thermal.initial = device.thermalStatus;
            run.temperatureC.initial = device.batteryTemperatureC;
          }
          if (retained.length && retained.at(-1)!.index % stride !== 0) retained.pop();
          retained.push({ index, device });
          while (retained.length > SAMPLE_LIMIT) {
            stride *= 2;
            retained = retained.filter(item => item.index % stride === 0 || item.index === index);
          }
          run.samples = retained.map(item => item.device);
          for (const key of ['appPssBytes', 'nativeHeapBytes', 'javaHeapBytes', 'batteryTemperatureC', 'thermalStatus'] as const) {
            if (finite(device[key])) run.peaks[key] = Math.max(run.peaks[key] ?? -Infinity, device[key]);
          }
          if (finite(device.availableRamBytes)) run.peaks.minimumAvailableRamBytes = Math.min(run.peaks.minimumAvailableRamBytes ?? Infinity, device.availableRamBytes);
          run.samplePeakPssBytes = run.peaks.appPssBytes;
          run.thermal.peak = run.peaks.thermalStatus; run.temperatureC.peak = run.peaks.batteryTemperatureC;
        }
        updateRates(); publish(`Batch target ${run.target}: safety checkpoint`);
        return device;
      };
      try {
        checkCancelled(signal);
        await monitored(signal, sample, async (active, checkpoint) => {
          start = now();
          let blockStart = 0;
          for (let offset = 0; offset < count; offset += run.chunkSize) {
            checkCancelled(active);
            const texts = corpus.slice(offset, offset + run.chunkSize);
            run.attempted += texts.length;
            const apiStart = now();
            let result: EmbeddingBatchResult;
            try {
              result = await service.embedDocumentsMeasured!(texts, { signal: active, batchMode: run.mode,
                batchingPolicy: run.effectivePolicy });
              validateBatch(result, texts.length, run.mode, run.effectivePolicy, limits, input.actualTokens);
            } catch (error) { run.unreportedItems += texts.length; throw error; }
            finally { run.apiWallMs += Math.max(0, now() - apiStart); }
            const m = result.metrics;
            run.completed += texts.length; run.totalTokens += m.totalTokens;
            run.effectiveBatchSize = Math.max(run.effectiveBatchSize, m.effectiveBatchSize);
            run.nativeDecodeCount += m.nativeDecodeCount;
            run.decodes.push(...m.decodes.map(d => ({ ...d })));
            run.nativeDecodeMs += m.nativeDecodeMs; run.nativeElapsedMs += m.totalElapsedMs;
            run.preparationMs += m.preparationMs;
            // Successful atomic responses remain counted even when cancellation races their delivery.
            try { await checkpoint(); }
            finally {
              const endMs = now() - start;
              chunks.push({ startMs: blockStart, endMs, completed: texts.length, totalTokens: m.totalTokens });
              blockStart = endMs;
              updateRates(); publish(`Batch target ${run.target}: measured ${run.completed}/${count}`);
            }
            await new Promise<void>(resolve => setTimeout(resolve, 0));
          }
        });
        run.outcome = 'success';
      } catch (error) {
        run.error = labError(error); run.outcome = outcome(run.error);
        run.cancelled = run.outcome === 'cancelled' ? count - run.completed : 0;
        run.failures = run.outcome === 'error' ? Math.max(1, run.unreportedItems) : 0;
        run.skipped = Math.max(0, count - run.completed - run.cancelled - run.failures);
        throw error;
      } finally {
        // Last sample is taken after the native request drains, including failed/cancelled requests.
        run.memoryAfter = await sample();
        run.thermal.final = run.memoryAfter?.thermalStatus ?? null;
        run.temperatureC.final = run.memoryAfter?.batteryTemperatureC ?? null;
        if (run.outcome === 'success') {
          try { checkBatchSafety(run.memoryAfter); checkCancelled(signal); }
          catch (error) { run.error = labError(error); run.outcome = outcome(run.error); }
        }
        updateRates();
        run.energy = deriveEnergy(run.samples, run.completed, run.totalTokens);
        if (energyIssue) run.energy = { ...deriveEnergy([], 0, 0), reason: energyIssue,
          chargeReason: energyIssue, energyReason: energyIssue };
        else if (counterIssues.charge || counterIssues.energy) {
          if (counterIssues.charge) run.energy = { ...run.energy, chargeConsumedMah: null, mahPer100Documents: null,
            chargeReason: counterIssues.charge };
          if (counterIssues.energy) run.energy = { ...run.energy, energyConsumedMwh: null, mwhPer100Documents: null,
            mwhPer1000Tokens: null, energyReason: counterIssues.energy };
          run.energy.reason = [run.energy.chargeReason, run.energy.energyReason].filter(Boolean).join(' ');
          if (run.energy.chargeConsumedMah === null && run.energy.energyConsumedMwh === null) {
            run.energy.confidence = 'unavailable'; run.energy.resolution = 'unknown';
          }
        }
        if (run.unreportedItems) run.energy = { ...run.energy, mahPer100Documents: null,
          mwhPer100Documents: null, mwhPer1000Tokens: null,
          reason: [run.energy.reason, 'Window includes unreported native work; efficiency normalization is unavailable.'].filter(Boolean).join(' ') };
        // Whole contiguous API chunks, never fabricated per-item latency or modulo-selected windows.
        if (chunks.length >= 3) {
          let from = 0;
          let accumulated = 0;
          for (const [phaseIndex, phase] of (['initial', 'middle', 'final'] as const).entries()) {
            let to = chunks.length;
            if (phaseIndex < 2) {
              to = from + 1;
              let sum = accumulated + chunks[from].completed;
              while (to < chunks.length - (2 - phaseIndex) &&
                  Math.abs(sum + chunks[to].completed - run.completed * (phaseIndex + 1) / 3) <
                  Math.abs(sum - run.completed * (phaseIndex + 1) / 3)) sum += chunks[to++].completed;
            }
            const group = chunks.slice(from, to);
            const completed = group.reduce((sum, c) => sum + c.completed, 0);
            const totalTokens = group.reduce((sum, c) => sum + c.totalTokens, 0);
            const startMs = group[0].startMs;
            const endMs = phaseIndex === 2 && !run.unreportedItems ? run.elapsedMs : group.at(-1)!.endMs;
            const elapsedMs = endMs - startMs;
            run.throughputBlocks.push({ phase, startMs, endMs, elapsedMs, completed, totalTokens,
              documentsPerSecond: elapsedMs > 0 ? completed * 1000 / elapsedMs : null,
              tokensPerSecond: elapsedMs > 0 ? totalTokens * 1000 / elapsedMs : null });
            accumulated += completed; from = to;
          }
          if (run.unreportedItems) run.throughputReason = 'Blocks exclude the failed atomic request tail with unreported work.';
        } else run.throughputReason = 'Fewer than three completed native API chunks; no comparable initial/middle/final blocks.';
        publish(`Batch target ${run.target}: ${run.outcome}`);
      }
      if (run.error) throw new EmbeddingError(run.error);
    }
    report.outcome = 'success';
  } catch (error) {
    report.error = labError(error); report.outcome = outcome(report.error);
    for (const run of report.runs) {
      if (run.outcome !== 'running' && run.outcome !== 'pending') continue;
      run.outcome = 'skipped'; run.skipped = run.requested;
      run.reason = `Not started: ${report.error.message}`;
    }
  }
  publish(report.outcome);
  return report;
}
