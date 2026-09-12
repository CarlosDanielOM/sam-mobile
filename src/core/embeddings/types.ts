/** Platform-neutral contract. Encoding, tokenizer, files and backend belong to adapters. */
export interface EmbeddingModelInfo {
  modelId: string;
  revision: string;
  quantization: string;
  dimensions: number;
  maxTokens: number;
  backendRevision?: string;
  batchMode?: 'sequential' | 'parallel' | 'true_batch';
  batchLimits?: NativeBatchLimits;
}

export type BatchMode = 'sequential' | 'true_batch';
export interface BatchingPolicy {
  maxSequencesPerBatch: number;
  maxTokensPerBatch: number;
}
export interface NativeBatchLimits {
  nBatch: number;
  nUbatch: number;
  nCtx: number;
  nCtxSeq: number;
  maxParallelSequences: number;
  backendMaxParallelSequences: number;
  backendSequenceExecution: 'serial_ubatches';
}
export interface NativeDecodeMeasurement { sequences: number; tokens: number; nativeDecodeMs: number }
export interface BatchMetrics {
  mode: BatchMode;
  requestedBatchSize: number;
  effectiveBatchSize: number;
  nativeDecodeCount: number;
  totalTokens: number;
  totalElapsedMs: number;
  nativeDecodeMs: number;
  preparationMs: number;
  effectiveMsPerDocument: number;
  documentsPerSecond: number;
  tokensPerSecond: number;
  limits: NativeBatchLimits;
  decodes: NativeDecodeMeasurement[];
}
export interface EmbeddingBatchResult { embeddings: EmbeddingResult[]; metrics: BatchMetrics }
export interface EmbeddingOptions { signal?: AbortSignal; batchMode?: BatchMode; batchingPolicy?: BatchingPolicy }
export type EmbeddingKind = 'query' | 'document';
export type RuntimeState = 'unloaded' | 'loading' | 'ready' | 'unloading' | 'error';
export interface EmbeddingResult {
  vector: number[];
  dimensions: number;
  modelId: string;
  revision: string;
  quantization: string;
  tokenCount: number;
  /** Actual single-document measurement; unavailable for items in a batch request. */
  inferenceDurationMs: number | null;
  /** Successful inference has already occurred since the current load. */
  warm: boolean;
}
export interface ModelLoadResult {
  loadDurationMs: number;
  modelInfo: EmbeddingModelInfo;
}
export interface EmbeddingService {
  load(options?: EmbeddingOptions): Promise<ModelLoadResult>;
  unload(): Promise<void>;
  embedQuery(text: string, options?: EmbeddingOptions): Promise<EmbeddingResult>;
  embedDocument(text: string, options?: EmbeddingOptions): Promise<EmbeddingResult>;
  embedDocuments(texts: string[], options?: EmbeddingOptions): Promise<EmbeddingResult[]>;
  /** Atomic batch result, including actual decode-level telemetry. */
  embedDocumentsMeasured?(texts: string[], options?: EmbeddingOptions): Promise<EmbeddingBatchResult>;
  countTokens(text: string, kind: EmbeddingKind, options?: EmbeddingOptions): Promise<number>;
  isLoaded(): boolean;
  getState(): RuntimeState;
  getModelInfo(): EmbeddingModelInfo;
}

export interface EmbeddingErrorInfo { code: string; message: string; actualTokens?: number; maxTokens?: number }
export class EmbeddingError extends Error implements EmbeddingErrorInfo {
  readonly code: string;
  readonly actualTokens?: number;
  readonly maxTokens?: number;
  constructor(info: EmbeddingErrorInfo) {
    super(info.message);
    this.name = 'EmbeddingError';
    this.code = info.code;
    this.actualTokens = info.actualTokens;
    this.maxTokens = info.maxTokens;
  }
}

export interface DownloadableModel extends EmbeddingModelInfo {
  repository: string;
  filename: string;
  expectedBytes: number;
  sha256?: string;
  format: string;
  downloadUrl: string;
}
export type InstallerState = 'not_installed' | 'downloading' | 'partial' | 'verifying'
  | 'installing' | 'installed' | 'invalid' | 'error';
export type InstallOperation = 'recovery' | 'download' | 'verify' | 'install' | 'remove';
export interface InstallAttempt {
  operation: InstallOperation;
  startedAt: number;
  completedAt?: number;
  outcome: 'running' | 'success' | 'error' | 'cancelled' | 'interrupted';
  downloadDurationMs: number;
  verificationDurationMs: number;
  finalizationDurationMs: number;
  totalElapsedMs: number;
  networkBytes: number;
  averageBytesPerSecond: number;
  timeToFirstByteMs: number | null;
  availableStorageBeforeBytes: number;
  availableStorageAfterBytes: number | null;
  error?: EmbeddingErrorInfo;
}
export interface InstallerMetrics {
  downloadAttempts?: number;
  verificationAttempts?: number;
  installAttempts?: number;
  removeAttempts?: number;
  failures?: number;
  cancelled?: number;
  interrupted?: number;
  lastAttempt?: InstallAttempt;
  lastDownload?: InstallAttempt;
  lastSuccessfulInstall?: InstallAttempt;
  lastInterruptedAttempt?: InstallAttempt;
  lastVerification?: { durationMs: number; bytes: number; valid: boolean; source: string; timestamp: number };
  lastError?: EmbeddingErrorInfo & { timestamp: number };
  lastPersistenceError?: EmbeddingErrorInfo & { timestamp: number };
}
export interface InstallerStatus {
  state: InstallerState;
  busy: boolean;
  operation: InstallOperation | null;
  downloadedBytes: number;
  expectedBytes: number;
  progressPercent: number;
  verifiedBytes: number;
  verificationProgressPercent: number;
  elapsedMs: number;
  recentBytesPerSecond: number;
  averageBytesPerSecond: number;
  availableStorageBytes: number;
  installedBytes: number;
  model: DownloadableModel;
  metrics: InstallerMetrics;
  error?: EmbeddingErrorInfo;
}
export interface InstalledEmbeddingModel {
  model: DownloadableModel;
  bytes: number;
  storageCategory: string;
}
export interface RequiredStorage { availableBytes: number; requiredBytes: number; headroomBytes: number }
export interface EmbeddingModelInstaller {
  getStatus(): InstallerStatus;
  download(options?: EmbeddingOptions): Promise<void>;
  cancelDownload(): void;
  verify(): Promise<void>;
  install(): Promise<void>;
  /** Safely drains and unloads runtime before deleting model files. */
  remove(): Promise<void>;
  getInstalledModel(): InstalledEmbeddingModel | null;
  getRequiredStorage(): RequiredStorage;
  getModelMetadata(): DownloadableModel;
}

export interface DeviceDiagnostics {
  timestamp: number;
  manufacturer: string;
  model: string;
  androidVersion: string;
  sdk: number;
  abi: string | null;
  supportedAbis: string[];
  soc?: { model: string; manufacturer?: string };
  totalRamBytes: number | null;
  availableRamBytes: number | null;
  appPssBytes: number | null;
  rssBytes?: number | null;
  nativeHeapBytes: number;
  javaHeapBytes: number;
  batteryLevel: number | null;
  batteryTemperatureC: number | null;
  thermalStatus: number | null;
  lowMemory: boolean | null;
  thresholdBytes: number | null;
  batteryEnergy?: BatteryEnergyReadings;
}
export interface BatteryEnergyReadings {
  chargeCounterUah: number | null;
  currentNowUa: number | null;
  currentAverageUa: number | null;
  energyCounterNwh: number | null;
  plugged: boolean | null;
  status: number | null;
  /** Monotonic timestamp for the battery sample, not wall-clock time. */
  elapsedRealtimeMs: number;
}
export interface EmbeddingsEnvironment {
  service: EmbeddingService;
  installer: EmbeddingModelInstaller;
  sampleDevice(): Promise<DeviceDiagnostics>;
  copyText(text: string): void;
  exportJson(json: string): Promise<void>;
}
