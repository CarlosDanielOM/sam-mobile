import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { mock, test } from 'node:test';
import { Injector } from '@angular/core';
import ts from 'typescript';
import type { DeviceDiagnostics, DownloadableModel, EmbeddingOptions, EmbeddingResult, EmbeddingsEnvironment } from '../../core/embeddings/types';

// Keep real Angular DI/signals and the pure controller; mock only the process-native environment.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/embeddings-lab.service.ts')) {
      return {
        format: 'module', shortCircuit: true,
        source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, experimentalDecorators: true },
        }).outputText,
      };
    }
    return nextLoad(url, context);
  },
});

let environment: EmbeddingsEnvironment;
let environmentCalls = 0;
mock.module('../../core/embeddings/android.ts', { namedExports: {
  getEmbeddingsEnvironment: () => { environmentCalls++; return environment; },
} });
const { EmbeddingsLabService } = await import('./embeddings-lab.service.ts');
const { obtainEmbeddingsLabRuntime } = await import('./embeddings-runtime.ts');

function mount() {
  const injector = Injector.create({ providers: [
    { provide: EmbeddingsLabService, useFactory: () => new EmbeddingsLabService() },
  ] });
  return { injector, service: injector.get(EmbeddingsLabService) };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for lab state');
}

test('Angular root recreation reattaches to one busy process lab without duplicate work or stale facade listeners', async t => {
  const model: DownloadableModel = {
    modelId: 'Official/Embedding', repository: 'Official/Embedding-GGUF', revision: 'abc123',
    quantization: 'Q8_0', dimensions: 1024, maxTokens: 512, batchMode: 'sequential',
    filename: 'model.gguf', expectedBytes: 1000, format: 'GGUF', downloadUrl: 'https://example.com/model',
  };
  const device: DeviceDiagnostics = {
    timestamp: 1, manufacturer: 'Test', model: 'Phone', androidVersion: '15', sdk: 35,
    abi: 'arm64-v8a', supportedAbis: ['arm64-v8a'], totalRamBytes: 8e9, availableRamBytes: 4e9,
    appPssBytes: 1000, nativeHeapBytes: 100, javaHeapBytes: 100, batteryLevel: 80,
    batteryTemperatureC: 30, thermalStatus: 0, lowMemory: false, thresholdBytes: 100,
  };
  const tokens = (text: string) => text.split(/\s+/).length + 2;
  const result = (text: string): EmbeddingResult => ({
    vector: [1, ...Array(1023).fill(0)], dimensions: 1024, modelId: model.modelId,
    revision: model.revision, quantization: model.quantization, tokenCount: tokens(text),
    inferenceDurationMs: 4, warm: true,
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let nativeSignal: AbortSignal | undefined;
  const documentCall = mock.fn(async (text: string, options?: EmbeddingOptions) => {
    nativeSignal = options?.signal;
    await gate;
    return result(text);
  });
  const query = mock.fn(async (text: string) => result(text));
  const unload = mock.fn(async () => {});
  const load = mock.fn(async () => ({ loadDurationMs: 20, modelInfo: model }));
  environment = {
    service: {
      load, unload, embedQuery: query, embedDocument: documentCall, embedDocuments: async texts => texts.map(result),
      countTokens: async text => tokens(text), isLoaded: () => true, getState: () => 'ready', getModelInfo: () => model,
    },
    installer: {
      getStatus: () => ({ state: 'installed', busy: false, operation: null, downloadedBytes: 1000,
        expectedBytes: 1000, progressPercent: 100, verifiedBytes: 1000, verificationProgressPercent: 100,
        elapsedMs: 0, recentBytesPerSecond: 0, averageBytesPerSecond: 0, availableStorageBytes: 1e9,
        installedBytes: 1000, model, metrics: {} }),
      getRequiredStorage: () => ({ availableBytes: 1e9, requiredBytes: 2000, headroomBytes: 1000 }),
      getInstalledModel: () => ({ model, bytes: 1000, storageCategory: 'app-private' }),
      getModelMetadata: () => model, download: async () => {}, cancelDownload: mock.fn(),
      verify: async () => {}, install: async () => {}, remove: async () => {},
    },
    sampleDevice: async () => ({ ...device }), copyText: () => {}, exportJson: async () => {},
  };
  const roots: ReturnType<typeof mount>[] = [];
  t.after(() => {
    release();
    for (const root of roots) if (!root.injector.destroyed) root.injector.destroy();
  });

  const first = mount(); roots.push(first);
  first.service.runSingle();
  await until(() => first.service.state().single !== null && first.service.state().busy === null);
  const single = first.service.state().single;
  first.service.benchmark(10);
  await until(() => documentCall.mock.callCount() === 1);
  const oldSnapshot = first.service.state();
  assert.equal(oldSnapshot.busy, 'benchmark');
  assert.equal(oldSnapshot.benchmarks[0].outcome, 'running');
  const oldSet = mock.method(first.service.state, 'set');
  first.injector.destroy();

  const second = mount(); roots.push(second);
  assert.equal(second.service.state().busy, 'benchmark');
  assert.equal(second.service.locked(), true);
  assert.equal(second.service.ready(), false);
  assert.equal(second.service.state().single, single);
  assert.equal(second.service.state().benchmarks[0].requested, 10);
  assert.deepEqual(second.service.state().progress, oldSnapshot.progress);
  assert.equal(environmentCalls, 1, 'new roots must reuse the same environment/controller holder');
  second.service.connect(); // Repeated availability actions must not duplicate subscriptions.
  second.service.benchmark(1);
  second.service.runSingle();
  second.service.load();
  second.service.unload();
  assert.equal(documentCall.mock.callCount(), 1);
  assert.equal(query.mock.callCount(), 1);
  assert.equal(load.mock.callCount(), 0);
  assert.equal(unload.mock.callCount(), 0);
  assert.equal(nativeSignal?.aborted, false, 'destroying the root must not cancel native work');

  release();
  await until(() => second.service.state().busy === null);
  assert.equal(second.service.state().benchmarks.length, 1);
  assert.equal(second.service.state().benchmarks[0].outcome, 'success');
  assert.equal(second.service.state().benchmarks[0].completed, 10);
  assert.equal(second.service.state().cancellations, 0);
  assert.equal(first.service.state(), oldSnapshot);
  assert.equal(oldSet.mock.callCount(), 0, 'destroyed facade must no longer receive controller snapshots');
  const completedSnapshot = second.service.state();
  second.injector.destroy();
  const secondSet = mock.method(second.service.state, 'set');

  const third = mount(); roots.push(third);
  assert.equal(third.service.state(), completedSnapshot);
  assert.equal(third.service.state().single, single);
  assert.equal(third.service.state().benchmarks[0].completed, 10);
  third.service.refresh();
  assert.notEqual(third.service.state(), completedSnapshot);
  assert.equal(second.service.state(), completedSnapshot);
  assert.equal(secondSet.mock.callCount(), 0);
  assert.equal(oldSet.mock.callCount(), 0);
  assert.equal(environmentCalls, 1);
  assert.equal(documentCall.mock.callCount(), 10);
  assert.equal(unload.mock.callCount(), 0);

  await t.test('batch facade forwards selected parameters, confirms cost and blocks unsupported or busy actions', async () => {
    const service = third.service;
    const controller = obtainEmbeddingsLabRuntime().controller;
    const full = mock.method(controller, 'batchComparison', async () => {});
    const target = mock.method(controller, 'batchBenchmark', async () => {});
    try {
      assert.equal(service.batchCount(), 100);
      assert.deepEqual(service.batchModes, [1, 2, 5, 10, 20, 50, 100]);
      service.batchSize.set('256'); service.batchTarget.set(5);
      const confirm = mock.fn(async () => true);
      await service.runBatch(false, confirm);
      assert.deepEqual(target.mock.calls[0].arguments, ['256', 5, 100]);
      assert.equal(confirm.mock.callCount(), 0);
      assert.match(service.batchPlan().target, /sequential, 2, 5.*prerequisite lower tiers/);
      assert.match(service.batchPlan().target, /300 measured documents/);
      await service.runBatch(true, confirm);
      assert.deepEqual(full.mock.calls[0].arguments, ['256', 100]);
      assert.match(confirm.mock.calls[0].arguments[0], /500 measured documents/);
      service.batchSize.set('near512'); service.batchTarget.set(100);
      assert.match(service.batchUnsupported()!, /not supported/);
      await service.runBatch(false, confirm);
      assert.equal(target.mock.callCount(), 1);
      assert.equal(service.batchTarget(), 100, 'unsupported modes stay selectable');
      await service.runBatch(true, confirm);
      assert.deepEqual(full.mock.calls[1].arguments, ['near512', 100]);

      service.batchSize.set('short'); service.batchTarget.set(2); service.batchCount.set(1000);
      await service.runBatch(false, async message => {
        assert.match(message, /2000 measured documents/);
        assert.match(message, /battery heavy/);
        assert.equal(service.locked(), true);
        assert.equal(service.ready(), false);
        await service.runBatch(true, confirm);
        return false;
      });
      assert.equal(target.mock.callCount(), 1);
      assert.equal(full.mock.callCount(), 2);
      assert.equal(service.confirmingBatch(), false);
      await service.runBatch(false, async () => true);
      assert.deepEqual(target.mock.calls[1].arguments, ['short', 2, 1000]);
      await service.runBatch(true, async message => {
        assert.match(message, /7000 measured documents/);
        return true;
      });
      assert.deepEqual(full.mock.calls[2].arguments, ['short', 1000]);

      const snapshot = service.state();
      await service.runBatch(false, async () => {
        service.state.set({ ...snapshot, busy: 'single' });
        return true;
      });
      assert.equal(target.mock.callCount(), 2, 'recheck busy after confirmation');
      await service.runBatch(true, confirm);
      assert.equal(full.mock.callCount(), 3);
      service.state.set(snapshot);
      await assert.rejects(service.runBatch(true, async () => { throw new Error('Dialog unavailable'); }));
      assert.equal(service.locked(), false, 'failed dialog releases confirmation lock');
      await service.runBatch(true, async () => {
        service.batchSize.set('128'); service.batchCount.set(100);
        return true;
      });
      assert.deepEqual(full.mock.calls[3].arguments, ['short', 1000], 'execute only parameters whose cost was confirmed');
    } finally { full.mock.restore(); target.mock.restore(); }
  });

  await t.test('batch gate failures, nullable metrics and native limits survive root recreation', async () => {
    model.batchLimits = { nBatch: 768, nUbatch: 768, nCtx: 3072, nCtxSeq: 384,
      maxParallelSequences: 6, backendMaxParallelSequences: 4, backendSequenceExecution: 'serial_ubatches' };
    // The identical-vector fixture must fail the multilingual correctness gate before any measured work.
    const measured = mock.fn(async () => { throw new Error('Must not reach measured workload'); });
    environment.service.embedDocumentsMeasured = measured;
    third.service.refresh();
    third.service.batchSize.set('short'); third.service.batchTarget.set(2); third.service.batchCount.set(100);
    await third.service.runBatch(false, async () => true);
    assert.equal(measured.mock.callCount(), 0);
    const retained = third.service.state();
    assert.equal(retained.batchComparisons[0].correctness.outcome, 'failed');
    assert.equal(retained.batchComparisons[0].outcome, 'error');
    third.injector.destroy();
    const fourth = mount(); roots.push(fourth);
    const service = fourth.service;
    assert.equal(service.state(), retained);
    assert.match(service.batchLimitsText(), /nBatch 768.*nUbatch 768.*nCtx 3072.*nCtxSeq 384/);
    assert.match(service.batchLimitsText(), /maxParallelSequences 6.*backend 4/);
    assert.match(service.batchLimitsText(), /serial_ubatches/);
    assert.match(service.batchReports()[0].correctness, /failed/);
    assert.match(service.batchReports()[0].runs[0].reason, /Not started:/);
    assert.match(service.batchReports()[0].runs[0].title, /observed effective unavailable/);
    assert.match(service.batchReports()[0].runs[0].energyReason!, /samples/);
    for (const name of ['docs/s', 'tok/s', 'ms/doc', 'Energy/doc']) {
      assert.equal(service.batchReports()[0].runs[0].metrics.find(metric => metric.name === name)?.value, 'unavailable');
    }
    assert.match(service.summary({ ...single!, inferenceDurationMs: null, tokensPerMs: null }), /unavailable inference/);
    const comparison = retained.batchComparisons[0];
    const run = comparison.runs[0];
    service.state.set({ ...retained, busy: 'batch-comparison', device: { ...device, batteryTemperatureC: 39,
      batteryEnergy: { chargeCounterUah: 4000000, energyCounterNwh: null, currentNowUa: -500000,
        currentAverageUa: null, plugged: false, status: 3, elapsedRealtimeMs: 500 } },
      batchComparisons: [{ ...comparison, correctness: { ...comparison.correctness, outcome: 'passed', minimumCosine: 0.999999 },
        runs: [{ ...run, outcome: 'running', requestedBatchSize: 20, effectiveBatchSize: 4, nativeDecodeCount: 1,
          documentsPerSecond: 2, tokensPerSecond: 24, effectiveMsPerDocument: 500,
          samplePeakPssBytes: 104857600, temperatureC: { initial: 30, peak: 39, final: null },
          energy: { ...run.energy, mwhPer100Documents: 25, reason: null, energyReason: null },
          throughputBlocks: [{ phase: 'initial', startMs: 0, endMs: 1000, elapsedMs: 1000,
            completed: 2, totalTokens: 24, documentsPerSecond: 2, tokensPerSecond: 24 }] }] }],
    });
    const row = service.batchReports()[0].runs[0];
    assert.match(service.batchReports()[0].correctness, /passed/);
    assert.match(row.title, /Requested 20 \/ observed effective 4/);
    assert.equal(row.metrics.find(metric => metric.name === 'Energy/doc')?.value, '0.250000 mWh/doc');
    assert.match(row.details, /Initial: 2.00 docs\/s \/ 24.00 tok\/s/);
    assert.match(row.details, /Mid: unavailable \/ unavailable/);
    assert.match(service.batchLiveText()!, /39.00 C/);
    assert.match(service.batteryEnergyText(), /4000000 uAh \/ unavailable/);
    assert.equal(service.ready(), false);
    assert.equal(retained.batchComparisons[0].runs[0].effectiveMsPerDocument, null, 'formatting must not mutate retained snapshots');
    service.state.set(retained);
    assert.equal(service.batchLiveText(), null);
    assert.equal(environmentCalls, 1);
  });

  await t.test('live batch gate reattaches across roots and cancel stays busy until native drain', async () => {
    const root = roots.at(-1)!;
    const indices = new Map<string, number>();
    environment.service.embedDocument = async text => {
      if (!indices.has(text)) indices.set(text, indices.size);
      const vector = Array(1024).fill(0);
      vector[indices.get(text)!] = 1;
      return { ...result(text), vector };
    };
    let drain!: () => void;
    let signal: AbortSignal | undefined;
    const native = mock.fn(async (_texts: string[], options?: EmbeddingOptions) => {
      signal = options?.signal;
      await new Promise<void>(resolve => { drain = resolve; });
      throw { code: 'CANCELLED' };
    });
    environment.service.embedDocumentsMeasured = native;
    root.service.batchTarget.set(2);
    const running = root.service.runBatch(false, async () => true);
    await until(() => native.mock.callCount() === 1);
    try {
      const live = root.service.state();
      assert.equal(live.busy, 'batch-benchmark');
      assert.equal(live.batchComparisons.at(-1)?.correctness.outcome, 'running');
      root.injector.destroy();
      const next = mount(); roots.push(next);
      assert.equal(next.service.state(), live);
      assert.equal(next.service.ready(), false);
      assert.match(next.service.batchReports().at(-1)!.correctness, /running/);
      next.service.cancel();
      assert.equal(signal?.aborted, true);
      assert.equal(next.service.locked(), true, 'cancel requests abort, not early unlock');
      assert.equal(native.mock.callCount(), 1);
      drain();
      await running;
      assert.equal(next.service.state().busy, null);
      assert.equal(next.service.state().batchComparisons.at(-1)?.outcome, 'cancelled');
      assert.equal(next.service.state().batchComparisons.at(-1)?.correctness.outcome, 'cancelled');
      assert.equal(next.service.state().cancellations, 1);
      assert.equal(root.service.state(), live, 'unmounted facade stays detached');
    } finally { drain(); await running; }
  });
});
