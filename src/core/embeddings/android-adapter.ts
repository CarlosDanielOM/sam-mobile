import {
  EmbeddingError, type DownloadableModel, type EmbeddingKind, type EmbeddingModelInfo,
  type EmbeddingModelInstaller, type EmbeddingOptions, type EmbeddingResult, type EmbeddingService,
  type InstalledEmbeddingModel, type InstallerStatus, type ModelLoadResult, type RequiredStorage,
  type RuntimeState, type EmbeddingBatchResult,
} from './types';

/** JSON bridge ports are private to the Android adapter, not the core service contract. */
export interface NativeEmbeddingEngine {
  loadModel(path: string): string;
  unloadModel(): string;
  embedQuery(text: string): string;
  embedDocument(text: string): string;
  embedBatch(texts: string[]): string;
  embedBatchWithOptions(texts: string[], mode: string, maxSequences: number, maxTokens: number): string;
  tokenize(text: string, kind: string): string;
  poll(id: string): string;
  cancel(id: string): void;
  isLoaded(): boolean;
  getState(): string;
  getModelInfo(): string;
}
export interface NativeModelInstaller {
  getStatus(): string;
  getModelMetadata(): string;
  getInstalledModel(): string;
  getRequiredStorage(): string;
  download(): void;
  cancelDownload(): void;
  verify(): void;
  install(): void;
  remove(): void;
}

const cancelled = () => new EmbeddingError({ code: 'CANCELLED', message: 'Operation cancelled.' });
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function validateText(text: string): void {
  if (typeof text !== 'string') throw new EmbeddingError({ code: 'INVALID_ARGUMENT', message: 'Embedding input must be a string.' });
  if (!text.trim()) throw new EmbeddingError({ code: 'EMPTY_INPUT', message: 'Embedding input must not be empty.' });
}

/** One admission queue coordinates file mutation with every model/context operation. */
export function createAndroidEmbeddingAdapters(
  engine: NativeEmbeddingEngine, files: NativeModelInstaller, pollMs = 16,
): { service: EmbeddingService; installer: EmbeddingModelInstaller } {
  let tail: Promise<unknown> = Promise.resolve();
  let queued = 0;
  let downloadController: AbortController | undefined;
  let downloadPromise: Promise<void> | undefined;
  function enqueue<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(cancelled());
    if (queued >= 128) return Promise.reject(new EmbeddingError({ code: 'QUEUE_FULL', message: 'Embedding queue is full. Retry after current work finishes.' }));
    queued++;
    const result = tail.then(() => {
      if (signal?.aborted) throw cancelled();
      return work();
    });
    tail = result.then(() => { queued--; }, () => { queued--; });
    return result;
  }
  async function nativeRequest<T>(start: () => string, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw cancelled();
    const id = start();
    const abort = () => engine.cancel(id);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      // Drain even after cancellation: releasing the file lock early could race native mmap.
      for (;;) {
        const response = JSON.parse(engine.poll(id));
        if (response.status === 'completed') {
          if (signal?.aborted) throw cancelled();
          return response.result as T;
        }
        if (response.status === 'cancelled') throw cancelled();
        if (response.status === 'error') throw new EmbeddingError(response.error);
        if (response.status !== 'pending') throw new EmbeddingError({ code: 'BRIDGE_ERROR', message: 'Invalid native response.' });
        await pause(pollMs);
      }
    } finally { signal?.removeEventListener('abort', abort); }
  }
  const status = (): InstallerStatus => JSON.parse(files.getStatus());
  async function waitForInstaller(): Promise<InstallerStatus> {
    let current = status();
    while (current.busy) {
      await pause(Math.max(pollMs, 50));
      current = status();
    }
    return current;
  }
  function measuredDocuments(texts: string[], options: EmbeddingOptions = {}): Promise<EmbeddingBatchResult> {
    if (!Array.isArray(texts) || texts.length === 0 || texts.length > 1000 || texts.some(text => typeof text !== 'string')) {
      return Promise.reject(new EmbeddingError({ code: 'INVALID_ARGUMENT', message: 'Supply between 1 and 1000 document strings.' }));
    }
    const mode = options.batchMode ?? 'true_batch';
    // These are request ceilings, not a device profile. Native getter-reported limits always cap them.
    const sequences = options.batchingPolicy?.maxSequencesPerBatch ?? 100;
    const tokens = options.batchingPolicy?.maxTokensPerBatch ?? 4096;
    if (!['sequential', 'true_batch'].includes(mode) || !Number.isInteger(sequences) || sequences < 1 || sequences > 100 ||
        !Number.isInteger(tokens) || tokens < 1 || tokens > 4096) {
      return Promise.reject(new EmbeddingError({ code: 'INVALID_ARGUMENT', message: 'Expected sequential or true_batch, 1..100 sequences and 1..4096 tokens.' }));
    }
    const copy = texts.slice();
    const signal = options.signal;
    return enqueue(() => {
      copy.forEach(validateText);
      return nativeRequest<EmbeddingBatchResult>(() => engine.embedBatchWithOptions(copy, mode, sequences, tokens), signal);
    }, signal);
  }
  const service: EmbeddingService = {
    load: (options = {}) => enqueue(async () => {
      await waitForInstaller();
      const installed = JSON.parse(files.getInstalledModel()) as { path: string } | null;
      if (!installed) throw new EmbeddingError({ code: 'MODEL_NOT_INSTALLED', message: 'Install and verify the model in Embeddings Lab before loading.' });
      return nativeRequest<ModelLoadResult>(() => engine.loadModel(installed.path), options.signal);
    }, options.signal),
    unload: () => enqueue(async () => { await nativeRequest(() => engine.unloadModel()); }),
    embedQuery: (text, options = {}) => enqueue(() => {
      validateText(text);
      return nativeRequest<EmbeddingResult>(() => engine.embedQuery(text), options.signal);
    }, options.signal),
    embedDocument: (text, options = {}) => enqueue(() => {
      validateText(text);
      return nativeRequest<EmbeddingResult>(() => engine.embedDocument(text), options.signal);
    }, options.signal),
    embedDocuments: (texts, options) => measuredDocuments(texts, options).then(result => result.embeddings),
    embedDocumentsMeasured: measuredDocuments,
    countTokens: (text: string, kind: EmbeddingKind, options: EmbeddingOptions = {}) => enqueue(async () => {
      validateText(text);
      if (kind !== 'query' && kind !== 'document') throw new EmbeddingError({ code: 'INVALID_ARGUMENT', message: 'Choose query or document encoding.' });
      const result = await nativeRequest<{ tokenCount: number }>(() => engine.tokenize(text, kind), options.signal);
      return result.tokenCount;
    }, options.signal),
    isLoaded: () => engine.isLoaded(),
    getState: () => engine.getState() as RuntimeState,
    getModelInfo: () => JSON.parse(engine.getModelInfo()) as EmbeddingModelInfo,
  };
  async function mutate(command: 'download' | 'verify' | 'install' | 'remove', signal?: AbortSignal): Promise<void> {
    await waitForInstaller();
    if (signal?.aborted) throw cancelled();
    // Never remove or replace an mmap-backed file while native work can access it.
    if (engine.isLoaded()) await nativeRequest(() => engine.unloadModel());
    if (signal?.aborted) throw cancelled();
    const abort = () => files.cancelDownload();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      files[command]();
      if (signal?.aborted) abort();
      const final = await waitForInstaller();
      if (signal?.aborted) throw cancelled();
      if (final.error) throw new EmbeddingError(final.error);
      if ((command === 'download' || command === 'install') && final.state !== 'installed') {
        throw new EmbeddingError({ code: 'INSTALL_FAILED', message: 'The model was not verified and installed.' });
      }
    } finally { signal?.removeEventListener('abort', abort); }
  }
  const installer: EmbeddingModelInstaller = {
    getStatus: status,
    getModelMetadata: () => JSON.parse(files.getModelMetadata()) as DownloadableModel,
    getRequiredStorage: () => JSON.parse(files.getRequiredStorage()) as RequiredStorage,
    getInstalledModel: () => {
      const installed = JSON.parse(files.getInstalledModel());
      return installed ? { model: installed.model, bytes: installed.bytes, storageCategory: 'App-private, excluded from backups' } as InstalledEmbeddingModel : null;
    },
    download: (options = {}) => {
      // A second tap does not enqueue a surprise retry after cancellation/failure.
      if (downloadPromise) return Promise.reject(new EmbeddingError({ code: 'BUSY', message: 'A model download is already requested.' }));
      const controller = new AbortController();
      downloadController = controller;
      const abort = () => controller.abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      downloadPromise = enqueue(() => mutate('download', controller.signal), controller.signal).finally(() => {
        options.signal?.removeEventListener('abort', abort);
        downloadController = undefined;
        downloadPromise = undefined;
      });
      return downloadPromise;
    },
    cancelDownload: () => { downloadController?.abort(); files.cancelDownload(); },
    verify: () => enqueue(() => mutate('verify')),
    install: () => enqueue(() => mutate('install')),
    remove: () => enqueue(() => mutate('remove')),
  };
  return { service, installer };
}
