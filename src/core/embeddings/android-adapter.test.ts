import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAndroidEmbeddingAdapters, type NativeEmbeddingEngine, type NativeModelInstaller } from './android-adapter';

function fixture(installed = true) {
  let loaded = false;
  let failure: string | undefined;
  let next = 0;
  let busy = false;
  let state = installed ? 'installed' : 'not_installed';
  let error: unknown;
  let blocked = false;
  const events: string[] = [];
  const batchRequests: { texts: string[]; mode: string; sequences: number; tokens: number }[] = [];
  const pending = new Map<string, { action: () => unknown; cancelled: boolean }>();
  const submit = (name: string, action: () => unknown) => {
    events.push(name);
    const id = String(++next);
    pending.set(id, { action, cancelled: false });
    return id;
  };
  const embedding = (text: string) => {
    if (!loaded) throw { code: 'MODEL_NOT_LOADED', message: 'Load first' };
    return { vector: [1, 0], tokenCount: text.length, dimensions: 2, inferenceDurationMs: 1 };
  };
  const engine: NativeEmbeddingEngine = {
    loadModel: path => submit('load:' + path, () => {
      if (failure) { const code = failure; failure = undefined; throw { code, message: 'Load failed' }; }
      loaded = true; return { loadDurationMs: 4, modelInfo: {} };
    }),
    unloadModel: () => submit('unload', () => { loaded = false; return { unloaded: true }; }),
    embedQuery: text => submit('query:' + text, () => embedding(text)),
    embedDocument: text => submit('document:' + text, () => embedding(text)),
    embedBatch: texts => submit('batch:' + texts.join('|'), () => texts.map(embedding)),
    embedBatchWithOptions: (texts, mode, sequences, tokens) => {
      batchRequests.push({ texts: [...texts], mode, sequences, tokens });
      return submit('batch:' + texts.join('|'), () => ({ embeddings: texts.map(embedding), metrics: { mode, requestedBatchSize: sequences } }));
    },
    tokenize: (text, kind) => submit('tokenize:' + kind, () => ({ tokenCount: text.length + 3 })),
    poll: id => {
      const request = pending.get(id)!;
      if (blocked) return JSON.stringify({ status: 'pending' });
      pending.delete(id);
      if (request.cancelled) return JSON.stringify({ status: 'cancelled' });
      try { return JSON.stringify({ status: 'completed', result: request.action() }); }
      catch (error) { return JSON.stringify({ status: 'error', error }); }
    },
    cancel: id => { events.push('cancel'); pending.get(id)!.cancelled = true; },
    getModelInfo: () => JSON.stringify({ modelId: 'test', dimensions: 2 }),
    getState: () => loaded ? 'ready' : 'unloaded',
    isLoaded: () => loaded,
  };
  const files: NativeModelInstaller = {
    getStatus: () => JSON.stringify({ state, busy, error, metrics: {} }),
    getModelMetadata: () => JSON.stringify({ modelId: 'test' }),
    getRequiredStorage: () => JSON.stringify({ availableBytes: 1000, requiredBytes: 500, headroomBytes: 100 }),
    getInstalledModel: () => JSON.stringify(installed ? { path: '/private/model', model: { modelId: 'test' }, bytes: 42 } : null),
    download: () => { events.push('download'); busy = true; state = 'downloading'; },
    cancelDownload: () => { events.push('cancelDownload'); busy = false; state = 'partial'; error = { code: 'CANCELLED', message: 'Cancelled' }; },
    verify: () => { events.push('verify'); },
    install: () => { events.push('install'); installed = true; state = 'installed'; },
    remove: () => {
      assert.equal(loaded, false, 'must not delete an mmap-backed model');
      events.push('remove'); installed = false; state = 'not_installed';
    },
  };
  return {
    ...createAndroidEmbeddingAdapters(engine, files, 1), events, pending, batchRequests,
    block: (value: boolean) => { blocked = value; },
    failLoad: (code: string) => { failure = code; },
    finishDownload: (code?: string) => {
      busy = false; installed = !code; state = code ? 'invalid' : 'installed';
      error = code ? { code, message: 'Install failed' } : undefined;
    },
    recovering: () => { busy = true; state = 'verifying'; },
  };
}
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 5));

test('measured batching forwards snapshotted mode and policy through one native operation', async () => {
  const f = fixture();
  await f.service.load();
  const texts = ['first', 'second'];
  const policy = { maxSequencesPerBatch: 5, maxTokensPerBatch: 512 };
  const request = f.service.embedDocumentsMeasured!(texts, { batchMode: 'true_batch', batchingPolicy: policy });
  texts.reverse(); policy.maxSequencesPerBatch = 100;
  const result = await request;
  assert.equal(result.metrics.mode, 'true_batch');
  assert.deepEqual(f.batchRequests, [{ texts: ['first', 'second'], mode: 'true_batch', sequences: 5, tokens: 512 }]);
  await f.service.embedDocuments(['baseline'], { batchMode: 'sequential' });
  assert.equal(f.batchRequests[1].mode, 'sequential');
  assert.equal(f.events.some(event => event.startsWith('document:')), false);
});

test('invalid batch policy is rejected before native admission and runtime remains reusable', async () => {
  const f = fixture();
  await f.service.load();
  for (const [sequences, tokens] of [[0, 512], [101, 512], [2.5, 512], [2, 0], [2, 4097], [2, NaN]]) {
    await assert.rejects(f.service.embedDocumentsMeasured!(['one'], {
      batchingPolicy: { maxSequencesPerBatch: sequences, maxTokensPerBatch: tokens },
    }), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(f.batchRequests.length, 0);
  assert.equal((await f.service.embedDocuments(['one', 'two'])).length, 2);
});

test('missing installation and embedding before load are structured and recoverable', async () => {
  const f = fixture(false);
  await assert.rejects(f.service.load(), { code: 'MODEL_NOT_INSTALLED' });
  await assert.rejects(f.service.embedQuery('hello'), { code: 'MODEL_NOT_LOADED' });
  await f.installer.install();
  await f.service.load();
  assert.equal(f.service.isLoaded(), true);
});

test('simultaneous loads, embedding during load and repeated unload preserve FIFO', async () => {
  const f = fixture();
  await Promise.all([f.service.load(), f.service.load(), f.service.embedQuery('raw'), f.service.unload(), f.service.unload()]);
  assert.deepEqual(f.events, ['load:/private/model', 'load:/private/model', 'query:raw', 'unload', 'unload']);
  assert.equal(f.service.isLoaded(), false);
});

test('removal drains existing inference, unloads, and blocks later load', async () => {
  const f = fixture();
  await f.service.load();
  f.block(true);
  const embedding = f.service.embedDocument('hello');
  const removal = f.installer.remove();
  const reload = assert.rejects(f.service.load(), { code: 'MODEL_NOT_INSTALLED' });
  await turn();
  assert.equal(f.events.includes('remove'), false);
  f.block(false);
  await Promise.all([embedding, removal, reload]);
  assert.deepEqual(f.events.slice(-3), ['document:hello', 'unload', 'remove']);
});

test('queued cancellation never calls native backend', async () => {
  const f = fixture();
  f.block(true);
  const loading = f.service.load();
  const controller = new AbortController();
  const rejected = assert.rejects(f.service.embedQuery('cancel me', { signal: controller.signal }), { code: 'CANCELLED' });
  controller.abort();
  f.block(false);
  await Promise.all([loading, rejected]);
  assert.equal(f.events.some(event => event.includes('cancel me')), false);
});

test('active cancellation drains terminal result before unload and remains usable', async () => {
  const f = fixture();
  await f.service.load();
  f.block(true);
  const controller = new AbortController();
  const rejected = assert.rejects(f.service.embedQuery('hello', { signal: controller.signal }), { code: 'CANCELLED' });
  await turn();
  controller.abort();
  const unload = f.service.unload();
  await turn();
  assert.equal(f.events.includes('unload'), false);
  f.block(false);
  await Promise.all([rejected, unload]);
  assert.equal(f.pending.size, 0);
  await f.service.load();
  await f.service.embedQuery('recovered');
});

test('download cancellation before admission does not start network', async () => {
  const f = fixture();
  f.block(true);
  const load = f.service.load();
  const download = assert.rejects(f.installer.download(), { code: 'CANCELLED' });
  f.installer.cancelDownload();
  f.block(false);
  await Promise.all([load, download]);
  assert.equal(f.events.includes('download'), false);
});

test('repeated download rejected, partial cancel stays uninstalled, retry succeeds', async () => {
  const f = fixture(false);
  const download = assert.rejects(f.installer.download(), { code: 'CANCELLED' });
  await assert.rejects(f.installer.download(), { code: 'BUSY' });
  await turn();
  f.installer.cancelDownload();
  await download;
  assert.equal(f.installer.getStatus().state, 'partial');
  assert.equal(f.installer.getInstalledModel(), null);
  const retry = f.installer.download();
  await turn();
  f.finishDownload();
  await retry;
  assert.equal(f.installer.getStatus().state, 'installed');
});

test('failed verification/storage error cannot load and retry is not poisoned', async () => {
  for (const code of ['HASH_MISMATCH', 'SIZE_MISMATCH', 'INSUFFICIENT_STORAGE', 'NETWORK_IO']) {
    const f = fixture(false);
    const download = assert.rejects(f.installer.download(), { code });
    await turn();
    f.finishDownload(code);
    await download;
    await assert.rejects(f.service.load(), { code: 'MODEL_NOT_INSTALLED' });
  }
});

test('load waits for startup integrity verification', async () => {
  const f = fixture();
  f.recovering();
  const load = f.service.load();
  await turn();
  assert.deepEqual(f.events, []);
  f.finishDownload();
  await load;
});

test('load failures preserve error details and queue can recover', async () => {
  for (const code of ['INVALID_PATH', 'INVALID_MODEL', 'NATIVE_INIT_FAILED']) {
    const f = fixture();
    f.failLoad(code);
    await assert.rejects(f.service.load(), { code });
    await f.service.load();
    assert.equal(f.service.isLoaded(), true);
  }
});

test('raw text is unchanged at TS boundary, actual counting and ordered batch copy', async () => {
  const f = fixture();
  await f.service.load();
  const texts = ['A', 'BB'];
  const result = f.service.embedDocuments(texts);
  texts[0] = 'mutated';
  assert.deepEqual((await result).map(row => row.tokenCount), [1, 2]);
  await f.service.embedQuery('query: raw');
  assert.equal(f.events.includes('query:query: raw'), true);
  assert.equal(await f.service.countTokens('long'.repeat(200), 'document'), 803);
  await assert.rejects(f.service.embedDocuments([]), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.service.embedDocuments(Array(1001).fill('x')), { code: 'INVALID_ARGUMENT' });
});

test('installer exposes category, never private path in public installed-model contract', () => {
  const f = fixture();
  const installed = f.installer.getInstalledModel();
  assert.equal('path' in installed!, false);
  assert.equal(installed!.bytes, 42);
  assert.equal(f.installer.getRequiredStorage().headroomBytes, 100);
});

test('bounded admission rejects overload without native submissions', async () => {
  const f = fixture();
  const work = Array.from({ length: 128 }, () => f.service.unload());
  await assert.rejects(f.service.unload(), { code: 'QUEUE_FULL' });
  await Promise.all(work);
  await f.service.unload();
});

test('malformed and empty inputs are structured before crossing JNI', async () => {
  const f = fixture();
  await assert.rejects(f.service.embedQuery(null as unknown as string), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.service.embedDocument('   '), { code: 'EMPTY_INPUT' });
  await assert.rejects(f.service.embedDocuments(['ok', '']), { code: 'EMPTY_INPUT' });
  await assert.rejects(f.service.countTokens('text', 'invalid' as 'query'), { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(f.events, []);
});
