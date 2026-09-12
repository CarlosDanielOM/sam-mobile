import { Utils, isAndroid } from '@nativescript/core';
import { createAndroidEmbeddingAdapters, type NativeEmbeddingEngine } from './android-adapter';
import { EmbeddingError, type DeviceDiagnostics, type EmbeddingsEnvironment } from './types';

declare const com: any;
let environment: EmbeddingsEnvironment | undefined;

/** Process lifetime, independent of pages, Activities, chats, providers and the database. */
export function getEmbeddingsEnvironment(): EmbeddingsEnvironment {
  if (environment) return environment;
  if (!isAndroid) throw new EmbeddingError({ code: 'UNSUPPORTED_PLATFORM', message: 'Local Embeddings Lab currently requires ARM64 Android.' });
  const context = Utils.android.getApplicationContext();
  const native = new com.sam.embeddings.SamEmbeddingEngine();
  const files = com.sam.embeddings.SamModelInstaller.getInstance(context);
  const diagnostics = com.sam.embeddings.SamDeviceDiagnostics;
  const bridge: NativeEmbeddingEngine = {
    loadModel: (path) => native.loadModel(path),
    unloadModel: () => native.unloadModel(),
    embedQuery: (text) => native.embedQuery(text),
    embedDocument: (text) => native.embedDocument(text),
    embedBatch: (texts) => {
      const strings = Array.create('java.lang.String', texts.length);
      texts.forEach((text, i) => { strings[i] = text; });
      return native.embedBatch(strings);
    },
    embedBatchWithOptions: (texts, mode, maxSequences, maxTokens) => {
      const strings = Array.create('java.lang.String', texts.length);
      texts.forEach((text, i) => { strings[i] = text; });
      return native.embedBatchWithOptions(strings, mode, maxSequences, maxTokens);
    },
    tokenize: (text, kind) => native.tokenize(text, kind),
    poll: (id) => native.poll(id),
    cancel: (id) => native.cancel(id),
    isLoaded: () => native.isLoaded(),
    getState: () => native.getState(),
    getModelInfo: () => native.getModelInfo(),
  };
  async function diagnosticRequest<T>(id: string): Promise<T> {
    for (;;) {
      const response = JSON.parse(diagnostics.poll(id));
      if (response.state === 'completed') {
        if (response.error) throw new EmbeddingError(response.error);
        return response.result as T;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
  environment = {
    ...createAndroidEmbeddingAdapters(bridge, files),
    sampleDevice: () => diagnosticRequest<DeviceDiagnostics>(diagnostics.sample(context)),
    copyText: (text) => {
      const clipboard = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager;
      clipboard.setPrimaryClip(android.content.ClipData.newPlainText('SAM Embeddings Benchmark', text));
    },
    exportJson: async (json) => { await diagnosticRequest(diagnostics.exportReport(context, json)); },
  };
  return environment;
}
