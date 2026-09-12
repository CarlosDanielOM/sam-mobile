import { labError, type BenchmarkReport, type LabState, type LoadMeasurement, type VectorSummary } from './lab';
import type { BatchComparison, BatchRunReport } from './batching';
import type { EnergyEfficiency } from './energy';
import type { DeviceDiagnostics, EmbeddingErrorInfo, EmbeddingModelInfo, InstallAttempt, InstallerMetrics, NativeBatchLimits } from './types';

export const REPORT_SCHEMA_VERSION = 2;
// SamDeviceDiagnostics enforces both a character and UTF-8 byte limit. Whitelisted output is ASCII.
const MAX_REPORT_BYTES = 1024 * 1024;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const bool = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
// Metadata only, never arbitrary text. URLs, absolute paths, query strings and control characters are rejected.
const label = (value: unknown): string | null => typeof value === 'string' && value.length <= 160 &&
  /^[a-zA-Z0-9][a-zA-Z0-9 _().+\-]*$/.test(value) && !/[^\x20-\x7e]/.test(value) ? value : null;
const identifier = (value: unknown): string | null => typeof value === 'string' && value.length <= 160 &&
  /^[a-zA-Z0-9][a-zA-Z0-9_.\-]*(\/[a-zA-Z0-9][a-zA-Z0-9_.\-]*)?$/.test(value) && !/[^\x20-\x7e]/.test(value) && !value.includes('..') ? value : null;
const choice = <T extends string>(value: unknown, allowed: readonly T[]): T | null =>
  allowed.includes(value as T) ? value as T : null;
const numbers = <T, const K extends readonly (keyof T)[]>(source: T, keys: K): Record<K[number], number | null> =>
  Object.fromEntries(keys.map(key => {
    const value = finite(source[key]);
    const unavailableStorage = /Bytes$|^bytes$/.test(String(key)) && key !== 'observedPssDeltaBytes' && value !== null && value < 0;
    return [key, unavailableStorage ? null : value];
  })) as Record<K[number], number | null>;

function errorReport(error?: EmbeddingErrorInfo | null) {
  if (!error) return null;
  const safe = labError(error);
  return {
    code: safe.code, message: safe.message,
    actualTokens: finite(error.actualTokens), maxTokens: finite(error.maxTokens),
  };
}

// Reasons are protocol text, not arbitrary adapter messages or even unrestricted metadata labels.
function reasonReport(value: unknown, error?: EmbeddingErrorInfo): string | null {
  if (value == null) return null;
  if (error && value === `Not started: ${labError(error).message}`) return `Not started: ${labError(error).message}`;
  const allowed = [
    'At least three reliable discharging samples are required.',
    'Battery energy diagnostics are unavailable for part or all of the window.',
    'Every sample must be unplugged and explicitly discharging (Android status 3).',
    'Positive current contradicts the discharging battery status.',
    'Battery elapsed time must be finite, nonnegative and strictly monotonic.',
    'The discharging window is too short; at least 60 seconds is required.',
    'Charge and energy counter deltas are inconsistent (implied voltage outside 2-20 V).',
    'Document normalization requires a positive integer completed count.',
    'Token normalization requires a positive integer token count.',
    'The warm window includes missing or unreliable discharging diagnostics.',
    'Window includes unreported native work; efficiency normalization is unavailable.',
    'Blocks exclude the failed atomic request tail with unreported work.',
    'Fewer than three completed native API chunks; no comparable initial/middle/final blocks.',
    ...['charge', 'energy'].flatMap(kind => [
      `${kind} counter is unsupported, missing or outside reliable ranges.`,
      `${kind} counter rose or reset during the window.`,
      `${kind} counter implies an implausible discharge rate or reset.`,
      `${kind} counter has no measurable decrease.`,
      `${kind} counter delta is too small or vendor quantization is uncertain; collect a longer window.`,
      `${kind} counter was invalid, reset, or had an implausible interval in the uncompacted warm samples.`,
    ]),
  ];
  if (typeof value === 'string' && value.length <= 2048 && value.length > 0 && !/[^\x20-\x7e]/.test(value) &&
      (allowed.includes(value) || value.split(/(?<=\.) /).every(part => allowed.includes(part)) ||
      /^Native token capacity: target \d{1,4} x \d{1,4} tokens requires \d{1,7}; loaded token budget \d{1,5}, per-sequence context \d{1,5}, sequence limit \d{1,4}, fitting capacity \d{1,4}\.$/.test(value))) return value;
  return 'Reason omitted (unrecognized diagnostic text).';
}

function limitsReport(limits?: NativeBatchLimits | null) {
  return limits ? {
    ...numbers(limits, ['nBatch', 'nUbatch', 'nCtx', 'nCtxSeq', 'maxParallelSequences', 'backendMaxParallelSequences']),
    backendSequenceExecution: choice(limits.backendSequenceExecution, ['serial_ubatches']),
  } : null;
}

function energyReport(energy: EnergyEfficiency) {
  return {
    ...numbers(energy, ['chargeConsumedMah', 'energyConsumedMwh', 'mahPer100Documents', 'mwhPer100Documents', 'mwhPer1000Tokens']),
    reason: reasonReport(energy.reason), chargeReason: reasonReport(energy.chargeReason), energyReason: reasonReport(energy.energyReason),
    confidence: choice(energy.confidence, ['unavailable', 'counter-estimate']),
    resolution: choice(energy.resolution, ['unknown', 'observed-step-screened']),
    scope: choice(energy.scope, ['device-wide-including-screen-and-system']),
  };
}

export function deviceReport(device?: DeviceDiagnostics | null) {
  if (!device) return null;
  return {
    ...numbers(device, ['timestamp', 'sdk', 'totalRamBytes', 'availableRamBytes', 'appPssBytes', 'rssBytes',
      'nativeHeapBytes', 'javaHeapBytes', 'batteryLevel', 'batteryTemperatureC', 'thermalStatus', 'thresholdBytes']),
    manufacturer: label(device.manufacturer), model: label(device.model), androidVersion: label(device.androidVersion),
    abi: label(device.abi), supportedAbis: device.supportedAbis.slice(0, 16).map(label),
    soc: device.soc ? { model: label(device.soc.model), manufacturer: label(device.soc.manufacturer) } : null,
    lowMemory: bool(device.lowMemory),
    batteryEnergy: device.batteryEnergy ? {
      ...numbers(device.batteryEnergy, ['chargeCounterUah', 'currentNowUa', 'currentAverageUa', 'energyCounterNwh', 'status', 'elapsedRealtimeMs']),
      plugged: bool(device.batteryEnergy.plugged),
    } : null,
  };
}

function modelReport(model: EmbeddingModelInfo | null) {
  return model ? {
    modelId: identifier(model.modelId), revision: label(model.revision), quantization: label(model.quantization),
    dimensions: finite(model.dimensions), maxTokens: finite(model.maxTokens), backendRevision: label(model.backendRevision),
    batchMode: choice(model.batchMode, ['sequential', 'parallel', 'true_batch']), batchLimits: limitsReport(model.batchLimits),
  } : null;
}

function attemptReport(attempt?: InstallAttempt) {
  return attempt ? {
    operation: choice(attempt.operation, ['recovery', 'download', 'verify', 'install', 'remove']),
    outcome: choice(attempt.outcome, ['running', 'success', 'error', 'cancelled', 'interrupted']),
    ...numbers(attempt, ['startedAt', 'completedAt', 'downloadDurationMs', 'verificationDurationMs', 'finalizationDurationMs',
      'totalElapsedMs', 'networkBytes', 'averageBytesPerSecond', 'timeToFirstByteMs', 'availableStorageBeforeBytes', 'availableStorageAfterBytes']),
    error: errorReport(attempt.error),
  } : null;
}

function metricsReport(metrics: InstallerMetrics) {
  return {
    ...numbers(metrics, ['downloadAttempts', 'verificationAttempts', 'installAttempts', 'removeAttempts', 'failures', 'cancelled', 'interrupted']),
    lastAttempt: attemptReport(metrics.lastAttempt), lastDownload: attemptReport(metrics.lastDownload),
    lastSuccessfulInstall: attemptReport(metrics.lastSuccessfulInstall), lastInterruptedAttempt: attemptReport(metrics.lastInterruptedAttempt),
    lastVerification: metrics.lastVerification ? {
      ...numbers(metrics.lastVerification, ['durationMs', 'bytes', 'timestamp']), valid: bool(metrics.lastVerification.valid),
      // The adapter's verification source may be a path. Deliberately omit it.
    } : null,
    lastError: metrics.lastError ? { ...errorReport(metrics.lastError), timestamp: finite(metrics.lastError.timestamp) } : null,
    lastPersistenceError: metrics.lastPersistenceError ? { ...errorReport(metrics.lastPersistenceError), timestamp: finite(metrics.lastPersistenceError.timestamp) } : null,
  };
}

function loadReport(load: LoadMeasurement) {
  return {
    ...numbers(load, ['timestamp', 'elapsedMs', 'loadDurationMs', 'observedPssDeltaBytes']),
    outcome: choice(load.outcome, ['success', 'error', 'cancelled']),
    before: deviceReport(load.before), after: deviceReport(load.after), error: errorReport(load.error),
  };
}

function vectorReport(result: VectorSummary | null) {
  return result ? {
    kind: choice(result.kind, ['query', 'document']),
    ...numbers(result, ['dimensions', 'norm', 'tokenCount', 'inferenceDurationMs', 'tokensPerMs']),
    warm: bool(result.warm), modelId: identifier(result.modelId), revision: label(result.revision), quantization: label(result.quantization),
  } : null;
}

function benchmarkReport(report: BenchmarkReport) {
  return {
    ...numbers(report, ['timestamp', 'requested', 'attempted', 'completed', 'failures', 'cancelled', 'skipped', 'unreportedItems',
      'actualTokens', 'targetTokens', 'tokenizerCalls', 'elapsedMs', 'inferenceOnlyMs', 'inferenceCallElapsedMs', 'diagnosticsMs',
      'preparationMs', 'nonInferenceMs', 'documentsPerSecond', 'inferenceDocumentsPerSecond', 'coldInferences', 'warmInferences',
      'totalTokens', 'tokensPerSecond', 'inferenceTokensPerSecond', 'chunkSize', 'samplePeakPssBytes']),
    mode: choice(report.mode, ['cold', 'warm']), size: choice(report.size, ['short', '128', '256', 'near512']),
    outcome: choice(report.outcome, ['running', 'success', 'error', 'cancelled', 'safety-stop']),
    batchImplementation: choice(report.batchImplementation, ['sequential']),
    firstInferenceWarm: bool(report.firstInferenceWarm), latencyMs: numbers(report.latencyMs, ['count', 'total', 'mean', 'median', 'p95']),
    memoryBefore: deviceReport(report.memoryBefore), memoryAfter: deviceReport(report.memoryAfter),
    latestDevice: deviceReport(report.latestDevice),
    samples: report.samples.slice(0, 128).map(deviceReport), diagnosticErrors: report.diagnosticErrors.slice(0, 128).map(errorReport),
    retention: { omittedSamples: Math.max(0, report.samples.length - 128), omittedDiagnosticErrors: Math.max(0, report.diagnosticErrors.length - 128) },
    load: report.load ? loadReport(report.load) : null, error: errorReport(report.error),
  };
}

function batchRunReport(run: BatchRunReport, comparisonError?: EmbeddingErrorInfo) {
  return {
    ...numbers(run, ['target', 'requested', 'attempted', 'completed', 'unreportedItems', 'failures', 'cancelled', 'skipped',
      'actualTokens', 'totalTokens', 'capacitySequences', 'chunkSize', 'requestedBatchSize', 'effectiveBatchSize',
      'meanSequencesPerDecode', 'meanTokensPerDecode', 'nativeDecodeCount', 'nativeDecodeMs', 'nativeElapsedMs',
      'preparationMs', 'apiWallMs', 'elapsedMs', 'documentsPerSecond', 'tokensPerSecond', 'effectiveMsPerDocument',
      'samplePeakPssBytes', 'sampleCount']),
    mode: choice(run.mode, ['sequential', 'true_batch']), optional: bool(run.optional),
    outcome: choice(run.outcome, ['pending', 'running', 'success', 'error', 'cancelled', 'safety-stop', 'skipped']),
    reason: reasonReport(run.reason, comparisonError), error: errorReport(run.error),
    requestedPolicy: numbers(run.requestedPolicy, ['maxSequencesPerBatch', 'maxTokensPerBatch']),
    effectivePolicy: numbers(run.effectivePolicy, ['maxSequencesPerBatch', 'maxTokensPerBatch']),
    limits: limitsReport(run.limits), backendSequenceExecution: choice(run.backendSequenceExecution, ['serial_ubatches']),
    decodes: run.decodes.slice(0, 1000).map(decode => numbers(decode, ['sequences', 'tokens', 'nativeDecodeMs'])),
    throughputBlocks: run.throughputBlocks.slice(0, 3).map(block => ({
      phase: choice(block.phase, ['initial', 'middle', 'final']),
      ...numbers(block, ['startMs', 'endMs', 'elapsedMs', 'completed', 'totalTokens', 'documentsPerSecond', 'tokensPerSecond']),
    })),
    throughputReason: reasonReport(run.throughputReason),
    memoryBefore: deviceReport(run.memoryBefore), memoryAfter: deviceReport(run.memoryAfter), latestDevice: deviceReport(run.latestDevice),
    peaks: numbers(run.peaks, ['appPssBytes', 'nativeHeapBytes', 'javaHeapBytes', 'minimumAvailableRamBytes', 'batteryTemperatureC', 'thermalStatus']),
    thermal: numbers(run.thermal, ['initial', 'peak', 'final']), temperatureC: numbers(run.temperatureC, ['initial', 'peak', 'final']),
    // The runner already compacts on an index grid. For oversized external data keep both endpoints.
    samples: run.samples.length <= 128 ? run.samples.map(deviceReport)
      : Array.from({ length: 128 }, (_, i) => deviceReport(run.samples[Math.floor(i * (run.samples.length - 1) / 127)])),
    diagnosticErrors: run.diagnosticErrors.slice(-128).map(errorReport), energy: energyReport(run.energy),
    retention: {
      omittedDecodes: Math.max(0, run.decodes.length - 1000),
      omittedSamples: Math.max(0, run.samples.length - 128),
      omittedDiagnosticErrors: Math.max(0, run.diagnosticErrors.length - 128),
      omittedThroughputBlocks: Math.max(0, run.throughputBlocks.length - 3),
    },
  };
}

function comparisonReport(comparison: BatchComparison) {
  const gate = comparison.correctness;
  return {
    ...numbers(comparison, ['timestamp', 'requested', 'requestedTarget', 'actualTokens', 'targetTokens', 'tokenizerCalls', 'sizingMs']),
    size: choice(comparison.size, ['short', '128', '256', 'near512']),
    outcome: choice(comparison.outcome, ['running', 'success', 'error', 'cancelled', 'safety-stop', 'skipped']),
    limits: limitsReport(comparison.limits), error: errorReport(comparison.error),
    correctness: {
      ...numbers(gate, ['documents', 'completed', 'tolerance', 'minimumCosine', 'elapsedMs', 'nativeDecodeCount']),
      outcome: choice(gate.outcome, ['pending', 'running', 'passed', 'failed', 'cancelled', 'safety-stop']),
      scope: choice(gate.scope, ['representative-multilingual-count-order-dimensions-finite-cosine']), error: errorReport(gate.error),
    },
    runs: comparison.runs.slice(0, 7).map(run => batchRunReport(run, comparison.error)), omittedRuns: Math.max(0, comparison.runs.length - 7),
  };
}

/** Construct every exported object afresh. Never JSON.stringify controller/adapter objects directly. */
export function buildReport(state: LabState, timestamp = new Date().toISOString()) {
  const installer = state.installer;
  const model = installer?.model;
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    timestamp: timestamp.length === 24 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) ? timestamp : null,
    notes: {
      memory: 'Observed process PSS delta, not exact model RAM. Sample peak is not an absolute peak.',
      batch: 'Legacy embedDocuments benchmarks are sequential with chunks up to 10. Measured batching reports actual loaded limits and decode telemetry; serial_ubatches is not true parallel compute. Rejected chunks may include unreported native work.',
      timing: 'Milliseconds; per-document inference latency, nearest-rank P95. Total includes load, tokenizer and diagnostics; no hidden warm-up.',
      tokens: 'Total tokens and token throughput include completed, validated results only, not tokenizer search or unreported native work.',
      cold: 'Cold means unloaded runtime followed by load and first inference; OS file caches are not cleared.',
      privacy: 'No input text, vectors, filesystem paths, URLs, credentials, device identifiers, or chat/session data.',
      retention: 'Up to 20 benchmarks and loads, 50 errors, 10 complete comparisons of up to 7 tiers, 1000 decodes per tier (1000 document limit), and 128 samples per run. Compact JSON fits 1 MiB by omitting oldest whole histories, never individual matrix tiers. Omission counts are explicit; runner sampleCount includes pre-compaction samples.',
      energy: 'Device-wide counters include screen and system, not app/model attribution. Raw charge uAh, current uA, energy nWh, monotonic time ms; estimates mAh/mWh. No battery-percentage derivation, current integration or assumed voltage. At least 60 seconds and ten counter decreases screen quantization, not establish meter accuracy.',
      latency: 'Batch effectiveMsPerDocument is amortized warm wall time, NOT single-query latency. Interactive latency uses actual warm query inference separately.',
      conclusion: 'No production winner or profile pending replicated, cooled, equivalent-work physical-device results on S24 Ultra, S24 and A56. A single sweep cannot establish an observed throughput leader.',
    },
    device: deviceReport(state.device), model: modelReport(model ?? state.model), runtimeModel: modelReport(state.model),
    installation: installer ? {
      state: choice(installer.state, ['not_installed', 'downloading', 'partial', 'verifying', 'installing', 'installed', 'invalid', 'error']),
      busy: bool(installer.busy),
      ...numbers(installer, ['downloadedBytes', 'expectedBytes', 'progressPercent', 'verifiedBytes', 'verificationProgressPercent',
        'elapsedMs', 'recentBytesPerSecond', 'averageBytesPerSecond', 'availableStorageBytes', 'installedBytes']),
      storageCategory: choice(state.storageCategory, ['app-private', 'app_private', 'internal', 'internal-app-storage', 'app-internal', 'private-internal']) ?? (state.storageCategory ? 'app-managed' : null),
      requiredStorage: state.storage ? numbers(state.storage, ['availableBytes', 'requiredBytes', 'headroomBytes']) : null,
      source: model ? { repository: identifier(model.repository), filename: label(model.filename), format: label(model.format),
        expectedBytes: finite(model.expectedBytes), sha256: typeof model.sha256 === 'string' && model.sha256.length === 64 && /^[a-fA-F0-9]{64}$/.test(model.sha256) ? model.sha256 : null } : null,
      metrics: metricsReport(installer.metrics), error: errorReport(installer.error),
    } : null,
    runtime: choice(state.runtime, ['unloaded', 'loading', 'ready', 'unloading', 'error']),
    loads: state.loads.slice(-20).map(loadReport), single: vectorReport(state.single), warmUp: vectorReport(state.warmUp),
    correctness: state.correctness ? {
      ...numbers(state.correctness, ['repeatCosine', 'maxAbsoluteDifference', 'tolerance']),
      stableWithinTolerance: bool(state.correctness.stableWithinTolerance),
      relatedRanksAboveUnrelated: bool(state.correctness.relatedRanksAboveUnrelated),
    } : null,
    similarity: state.similarity.slice(0, 3).map(row => ({ document: finite(row.document), cosine: finite(row.cosine), tokens: finite(row.tokens) })),
    crossLanguage: state.crossLanguage.slice(0, 3).map(row => ({ document: finite(row.document), cosine: finite(row.cosine), tokens: finite(row.tokens) })),
    benchmarks: state.benchmarks.slice(-20).map(benchmarkReport), cancellations: finite(state.cancellations),
    batchComparisons: state.batchComparisons.slice(-10).map(comparisonReport),
    retention: {
      maxBytes: MAX_REPORT_BYTES, omittedBenchmarks: Math.max(0, state.benchmarks.length - 20),
      omittedLoads: Math.max(0, state.loads.length - 20), omittedErrors: Math.max(0, state.errors.length - 50),
      omittedBatchComparisons: Math.max(0, state.batchComparisons.length - 10),
    },
    errors: state.errors.slice(-50).map(item => ({ timestamp: finite(item.timestamp),
      operation: choice(item.operation, ['status', 'device', 'download', 'verify', 'install', 'remove', 'load', 'unload',
        'single', 'warm-up', 'similarity', 'cross-language', 'correctness', 'benchmark', 'batch-comparison', 'batch-benchmark']), error: errorReport(item.error) })),
  };
  // Keep the latest complete comparison in preference to old legacy benchmarks. No partial matrix exports.
  while (JSON.stringify(report).length > MAX_REPORT_BYTES) {
    if (report.batchComparisons.length > 1) { report.batchComparisons.shift(); report.retention.omittedBatchComparisons++; }
    else if (report.benchmarks.length) { report.benchmarks.shift(); report.retention.omittedBenchmarks++; }
    else if (report.loads.length) { report.loads.shift(); report.retention.omittedLoads++; }
    else if (report.errors.length) { report.errors.shift(); report.retention.omittedErrors++; }
    else if (report.batchComparisons.length) { report.batchComparisons.shift(); report.retention.omittedBatchComparisons++; }
    else throw new Error('Whitelisted report exceeds the export size limit.');
  }
  return report;
}

export function serializeReport(state: LabState): string { return JSON.stringify(buildReport(state)); }

export function formatMeasurement(value: unknown, unit = '', digits = 2): string {
  const number = finite(value);
  return number === null ? 'unavailable' : `${number.toFixed(digits)}${unit ? ` ${unit}` : ''}`;
}
export function formatBytes(value: unknown, signed = false): string {
  const number = finite(value);
  return number === null || (!signed && number < 0) ? 'unavailable' : `${formatMeasurement(number / 1048576, 'MiB')} (${number.toFixed(0)} bytes)`;
}

/** Transfer speed uses decimal MB; memory and storage displays explicitly use binary MiB. */
export function formatTransferRate(bytesPerSecond: unknown): string {
  const value = finite(bytesPerSecond);
  return value === null || value < 0 ? 'unavailable' : formatMeasurement(value / 1_000_000, 'MB/s', 3);
}

export function formatSeconds(milliseconds: unknown): string {
  const value = finite(milliseconds);
  return value === null || value < 0 ? 'unavailable' : formatMeasurement(value / 1000, 's');
}

export function formatDeviceSample(device: DeviceDiagnostics | null): string {
  if (!device) return 'Latest device sample: unavailable.';
  return [
    `Latest device sample: ${formatMeasurement(device.timestamp, 'Unix ms', 0)}`,
    `Available RAM: ${formatBytes(device.availableRamBytes)}`,
    `App PSS: ${formatBytes(device.appPssBytes)}`,
    `Thermal status: ${formatMeasurement(device.thermalStatus, '', 0)}`,
    `Battery temperature: ${formatMeasurement(device.batteryTemperatureC, 'C')}`,
    `Low memory: ${bool(device.lowMemory) ?? 'unavailable'}`,
  ].join('\n');
}

/** Compact copy uses only whitelisted data; full samples and histories remain in JSON. */
export function humanReport(state: LabState): string {
  const report = buildReport(state);
  const text = (value: unknown) => value == null ? 'unavailable' : String(value);
  const count = (value: unknown) => formatMeasurement(value, '', 0);
  const ms = (value: unknown) => formatMeasurement(value, 'ms');
  const scaled = (value: unknown, divisor: number, unit: string, digits: number) => {
    const number = finite(value);
    return number === null ? 'unavailable' : formatMeasurement(number / divisor, unit, digits);
  };
  const seconds = (value: unknown) => scaled(value, 1000, 's', 3);
  const mb = (value: unknown) => scaled(value, 1_000_000, 'MB', 6);
  const memory = (value: unknown) => scaled(value, 1048576, 'MiB', 3);
  const peak = (values: unknown[]) => {
    const measured = values.map(finite).filter(value => value !== null);
    return measured.length ? Math.max(...measured) : null;
  };
  const device = report.device;
  const model = report.model;
  const installation = report.installation;
  const metrics = installation?.metrics;
  const download = metrics?.lastDownload;
  const attempt = metrics?.lastAttempt;
  const load = report.loads.at(-1);
  const lines = [
    'SAM Embeddings Benchmark',
    `Timestamp: ${text(report.timestamp)} | Schema: ${report.schemaVersion}`,
    '', 'Device',
    device ? `${text(device.manufacturer)} ${text(device.model)} | Android ${text(device.androidVersion)} / SDK ${count(device['sdk'])}` : 'unavailable',
    `ABI: ${text(device?.abi)} | SoC: ${text(device?.soc?.manufacturer)} / ${text(device?.soc?.model)}`,
    `RAM total/available: ${memory(device?.['totalRamBytes'])} / ${memory(device?.['availableRamBytes'])}; App PSS: ${memory(device?.['appPssBytes'])}; RSS: ${memory(device?.['rssBytes'])}`,
    '', 'Model',
    `${text(model?.modelId)} | revision: ${text(model?.revision)} | quantization: ${text(model?.quantization)}`,
    `Dimensions: ${count(model?.dimensions)}; max tokens: ${count(model?.maxTokens)}; source: ${text(installation?.source?.repository)}; format: ${text(installation?.source?.format)}`,
    '', 'Installation',
    `State: ${text(installation?.state)}; Official size: ${mb(installation?.source?.expectedBytes)}; installed: ${mb(installation?.['installedBytes'])}; category: ${text(installation?.storageCategory)}`,
    `Downloaded/verified: ${mb(installation?.['downloadedBytes'])} / ${mb(installation?.['verifiedBytes'])}; current elapsed: ${seconds(installation?.['elapsedMs'])}; recent: ${formatTransferRate(installation?.['recentBytesPerSecond'])}`,
    `Last download (${text(download?.outcome)}): ${seconds(download?.['downloadDurationMs'])}; average: ${formatTransferRate(download?.['averageBytesPerSecond'])}; TTFB: ${ms(download?.['timeToFirstByteMs'])}; network: ${mb(download?.['networkBytes'])}`,
    `Last operation (${text(attempt?.operation)}, ${text(attempt?.outcome)}): verify: ${seconds(attempt?.['verificationDurationMs'])}; finalize: ${seconds(attempt?.['finalizationDurationMs'])}; total: ${seconds(attempt?.['totalElapsedMs'])}`,
    `Storage before/after (last operation): ${mb(attempt?.['availableStorageBeforeBytes'])} / ${mb(attempt?.['availableStorageAfterBytes'])}`,
    `Storage available/required/headroom: ${mb(installation?.['availableStorageBytes'])} / ${mb(installation?.requiredStorage?.['requiredBytes'])} / ${mb(installation?.requiredStorage?.['headroomBytes'])}`,
    `Attempts download/verify/install/remove: ${(['downloadAttempts', 'verificationAttempts', 'installAttempts', 'removeAttempts'] as const).map(key => count(metrics?.[key])).join(' / ')}; failures/cancelled/interrupted: ${(['failures', 'cancelled', 'interrupted'] as const).map(key => count(metrics?.[key])).join(' / ')}`,
  ];
  if (metrics?.lastSuccessfulInstall) {
    const installed = metrics.lastSuccessfulInstall;
    lines.push(`Last successful install: verify: ${seconds(installed['verificationDurationMs'])}; finalize: ${seconds(installed['finalizationDurationMs'])}; total: ${seconds(installed['totalElapsedMs'])}`);
  }
  lines.push('', 'Runtime', `State: ${text(report.runtime)}; backend: ${text(report.runtimeModel?.backendRevision)}; batch: ${text(report.runtimeModel?.batchMode)}`);
  if (load) {
    lines.push(
      `Last load (${text(load.outcome)}): native: ${ms(load['loadDurationMs'])}; total with samples: ${ms(load['elapsedMs'])}`,
      `PSS before/after: ${memory(load.before?.['appPssBytes'])} / ${memory(load.after?.['appPssBytes'])}; observed delta: ${memory(load['observedPssDeltaBytes'])}`,
    );
  } else lines.push('Last load: unavailable');
  lines.push('', 'Inference');
  for (const [name, result] of [['Single', report.single], ['Explicit warm-up', report.warmUp]] as const) {
    lines.push(result
      ? `${name} (${text(result.kind)}): ${count(result['tokenCount'])} tokens; native: ${ms(result['inferenceDurationMs'])}; ${formatMeasurement(result['tokensPerMs'], 'tokens/ms')}; warm: ${text(result.warm)}; dimensions: ${count(result['dimensions'])}; norm: ${formatMeasurement(result['norm'], '', 6)}`
      : `${name}: unavailable`);
  }
  if (report.correctness) {
    const check = report.correctness;
    lines.push(`Correctness: repeat cosine ${formatMeasurement(check['repeatCosine'], '', 6)}; stable: ${text(check.stableWithinTolerance)}; related ranks above unrelated: ${text(check.relatedRanksAboveUnrelated)}`);
  }
  lines.push('', 'Benchmarks');
  if (!report.benchmarks.length) lines.push('No benchmarks recorded');
  for (const [index, run] of report.benchmarks.entries()) {
    lines.push(
      `#${index + 1} ${text(run.mode)} / ${text(run.size)} / ${count(run['requested'])} documents / ${text(run.outcome)}${run.error ? ` / ${run.error.code}` : ''}`,
      `Completed/attempted: ${count(run['completed'])}/${count(run['attempted'])}; failures/cancelled/skipped/unreported: ${(['failures', 'cancelled', 'skipped', 'unreportedItems'] as const).map(key => count(run[key])).join('/')}`,
      `Tokens/doc: ${count(run['actualTokens'])} (target ${count(run['targetTokens'])}); total: ${count(run['totalTokens'])} tokens; first warm: ${text(run.firstInferenceWarm)}; cold/warm inferences: ${count(run['coldInferences'])}/${count(run['warmInferences'])}`,
      `Latency avg/median/P95: ${ms(run.latencyMs['mean'])} / ${ms(run.latencyMs['median'])} / ${ms(run.latencyMs['p95'])}; native sum: ${ms(run['inferenceOnlyMs'])}; total: ${ms(run['elapsedMs'])}; inference API: ${ms(run['inferenceCallElapsedMs'])}`,
      `Throughput total: ${formatMeasurement(run['documentsPerSecond'], 'documents/s')}, ${formatMeasurement(run['tokensPerSecond'], 'tokens/s')}; inference: ${formatMeasurement(run['inferenceDocumentsPerSecond'], 'documents/s')}, ${formatMeasurement(run['inferenceTokensPerSecond'], 'tokens/s')}`,
      `Overhead diagnostics/tokenizer/non-inference: ${ms(run['diagnosticsMs'])} / ${ms(run['preparationMs'])} / ${ms(run['nonInferenceMs'])}; tokenizer calls: ${count(run['tokenizerCalls'])}; ${text(run.batchImplementation)} chunks: ${count(run['chunkSize'])}`,
      `PSS before/after/sample peak: ${memory(run.memoryBefore?.['appPssBytes'])} / ${memory(run.memoryAfter?.['appPssBytes'])} / ${memory(run['samplePeakPssBytes'])}; RAM available before/after: ${memory(run.memoryBefore?.['availableRamBytes'])} / ${memory(run.memoryAfter?.['availableRamBytes'])}; samples: ${run.samples.length}; sampling errors: ${run.diagnosticErrors.length}`,
      `Thermal status before/after/peak: ${count(run.memoryBefore?.['thermalStatus'])} / ${count(run.memoryAfter?.['thermalStatus'])} / ${count(peak(run.samples.map(sample => sample?.['thermalStatus'])))}; temperature before/after/peak: ${formatMeasurement(run.memoryBefore?.['batteryTemperatureC'], 'C')} / ${formatMeasurement(run.memoryAfter?.['batteryTemperatureC'], 'C')} / ${formatMeasurement(peak(run.samples.map(sample => sample?.['batteryTemperatureC'])), 'C')}`,
    );
  }
  lines.push('', 'Batch Comparisons', report.notes.batch);
  if (!report.batchComparisons.length) lines.push('No batching comparisons retained');
  for (const [index, comparison] of report.batchComparisons.entries()) {
    const limits = comparison.limits;
    lines.push(
      `Comparison ${index + 1}: ${text(comparison.size)} / ${count(comparison['actualTokens'])} tokens/doc / ${count(comparison['requested'])} documents / ${text(comparison.outcome)}; correctness: ${text(comparison.correctness.outcome)} (representative only)`,
      `Loaded nBatch/nUbatch/nCtx/nCtxSeq: ${(['nBatch', 'nUbatch', 'nCtx', 'nCtxSeq'] as const).map(key => count(limits?.[key])).join('/')}; sequence limit/backend ceiling: ${count(limits?.['maxParallelSequences'])}/${count(limits?.['backendMaxParallelSequences'])}; execution: ${text(limits?.backendSequenceExecution)}`,
      'Target / effective | outcome | completed/requested | wall ms | decode ms/count | documents/s | tokens/s | amortized ms/doc | mAh/100 docs | mWh/100 docs',
    );
    for (const run of comparison.runs) {
      lines.push(
        `${count(run['target'])} / ${count(run['effectiveBatchSize'])} | ${text(run.outcome)} | ${count(run['completed'])}/${count(run['requested'])} | ${ms(run['elapsedMs'])} | ${ms(run['nativeDecodeMs'])}/${count(run['nativeDecodeCount'])} | ${formatMeasurement(run['documentsPerSecond'])} | ${formatMeasurement(run['tokensPerSecond'])} | ${ms(run['effectiveMsPerDocument'])} | ${formatMeasurement(run.energy['mahPer100Documents'], '', 6)} | ${formatMeasurement(run.energy['mwhPer100Documents'], '', 6)}`,
        `  Initial/middle/final documents/s: ${['initial', 'middle', 'final'].map(phase => formatMeasurement(run.throughputBlocks.find(block => block.phase === phase)?.['documentsPerSecond'])).join('/')}; thermal: ${(['initial', 'peak', 'final'] as const).map(key => count(run.thermal[key])).join('/')}; temperature C: ${(['initial', 'peak', 'final'] as const).map(key => formatMeasurement(run.temperatureC[key])).join('/')}; sample peak PSS/native heap/Java heap, min RAM MiB: ${(['appPssBytes', 'nativeHeapBytes', 'javaHeapBytes', 'minimumAvailableRamBytes'] as const).map(key => memory(run.peaks[key])).join('/')}`,
      );
      if (run.reason || run.error || run.outcome !== 'success') lines.push(
        `  Failures/skipped/cancelled/unreported: ${(['failures', 'skipped', 'cancelled', 'unreportedItems'] as const).map(key => count(run[key])).join('/')}; ${run.reason ?? run.error?.message ?? 'No successful measurement.'}`,
      );
    }
    // Only compare within the runner's single shared-corpus sweep. Historical reports do not
    // snapshot corpus/model/config identities and therefore cannot supply independent evidence.
    const measured = comparison.runs.filter(run => run.outcome !== 'skipped');
    const keys = ['nBatch', 'nUbatch', 'nCtx', 'nCtxSeq', 'maxParallelSequences', 'backendMaxParallelSequences'] as const;
    const comparable = comparison.outcome === 'success' && comparison.correctness.outcome === 'passed' && !comparison.correctness.error &&
      comparison.correctness['completed'] === comparison.correctness['documents'] && comparison.correctness['documents']! > 0 &&
      comparison.correctness['minimumCosine'] !== null && comparison.correctness['tolerance'] !== null &&
      comparison.correctness['minimumCosine'] >= comparison.correctness['tolerance'] && !comparison.error &&
      !comparison.omittedRuns && measured.length >= 2 && limits?.backendSequenceExecution === 'serial_ubatches' &&
      keys.every(key => limits[key] !== null && limits[key]! > 0) && measured.every(run =>
        run.outcome === 'success' && !run.error && run['requested']! > 0 && run['requested'] === comparison['requested'] &&
        run['completed'] === run['requested'] && run['attempted'] === run['requested'] &&
        (['failures', 'cancelled', 'skipped', 'unreportedItems'] as const).every(key => run[key] === 0) &&
        run['actualTokens']! > 0 && run['actualTokens'] === comparison['actualTokens'] &&
        run['totalTokens'] === run['completed']! * run['actualTokens']! &&
        run['elapsedMs']! > 0 && run['documentsPerSecond']! > 0 && run['tokensPerSecond']! > 0 &&
        Math.abs(run['documentsPerSecond']! - run['completed']! * 1000 / run['elapsedMs']!) < 0.001 &&
        Math.abs(run['tokensPerSecond']! - run['documentsPerSecond']! * run['actualTokens']!) < 0.001 &&
        run.mode !== null && run.backendSequenceExecution === 'serial_ubatches' &&
        run.limits?.backendSequenceExecution === 'serial_ubatches' && keys.every(key => run.limits?.[key] === limits[key]) &&
        (['maxTokensPerBatch', 'maxSequencesPerBatch'] as const).every(key => run.requestedPolicy[key]! > 0 && run.effectivePolicy[key]! > 0) &&
        run.requestedPolicy['maxTokensPerBatch'] === measured[0].requestedPolicy['maxTokensPerBatch'] &&
        run.effectivePolicy['maxTokensPerBatch'] !== null && run.effectivePolicy['maxTokensPerBatch'] === measured[0].effectivePolicy['maxTokensPerBatch'] &&
        run['effectiveBatchSize']! > 0 && !run.retention.omittedDecodes);
    const ranked = comparable ? [...measured].sort((a, b) => b['documentsPerSecond']! - a['documentsPerSecond']!) : [];
    const fastest = ranked[0];
    const duplicatePolicy = fastest && measured.some(run => run !== fastest && run.mode === fastest.mode &&
      run['effectiveBatchSize'] === fastest['effectiveBatchSize'] && run['capacitySequences'] === fastest['capacitySequences'] &&
      run['chunkSize'] === fastest['chunkSize'] &&
      run.effectivePolicy['maxTokensPerBatch'] === fastest.effectivePolicy['maxTokensPerBatch']);
    lines.push(fastest && !duplicatePolicy && fastest['documentsPerSecond']! > ranked[1]['documentsPerSecond']! * 1.1
      ? `Fastest observed in this sweep: target ${count(fastest['target'])}, effective ${count(fastest['effectiveBatchSize'])}, ${formatMeasurement(fastest['documentsPerSecond'], 'documents/s')}; more than 10% above the next measurement. Descriptive only, not a replicated leader or production recommendation.`
      : 'Throughput conclusion: no distinguishable comparable fastest result (unavailable, incomplete, within 10% noise screen, or capped equivalent policy).');
    const reasons = [...new Set(comparison.runs.flatMap(run => [run.energy.reason, run.energy.chargeReason, run.energy.energyReason]).filter(value => value !== null))];
    lines.push(`Energy conclusion: ${comparison.runs.some(run => run.energy.confidence === 'counter-estimate') ? 'device-wide counter estimates only; no energy winner' : 'unavailable; no energy ranking'}.${reasons.length ? ` ${reasons.join(' ')}` : ''}`);
  }
  const warmQuery = report.single?.kind === 'query' && report.single.warm === true ? report.single
    : report.warmUp?.kind === 'query' && report.warmUp.warm === true ? report.warmUp : null;
  lines.push('', 'Conclusions',
    `Interactive warm single-query native latency: ${ms(warmQuery?.['inferenceDurationMs'])}. This is an individual measurement, not an end-to-end latency distribution.`,
    report.notes.latency, report.notes.energy, report.notes.conclusion,
    `Retention omissions (comparisons/benchmarks/loads/errors): ${report.retention.omittedBatchComparisons}/${report.retention.omittedBenchmarks}/${report.retention.omittedLoads}/${report.retention.omittedErrors}. JSON contains explicit per-run retention counts.`,
  );
  const errorCounts = new Map<string, number>();
  for (const entry of report.errors) if (entry.error) errorCounts.set(entry.error.code, (errorCounts.get(entry.error.code) ?? 0) + 1);
  const lastError = report.errors.at(-1);
  lines.push(
    '', 'Thermal',
    `Latest device status: ${count(device?.['thermalStatus'])}; battery: ${formatMeasurement(device?.['batteryLevel'], '%')}; temperature: ${formatMeasurement(device?.['batteryTemperatureC'], 'C')}; low memory: ${text(device?.lowMemory)}`,
    'PSS deltas are observed process changes, not exact model RAM. Sample peaks may miss transient peaks.',
    '', 'Errors',
    `Recorded lab errors: ${report.errors.length}; diagnostic cancellations: ${count(report.cancellations)}`,
    `Lab error codes: ${[...errorCounts].map(([code, total]) => `${code} x${total}`).join(', ') || 'none recorded'}`,
    `Latest lab error: ${lastError?.error ? `${text(lastError.operation)} / ${lastError.error.code}: ${lastError.error.message}` : 'none recorded'}`,
    `Installer error: ${installation?.error ? `${installation.error.code}: ${installation.error.message}` : 'none reported'}`,
    `Installer persistence error: ${metrics?.lastPersistenceError ? `${metrics.lastPersistenceError.code}: ${metrics.lastPersistenceError.message}` : 'none reported'}`,
    '', 'Timing: native inference latency; nearest-rank P95. Total includes load, tokenizer and diagnostics. No hidden warm-up; cold does not clear OS caches.',
    'Throughput counts completed validated results only; unreported native work is excluded. Full retained samples and histories are available in JSON.',
    report.notes.privacy,
  );
  return lines.join('\n');
}
