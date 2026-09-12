import { cosine, norm, statistics, type Statistics } from './math';
import { runBatchComparison, type BatchComparison } from './batching';
import {
  EmbeddingError, type DeviceDiagnostics, type EmbeddingErrorInfo, type EmbeddingKind,
  type EmbeddingModelInfo, type EmbeddingResult, type EmbeddingService, type EmbeddingsEnvironment,
  type InstallerStatus, type RequiredStorage, type RuntimeState,
} from './types';

export const CROSS_QUERY = '\u00bfC\u00f3mo puedo restablecer la contrase\u00f1a de mi cuenta?';
export const CROSS_DOCUMENTS = [
  'To reset your account password, choose Forgot password on the sign-in page and follow the email link.',
  'If the password reset email does not arrive, check your spam folder and confirm your account email address.',
  'Roast the vegetables in a hot oven with olive oil until golden brown.',
];

export interface VectorSummary {
  kind: EmbeddingKind;
  dimensions: number;
  norm: number;
  first12: number[];
  tokenCount: number;
  inferenceDurationMs: number | null;
  tokensPerMs: number | null;
  warm: boolean;
  modelId: string;
  revision: string;
  quantization: string;
}
export interface Ranking { document: number; cosine: number; tokens: number }
export interface CorrectnessResult {
  repeatCosine: number;
  maxAbsoluteDifference: number;
  stableWithinTolerance: boolean;
  tolerance: number;
  relatedRanksAboveUnrelated: boolean;
  ranking: Ranking[];
}
export interface LoadMeasurement {
  timestamp: number;
  outcome: 'success' | 'error' | 'cancelled';
  elapsedMs: number;
  loadDurationMs: number | null;
  before: DeviceDiagnostics | null;
  after: DeviceDiagnostics | null;
  observedPssDeltaBytes: number | null;
  error?: EmbeddingErrorInfo;
}
export type BenchmarkSize = 'short' | '128' | '256' | 'near512';
export interface BenchmarkOptions {
  mode: 'cold' | 'warm';
  size: BenchmarkSize;
  count: 1 | 10 | 100 | 1000;
  confirmed1000?: boolean;
}
export interface BenchmarkReport {
  timestamp: number;
  mode: 'cold' | 'warm';
  size: BenchmarkSize;
  requested: number;
  attempted: number;
  completed: number;
  failures: number;
  cancelled: number;
  skipped: number;
  /** Rejected batch APIs cannot expose successful work done before rejection. */
  unreportedItems: number;
  outcome: 'running' | 'success' | 'error' | 'cancelled' | 'safety-stop';
  actualTokens: number | null;
  targetTokens: number | null;
  tokenizerCalls: number;
  elapsedMs: number;
  inferenceOnlyMs: number;
  inferenceCallElapsedMs: number;
  diagnosticsMs: number;
  preparationMs: number;
  nonInferenceMs: number;
  latencyMs: Statistics;
  documentsPerSecond: number | null;
  inferenceDocumentsPerSecond: number | null;
  /** Tokens from completed, validated results only; excludes tokenizer search and unreported chunks. */
  totalTokens: number;
  tokensPerSecond: number | null;
  inferenceTokensPerSecond: number | null;
  firstInferenceWarm: boolean | null;
  coldInferences: number;
  warmInferences: number;
  batchImplementation: 'sequential';
  chunkSize: number;
  memoryBefore: DeviceDiagnostics | null;
  memoryAfter: DeviceDiagnostics | null;
  latestDevice: DeviceDiagnostics | null;
  samplePeakPssBytes: number | null;
  samples: DeviceDiagnostics[];
  diagnosticErrors: EmbeddingErrorInfo[];
  load: LoadMeasurement | null;
  error?: EmbeddingErrorInfo;
}
export interface LabState {
  busy: string | null;
  error: EmbeddingErrorInfo | null;
  errors: { timestamp: number; operation: string; error: EmbeddingErrorInfo }[];
  cancellations: number;
  installer: InstallerStatus | null;
  storage: RequiredStorage | null;
  storageCategory: string | null;
  runtime: RuntimeState;
  model: EmbeddingModelInfo | null;
  device: DeviceDiagnostics | null;
  loads: LoadMeasurement[];
  single: VectorSummary | null;
  warmUp: VectorSummary | null;
  similarity: Ranking[];
  crossLanguage: Ranking[];
  correctness: CorrectnessResult | null;
  benchmarks: BenchmarkReport[];
  batchComparisons: BatchComparison[];
  progress: { completed: number; requested: number; phase: string } | null;
}

export function initialLabState(): LabState {
  return {
    busy: null, error: null, errors: [], cancellations: 0, installer: null, storage: null,
    storageCategory: null, runtime: 'unloaded', model: null, device: null, loads: [],
    single: null, warmUp: null, similarity: [], crossLanguage: [], correctness: null,
    benchmarks: [], batchComparisons: [], progress: null,
  };
}

const ERROR_MESSAGES: Record<string, string> = {
  CANCELLED: 'Cancelled. Completed measurements remain available.',
  NOT_LOADED: 'Load the installed model first, then retry.',
  MODEL_NOT_LOADED: 'The model is not loaded. Load it in Runtime, then retry the embedding.',
  MODEL_NOT_INSTALLED: 'No verified model is installed. Download the official model, or verify and install a complete partial, then load it.',
  NO_MODEL: 'No model files were found. Download the official model before verifying or loading.',
  EMPTY_INPUT: 'Enter nonempty text in the query and document fields, then retry.',
  INPUT_TOO_LONG: 'The input exceeds the model token limit including formatting. Shorten the text, then retry.',
  INVALID_ARGUMENT: 'Check the input text, query/document mode, and document count, then retry.',
  INVALID_PATH: 'The installed model file is missing or inaccessible. Verify the installation; if that fails, remove it and download again.',
  UNSAFE_PATH: 'The installer rejected an unsafe file location. Remove the model through Installation and download the official artifact again.',
  INVALID_MODEL: 'The file does not match the required model format or configuration. Verify it, then remove and download the official model if verification fails.',
  MODEL_LOAD_FAILED: 'The runtime could not load the model. Free memory, verify the installed model, then retry loading.',
  NATIVE_INIT_FAILED: 'The native runtime could not initialize. Free memory and retry; if it persists, check this build supports the device ABI.',
  NATIVE_ERROR: 'Native execution failed. Unload the model, free memory, then reload and retry. Check native build compatibility if it persists.',
  BRIDGE_ERROR: 'The native bridge returned an invalid response. Restart the app and check that the native library matches this build.',
  INFERENCE_FAILED: 'The model did not produce a valid embedding. Unload, verify the installation, then reload and retry.',
  TOKENIZATION_FAILED: 'The model tokenizer failed. Retry with shorter text; if it persists, verify and reload the model.',
  OUT_OF_MEMORY: 'Native memory allocation failed. Stop testing, unload the model, and free memory before trying a smaller workload.',
  HASH_MISMATCH: 'The model checksum does not match the official artifact. Remove the invalid model or partial and download it again.',
  SIZE_MISMATCH: 'The model file has the wrong size. Download it again; do not install an incomplete partial.',
  FILE_CHANGED: 'The model file changed during verification. Wait for installation work to finish, then verify again.',
  INSUFFICIENT_STORAGE: 'Not enough free storage for the model and required headroom. Free storage, then retry the download or installation.',
  STORAGE_UNAVAILABLE: 'Available storage could not be measured. Wait for storage to become available, then retry.',
  STORAGE_IO: 'Reading or writing model storage failed. Check free storage, then retry verification or download.',
  DELETE_FAILED: 'Model cleanup failed. Wait for native work to finish and retry Remove model; restart the app if cleanup still fails.',
  METADATA_IO: 'Installer metrics could not be saved. Check free storage and retry verification; previous persisted measurements may be incomplete.',
  METADATA_RECOVERED: 'Installer metadata needed recovery. Verify the model before loading; previous installation measurements may be incomplete.',
  NETWORK_IO: 'The model transfer failed. Check the network connection and retry Download; an incomplete partial is not ready to install.',
  HTTP_ERROR: 'The model host rejected the download request. Check connectivity and retry later; do not change the official model source.',
  HTTP_ENCODING: 'The host returned an unsupported download encoding. Retry later using the official download action.',
  HTTP_SIZE: 'The host response size does not match the official artifact. Retry the official download; do not install this response.',
  DOWNLOAD_INCOMPLETE: 'The model download ended before completion. Check connectivity and retry Download.',
  UNSAFE_REDIRECT: 'The download redirected to an untrusted location. Do not bypass the check; retry later or check for an updated app build.',
  TOO_MANY_REDIRECTS: 'The host redirected the download too many times. Retry later or check for an updated app build.',
  DOWNLOAD_FAILED: 'The model download failed. Check connectivity and free storage, then retry Download.',
  VERIFICATION_FAILED: 'Model verification failed. Retry verification; if it still fails, remove the model and download it again.',
  INSTALL_FAILED: 'The model was not verified and installed. Verify the partial; if incomplete or invalid, retry Download.',
  INTERRUPTED: 'The previous operation was interrupted. Wait for installer recovery, then explicitly retry the relevant action.',
  BUSY: 'Native work is still running. Wait for it to finish, or cancel the active download or diagnostic before retrying.',
  QUEUE_FULL: 'The native work queue is full. Wait for queued work to finish before retrying.',
  UNSUPPORTED_PLATFORM: 'This build requires supported ARM64 Android native libraries. Use a supported device and build.',
  COLD_REQUIRES_UNLOADED: 'Unload the model before a cold benchmark.',
  CONFIRM_REQUIRED: 'The 1000-document test requires explicit confirmation.',
  LOW_MEMORY: 'Stopped safely: Android reports low memory. Free memory before retrying.',
  THERMAL_LIMIT: 'Stopped safely: severe thermal status. Let the device cool before retrying.',
  INVALID_VECTOR: 'The runtime returned an invalid vector or measurement.',
  TOKEN_SIZING: 'The tokenizer could not produce the requested bounded input.',
  INVALID_BENCHMARK: 'Choose a supported benchmark size and count; cold tests use one document.',
  BATCH_UNAVAILABLE: 'This build does not expose measured native batches. Update the native adapter before comparing batches.',
  BATCH_LIMITS_UNAVAILABLE: 'Loaded native batch limits are unavailable or invalid. Reload a compatible native runtime before testing.',
  BATCH_CAPACITY: 'Native token capacity cannot fit even one document of this size. Choose a smaller input size.',
  INVALID_BATCH_METRICS: 'The native batch returned inconsistent decode measurements. Stop testing and check the native runtime.',
  BATCH_CORRECTNESS: 'The representative sequential/batched correctness gate failed or could not verify distinct ordered outputs. No warm comparison was run.',
  SAFETY_UNAVAILABLE: 'Stopped safely: current RAM, temperature, or thermal diagnostics are unavailable. Batching escalation is not authorized.',
  UNAVAILABLE: 'Embeddings are unavailable on this platform or build.',
  OPERATION_FAILED: 'Operation failed. Check installation and runtime state, then retry.',
};

/** Never surface adapter messages that may include private paths or input text. */
export function labError(error: unknown): EmbeddingErrorInfo {
  const candidate = error as Partial<EmbeddingErrorInfo> | null;
  const code = typeof candidate?.code === 'string' && Object.hasOwn(ERROR_MESSAGES, candidate.code)
    ? candidate.code : 'OPERATION_FAILED';
  return {
    code,
    message: ERROR_MESSAGES[code] ?? ERROR_MESSAGES['OPERATION_FAILED'],
    actualTokens: Number.isFinite(candidate?.actualTokens) ? candidate!.actualTokens : undefined,
    maxTokens: Number.isFinite(candidate?.maxTokens) ? candidate!.maxTokens : undefined,
  };
}

function fail(code: string): never { throw new EmbeddingError({ code, message: ERROR_MESSAGES[code] }); }
function checkCancelled(signal: AbortSignal): void { if (signal.aborted) fail('CANCELLED'); }

export function summarizeVector(result: EmbeddingResult, kind: EmbeddingKind): VectorSummary {
  if (result.dimensions !== 1024 || result.vector.length !== 1024 ||
      result.vector.some(value => !Number.isFinite(value)) ||
      !Number.isInteger(result.tokenCount) || result.tokenCount < 1 ||
      (result.inferenceDurationMs !== null && (!Number.isFinite(result.inferenceDurationMs) || result.inferenceDurationMs < 0))) fail('INVALID_VECTOR');
  const length = norm(result.vector);
  if (!Number.isFinite(length) || !length) fail('INVALID_VECTOR');
  return {
    kind, dimensions: result.dimensions, norm: length, first12: result.vector.slice(0, 12),
    tokenCount: result.tokenCount, inferenceDurationMs: result.inferenceDurationMs,
    tokensPerMs: result.inferenceDurationMs !== null && result.inferenceDurationMs > 0 ? result.tokenCount / result.inferenceDurationMs : null,
    warm: result.warm, modelId: result.modelId, revision: result.revision, quantization: result.quantization,
  };
}

/** Counts real, untruncated model tokens. No character-to-token estimates or inference warm-up. */
export async function sizeBenchmarkInput(
  engine: EmbeddingService, size: BenchmarkSize, signal: AbortSignal,
  onTokenCount: (calls: number) => void = () => {},
): Promise<{ text: string; actualTokens: number; targetTokens: number; tokenizerCalls: number }> {
  const maximum = Math.min(512, engine.getModelInfo().maxTokens);
  const targetTokens = size === 'short' ? Math.min(24, maximum)
    : size === 'near512' ? maximum : Number(size);
  if (!Number.isInteger(targetTokens) || targetTokens < 1 || targetTokens > maximum) fail('TOKEN_SIZING');
  let tokenizerCalls = 0;
  const words = ['science', 'river', 'garden', 'planet', 'history', 'music', 'forest', 'energy'];
  const textAt = (count: number) => Array.from({ length: count }, (_, i) => words[i % words.length]).join(' ');
  const countAt = async (count: number) => {
    checkCancelled(signal);
    tokenizerCalls++;
    onTokenCount(tokenizerCalls);
    const tokens = await engine.countTokens(textAt(count), 'document', { signal });
    if (!Number.isInteger(tokens) || tokens < 1) fail('TOKEN_SIZING');
    checkCancelled(signal);
    return tokens;
  };
  let low = 1;
  let lowTokens = await countAt(low);
  if (lowTokens > targetTokens) fail('TOKEN_SIZING');
  let high = 2;
  while (high <= 4096 && await countAt(high) <= targetTokens) {
    low = high;
    high *= 2;
  }
  if (high > 4096) fail('TOKEN_SIZING');
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (await countAt(mid) <= targetTokens) low = mid;
    else high = mid;
  }
  lowTokens = await countAt(low);
  if (lowTokens > maximum || targetTokens - lowTokens > Math.max(8, targetTokens * 0.1)) fail('TOKEN_SIZING');
  return { text: textAt(low), actualTokens: lowTokens, targetTokens, tokenizerCalls };
}

/** Process-lifetime owner; never holds a page, Activity, chat, or session. */
export class EmbeddingsLabController {
  state = initialLabState();
  private abort: AbortController | null = null;
  private sampling: Promise<DeviceDiagnostics | null> | null = null;
  private readonly environment: EmbeddingsEnvironment;
  private readonly changed: (state: LabState) => void;
  private readonly now: () => number;

  constructor(environment: EmbeddingsEnvironment, changed: (state: LabState) => void = () => {},
    now: () => number = () => globalThis.performance?.now() ?? Date.now()) {
    this.environment = environment;
    this.changed = changed;
    this.now = now;
    this.refresh();
  }

  private update(patch: Partial<LabState>): void {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }

  refresh(): void {
    try {
      const installer = this.environment.installer;
      this.update({
        installer: installer.getStatus(), storage: installer.getRequiredStorage(),
        storageCategory: installer.getInstalledModel()?.storageCategory ?? null,
        runtime: this.environment.service.getState(), model: this.environment.service.getModelInfo(),
      });
    } catch (error) { this.recordError('status', error); }
  }

  private recordError(operation: string, error: unknown): EmbeddingErrorInfo {
    const info = labError(error);
    this.update({ error: info, errors: [...this.state.errors.slice(-49), { timestamp: Date.now(), operation, error: info }] });
    return info;
  }

  async sampleDevice(): Promise<DeviceDiagnostics | null> {
    if (this.sampling) return this.sampling;
    this.sampling = (async () => {
      try {
        const device = await this.environment.sampleDevice();
        this.update({ device });
        return device;
      } catch (error) { this.recordError('device', error); return null; }
    })();
    try { return await this.sampling; } finally { this.sampling = null; }
  }

  cancel(): void {
    this.abort?.abort();
    this.update({ progress: this.state.progress ? { ...this.state.progress, phase: 'Cancelling after native work drains' } : null });
  }

  cancelDownload(): void {
    try { this.environment.installer.cancelDownload(); this.refresh(); }
    catch (error) { this.recordError('download', error); }
  }

  private async run(operation: string, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.state.busy) return;
    try { if (this.environment.installer.getStatus().busy) return; }
    catch (error) { this.recordError(operation, error); return; }
    this.abort = new AbortController();
    this.update({ busy: operation, error: null });
    try { await work(this.abort.signal); }
    catch (error) {
      const info = this.recordError(operation, error);
      if (this.abort.signal.aborted || info.code === 'CANCELLED') this.update({ cancellations: this.state.cancellations + 1 });
    } finally {
      this.abort = null;
      this.update({ busy: null, progress: null });
      this.refresh();
    }
  }

  installAction(action: 'download' | 'verify' | 'install' | 'remove'): Promise<void> {
    return this.run(action, async signal => {
      if (action === 'download') await this.environment.installer.download({ signal });
      else await this.environment.installer[action]();
    });
  }

  private async measuredLoad(signal: AbortSignal, sample = () => this.sampleDevice()): Promise<LoadMeasurement> {
    const start = this.now();
    const measurement: LoadMeasurement = {
      timestamp: Date.now(), outcome: 'success', elapsedMs: 0, loadDurationMs: null,
      before: await sample(), after: null, observedPssDeltaBytes: null,
    };
    try {
      this.checkSafety(measurement.before);
      checkCancelled(signal);
      const result = await this.environment.service.load({ signal });
      measurement.loadDurationMs = result.loadDurationMs;
      checkCancelled(signal);
    } catch (error) {
      measurement.error = labError(error);
      measurement.outcome = signal.aborted || measurement.error.code === 'CANCELLED' ? 'cancelled' : 'error';
      throw error;
    } finally {
      measurement.after = await sample();
      measurement.elapsedMs = this.now() - start;
      if (measurement.before?.appPssBytes != null && measurement.after?.appPssBytes != null) {
        measurement.observedPssDeltaBytes = measurement.after.appPssBytes - measurement.before.appPssBytes;
      }
      this.update({ loads: [...this.state.loads.slice(-19), measurement] });
    }
    return measurement;
  }

  load(): Promise<void> {
    return this.run('load', async signal => {
      if (!this.environment.service.isLoaded()) await this.measuredLoad(signal);
    });
  }
  unload(): Promise<void> { return this.run('unload', async () => this.environment.service.unload()); }
  private requireLoaded(): void { if (!this.environment.service.isLoaded()) fail('NOT_LOADED'); }
  private checkSafety(device: DeviceDiagnostics | null): void {
    if (device?.lowMemory) fail('LOW_MEMORY');
    if (device?.thermalStatus != null && device.thermalStatus >= 3) fail('THERMAL_LIMIT');
  }

  single(text: string, kind: EmbeddingKind, warmUp = false): Promise<void> {
    return this.run(warmUp ? 'warm-up' : 'single', async signal => {
      this.requireLoaded();
      this.checkSafety(await this.sampleDevice());
      checkCancelled(signal);
      const result = kind === 'query' ? await this.environment.service.embedQuery(text, { signal })
        : await this.environment.service.embedDocument(text, { signal });
      const summary = summarizeVector(result, kind);
      this.update(warmUp ? { warmUp: summary } : { single: summary });
      checkCancelled(signal);
    });
  }

  similarity(query: string, documents: string[], crossLanguage = false): Promise<void> {
    return this.run(crossLanguage ? 'cross-language' : 'similarity', async signal => {
      this.requireLoaded();
      this.checkSafety(await this.sampleDevice());
      const ranking = await this.rank(query, documents, signal);
      this.update(crossLanguage ? { crossLanguage: ranking } : { similarity: ranking });
    });
  }

  private async rank(query: string, documents: string[], signal: AbortSignal): Promise<Ranking[]> {
    checkCancelled(signal);
    const q = await this.environment.service.embedQuery(query, { signal });
    summarizeVector(q, 'query');
    checkCancelled(signal);
    const results = await this.environment.service.embedDocuments(documents, { signal });
    if (results.length !== documents.length) fail('INVALID_VECTOR');
    checkCancelled(signal);
    return results.map((result, document) => {
      summarizeVector(result, 'document');
      return { document, cosine: cosine(q.vector, result.vector), tokens: result.tokenCount };
    }).sort((a, b) => b.cosine - a.cosine);
  }

  correctness(): Promise<void> {
    return this.run('correctness', async signal => {
      this.requireLoaded();
      this.checkSafety(await this.sampleDevice());
      const text = 'How can I reset my account password?';
      const first = await this.environment.service.embedQuery(text, { signal });
      checkCancelled(signal);
      const second = await this.environment.service.embedQuery(text, { signal });
      summarizeVector(first, 'query');
      summarizeVector(second, 'query');
      const tolerance = 1e-4;
      const maxAbsoluteDifference = Math.max(...first.vector.map((value, i) => Math.abs(value - second.vector[i])));
      const ranking = await this.rank(text, CROSS_DOCUMENTS, signal);
      this.update({ correctness: {
        repeatCosine: cosine(first.vector, second.vector), maxAbsoluteDifference, tolerance,
        stableWithinTolerance: maxAbsoluteDifference <= tolerance,
        relatedRanksAboveUnrelated: ranking.find(row => row.document === 0)!.cosine > ranking.find(row => row.document === 2)!.cosine,
        ranking,
      } });
    });
  }

  /** UI API: ascending full matrix, shared corpus; snapshots in state.batchComparisons. */
  batchComparison(size: BenchmarkSize, count = 100): Promise<void> {
    return this.runBatching(size, count);
  }

  /** UI API: ascending prefix through target, never an unchecked jump to a larger tier. */
  batchBenchmark(size: BenchmarkSize, target: number, count = 100): Promise<void> {
    return this.runBatching(size, count, target);
  }

  private runBatching(size: BenchmarkSize, count: number, target?: number): Promise<void> {
    return this.run(target === undefined ? 'batch-comparison' : 'batch-benchmark', async signal => {
      const timestamp = Math.max(Date.now(), (this.state.batchComparisons.at(-1)?.timestamp ?? 0) + 1);
      const report = await runBatchComparison({ service: this.environment.service,
        sampleDevice: () => this.sampleDevice(), signal, size, count, target, now: this.now, timestamp,
        publish: (comparison, phase) => {
          const others = this.state.batchComparisons.filter(item => item.timestamp !== timestamp);
          const active = comparison.runs.find(item => item.outcome === 'running') ?? comparison.runs.at(-1);
          this.update({ batchComparisons: [...others.slice(-9), comparison],
            progress: { completed: active?.completed ?? 0, requested: count, phase } });
        },
      });
      if (report.error) throw new EmbeddingError(report.error);
    });
  }

  benchmark(options: BenchmarkOptions): Promise<void> {
    return this.run('benchmark', async signal => {
      const start = this.now();
      const report: BenchmarkReport = {
        timestamp: Math.max(Date.now(), (this.state.benchmarks.at(-1)?.timestamp ?? 0) + 1),
        mode: options.mode, size: options.size, requested: options.count,
        attempted: 0, completed: 0, failures: 0, cancelled: 0, skipped: 0, unreportedItems: 0,
        outcome: 'running', actualTokens: null, targetTokens: null, tokenizerCalls: 0,
        elapsedMs: 0, inferenceOnlyMs: 0, inferenceCallElapsedMs: 0, diagnosticsMs: 0,
        preparationMs: 0, nonInferenceMs: 0, latencyMs: statistics([]), documentsPerSecond: null,
        inferenceDocumentsPerSecond: null, firstInferenceWarm: null, coldInferences: 0, warmInferences: 0,
        totalTokens: 0, tokensPerSecond: null, inferenceTokensPerSecond: null,
        batchImplementation: 'sequential', chunkSize: Math.min(options.count, 10),
        memoryBefore: null, memoryAfter: null, latestDevice: null, samplePeakPssBytes: null, samples: [],
        diagnosticErrors: [], load: null,
      };
      const latencies: number[] = [];
      const publish = (phase: string) => {
        report.elapsedMs = this.now() - start;
        report.latencyMs = statistics(latencies);
        report.inferenceOnlyMs = report.latencyMs.total;
        report.nonInferenceMs = Math.max(0, report.elapsedMs - report.inferenceOnlyMs);
        report.documentsPerSecond = report.elapsedMs > 0 ? report.completed * 1000 / report.elapsedMs : null;
        report.inferenceDocumentsPerSecond = report.inferenceOnlyMs > 0 ? report.completed * 1000 / report.inferenceOnlyMs : null;
        report.tokensPerSecond = report.elapsedMs > 0 ? report.totalTokens * 1000 / report.elapsedMs : null;
        report.inferenceTokensPerSecond = report.inferenceOnlyMs > 0 ? report.totalTokens * 1000 / report.inferenceOnlyMs : null;
        const others = this.state.benchmarks.filter(item => item.timestamp !== report.timestamp);
        this.update({ benchmarks: [...others.slice(-19), { ...report, samples: [...report.samples], diagnosticErrors: [...report.diagnosticErrors] }],
          progress: { completed: report.completed, requested: report.requested, phase } });
      };
      const sample = async () => {
        const t = this.now();
        const device = await this.sampleDevice();
        report.diagnosticsMs += this.now() - t;
        report.latestDevice = device;
        if (device) {
          report.samples.push(device);
          if (device.appPssBytes != null) report.samplePeakPssBytes = Math.max(report.samplePeakPssBytes ?? 0, device.appPssBytes);
        } else if (this.state.error) report.diagnosticErrors.push(this.state.error);
        return device;
      };
      publish('Preparing (no hidden warm-up)');
      try {
        if (![1, 10, 100, 1000].includes(options.count) || !['short', '128', '256', 'near512'].includes(options.size)
          || !['cold', 'warm'].includes(options.mode) || (options.mode === 'cold' && options.count !== 1)) fail('INVALID_BENCHMARK');
        if (options.count === 1000 && options.confirmed1000 !== true) fail('CONFIRM_REQUIRED');
        if (options.mode === 'warm') this.requireLoaded();
        else if (this.environment.service.isLoaded()) fail('COLD_REQUIRES_UNLOADED');
        report.memoryBefore = await sample();
        this.checkSafety(report.memoryBefore);
        checkCancelled(signal);
        if (options.mode === 'cold') {
          publish('Cold model load');
          const previousLoads = this.state.loads.length;
          try { report.load = await this.measuredLoad(signal, sample); }
          finally { if (!report.load && this.state.loads.length >= previousLoads) report.load = this.state.loads.at(-1) ?? null; }
          this.checkSafety(report.load?.after ?? null);
        }
        publish('Sizing with the actual tokenizer');
        const prep = this.now();
        let input: Awaited<ReturnType<typeof sizeBenchmarkInput>>;
        try { input = await sizeBenchmarkInput(this.environment.service, options.size, signal, calls => { report.tokenizerCalls = calls; }); }
        finally { report.preparationMs = this.now() - prep; }
        report.actualTokens = input.actualTokens;
        report.targetTokens = input.targetTokens;
        report.tokenizerCalls = input.tokenizerCalls;
        for (let offset = 0; offset < options.count; offset += report.chunkSize) {
          checkCancelled(signal);
          this.checkSafety(report.samples.at(-1) ?? null);
          const count = Math.min(report.chunkSize, options.count - offset);
          publish('Measuring sequential document chunks');
          for (let item = 0; item < count; item++) {
            checkCancelled(signal);
            report.attempted++;
            const inferenceStart = this.now();
            let result: EmbeddingResult;
            try {
              // Multi-item sequential APIs now have null timings. Keep real single-decode latencies.
              result = await this.environment.service.embedDocument(input.text, { signal, batchMode: 'sequential' });
              summarizeVector(result, 'document');
              if (result.inferenceDurationMs === null) fail('INVALID_VECTOR');
              if (result.tokenCount !== input.actualTokens) fail('TOKEN_SIZING');
            } catch (error) { report.unreportedItems++; throw error; }
            finally { report.inferenceCallElapsedMs += this.now() - inferenceStart; }
            latencies.push(result.inferenceDurationMs);
            report.completed++;
            report.totalTokens += result.tokenCount;
            if (report.firstInferenceWarm === null) report.firstInferenceWarm = result.warm;
            if (result.warm) report.warmInferences++; else report.coldInferences++;
          }
          report.memoryAfter = await sample();
          publish('Measuring sequential document chunks');
          this.checkSafety(report.memoryAfter);
          checkCancelled(signal);
          // Yield between chunks so cancel/progress handlers can run even with synchronous fakes.
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
        report.outcome = 'success';
      } catch (error) {
        report.error = labError(error);
        const cancelled = signal.aborted || report.error.code === 'CANCELLED';
        const safety = ['LOW_MEMORY', 'THERMAL_LIMIT'].includes(report.error.code);
        report.outcome = cancelled ? 'cancelled' : safety ? 'safety-stop' : 'error';
        report.cancelled = cancelled ? report.requested - report.completed : 0;
        report.failures = cancelled || safety ? 0 : Math.max(1, report.attempted - report.completed);
        report.skipped = Math.max(0, report.requested - report.completed - report.cancelled - report.failures);
        throw error;
      } finally {
        report.memoryAfter = await sample();
        publish(report.outcome);
      }
    });
  }
}
