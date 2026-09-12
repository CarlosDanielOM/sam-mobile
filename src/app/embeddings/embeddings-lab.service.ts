import { Injectable, computed, signal, type OnDestroy } from '@angular/core';
import {
  CROSS_DOCUMENTS, CROSS_QUERY, initialLabState, labError,
  type BenchmarkReport, type BenchmarkSize, type EmbeddingsLabController, type LabState, type VectorSummary,
} from '../../core/embeddings/lab';
import { buildReport, formatBytes, formatDeviceSample, formatMeasurement, formatSeconds, formatTransferRate,
  humanReport, serializeReport } from '../../core/embeddings/report';
import type { EmbeddingKind, EmbeddingsEnvironment } from '../../core/embeddings/types';
import { BATCH_TARGETS } from '../../core/embeddings/batching';
import { obtainEmbeddingsLabRuntime } from './embeddings-runtime';

@Injectable({ providedIn: 'root' })
export class EmbeddingsLabService implements OnDestroy {
  readonly state = signal<LabState>(initialLabState());
  readonly unavailable = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly exporting = signal(false);
  readonly sampling = signal(false);
  readonly input = signal('How can I reset my account password?');
  readonly kind = signal<EmbeddingKind>('query');
  readonly query = signal('How do I recover access to my account?');
  readonly documents = signal([...CROSS_DOCUMENTS]);
  readonly size = signal<BenchmarkSize>('short');
  readonly batchSize = signal<BenchmarkSize>('short');
  readonly batchTarget = signal(1);
  readonly batchCount = signal<100 | 1000>(100);
  readonly confirmingBatch = signal(false);
  readonly expandedBatch = signal<number | null>(null);
  readonly batchModes = BATCH_TARGETS.short;
  readonly batchUnsupported = computed(() => BATCH_TARGETS[this.batchSize()].includes(this.batchTarget()) ? null
    : `Target ${this.batchTarget()} is not supported for ${this.batchSize()} by the core safety matrix. Select a lower target or Short; full comparison still uses only supported tiers.`);
  readonly batchPlan = computed(() => {
    const tiers = BATCH_TARGETS[this.batchSize()];
    const prefix = tiers.filter(tier => tier <= this.batchTarget());
    const names = (values: readonly number[]) => values.map(tier => tier === 1 ? 'sequential' : String(tier)).join(', ');
    return {
      matrix: `Full matrix: ${names(tiers)}. Up to ${tiers.length * this.batchCount()} measured documents (${this.batchCount()} per tier), plus tokenizer sizing and correctness work.`,
      target: this.batchUnsupported() ?? `Selected target runs ${names(prefix)} in ascending order, including all prerequisite lower tiers. Up to ${prefix.length * this.batchCount()} measured documents, plus sizing and correctness work.`,
    };
  });
  readonly batchLimitsText = computed(() => {
    const limits = this.state().runtime === 'ready' ? this.state().model?.batchLimits : null;
    if (!limits) return 'Loaded native limits unavailable. Load the model to query actual values.';
    return `Loaded native limits (tokens): nBatch ${limits.nBatch} / nUbatch ${limits.nUbatch} / nCtx ${limits.nCtx} / nCtxSeq ${limits.nCtxSeq}\nSequence limits: maxParallelSequences ${limits.maxParallelSequences} / backend ${limits.backendMaxParallelSequences}\nBackend execution: ${limits.backendSequenceExecution}. Internal micro-batches are serial; no parallel speedup is promised.`;
  });
  readonly batteryEnergyText = computed(() => {
    const energy = this.state().device?.batteryEnergy;
    if (!energy) return 'Battery energy diagnostics unavailable on this device/sample.';
    return `Battery counters: ${formatMeasurement(energy.chargeCounterUah, 'uAh', 0)} / ${formatMeasurement(energy.energyCounterNwh, 'nWh', 0)}\nCurrent now / average: ${formatMeasurement(energy.currentNowUa, 'uA', 0)} / ${formatMeasurement(energy.currentAverageUa, 'uA', 0)}\nPlugged: ${energy.plugged ?? 'unavailable'} / Android battery status: ${energy.status ?? 'unavailable'} (3 = discharging)`;
  });
  readonly batchLiveText = computed(() => ['batch-comparison', 'batch-benchmark'].includes(this.state().busy)
    ? formatDeviceSample(this.state().device) : null);
  readonly batchReports = computed(() => this.state().batchComparisons.map(comparison => ({
    timestamp: comparison.timestamp,
    title: `${comparison.size === 'near512' ? 'Max (near 512)' : comparison.size} / ${comparison.requested} docs per tier / ${comparison.requestedTarget === null ? 'full matrix' : `through target ${comparison.requestedTarget}`} / ${comparison.outcome}`,
    correctness: `Correctness gate: ${comparison.correctness.outcome} (${comparison.correctness.completed}/${comparison.correctness.documents}) / min cosine ${formatMeasurement(comparison.correctness.minimumCosine, '', 6)} / tolerance ${comparison.correctness.tolerance}. Representative count, order, dimensions, finite values and multilingual cosine only; not production certification.`,
    tokens: `Actual / target tokens per doc: ${formatMeasurement(comparison.actualTokens, '', 0)} / ${formatMeasurement(comparison.targetTokens, '', 0)}. Sizing and correctness excluded from warm metrics.`,
    error: comparison.error ? `${comparison.error.code}: ${comparison.error.message}` : null,
    runs: comparison.runs.map(run => ({
      target: run.target,
      title: `Batch ${run.target === 1 ? 'sequential' : run.target} / ${run.outcome}${run.optional ? ' (optional)' : ''}\nRequested ${run.requestedBatchSize} / observed effective ${run.nativeDecodeCount > 0 ? run.effectiveBatchSize : 'unavailable'} sequences per decode; ${run.completed}/${run.requested} docs`,
      metrics: [
        { name: 'docs/s', value: formatMeasurement(run.documentsPerSecond, '', 2) },
        { name: 'tok/s', value: formatMeasurement(run.tokensPerSecond, '', 2) },
        { name: 'ms/doc', value: formatMeasurement(run.effectiveMsPerDocument, '', 2) },
        { name: 'Peak RAM (PSS)', value: formatBytes(run.samplePeakPssBytes) },
        { name: 'Peak temp', value: formatMeasurement(run.temperatureC.peak, 'C', 1) },
        { name: 'Energy/doc', value: formatMeasurement(run.energy.mwhPer100Documents == null ? null : run.energy.mwhPer100Documents / 100, 'mWh/doc', 6) },
      ],
      reason: [run.reason, run.error ? `${run.error.code}: ${run.error.message}` : null].filter(Boolean).join('\n'),
      energyReason: run.energy.reason ?? run.energy.energyReason ?? (run.energy.mwhPer100Documents == null ? 'Energy per document is unavailable; no reliable normalized energy estimate.' : null),
      details: [
        `Policy requested / effective: ${run.requestedPolicy.maxSequencesPerBatch} / ${run.effectivePolicy.maxSequencesPerBatch} sequences, ${run.requestedPolicy.maxTokensPerBatch} / ${run.effectivePolicy.maxTokensPerBatch} tokens. Fitting capacity ${run.capacitySequences}; chunk ${run.chunkSize}.`,
        `Loaded nBatch / nUbatch / nCtx / nCtxSeq: ${run.limits.nBatch} / ${run.limits.nUbatch} / ${run.limits.nCtx} / ${run.limits.nCtxSeq} tokens. Sequence limits ${run.limits.maxParallelSequences} / backend ${run.limits.backendMaxParallelSequences}; ${run.backendSequenceExecution}.`,
        `Attempted ${run.attempted}; failed ${run.failures}; cancelled ${run.cancelled}; skipped ${run.skipped}; unreported ${run.unreportedItems}. Native decodes ${run.nativeDecodeCount}.`,
        `Temperature initial / peak / final: ${[run.temperatureC.initial, run.temperatureC.peak, run.temperatureC.final].map(value => formatMeasurement(value, 'C', 1)).join(' / ')}`,
        `Thermal status initial / peak / final: ${[run.thermal.initial, run.thermal.peak, run.thermal.final].map(value => formatMeasurement(value, '', 0)).join(' / ')}`,
        ...(['initial', 'middle', 'final'] as const).map(phase => {
          const block = run.throughputBlocks.find(item => item.phase === phase);
          return `${phase === 'middle' ? 'Mid' : phase === 'initial' ? 'Initial' : 'Final'}: ${formatMeasurement(block?.documentsPerSecond, 'docs/s')} / ${formatMeasurement(block?.tokensPerSecond, 'tok/s')}`;
        }),
        run.throughputReason,
        `Energy confidence: ${run.energy.confidence}; resolution: ${run.energy.resolution}. Device-wide estimate including screen/system, not model-only power.`,
        `Charge: ${formatMeasurement(run.energy.mahPer100Documents, 'mAh/100 docs', 6)}. ${run.energy.chargeReason ?? ''}`,
        `Diagnostic samples ${run.sampleCount}; errors ${run.diagnosticErrors.length}. Sampled peaks may miss transients.`,
      ].filter(Boolean).join('\n'),
    })),
  })));
  readonly crossQuery = CROSS_QUERY;
  readonly crossDocuments = CROSS_DOCUMENTS;
  readonly bytes = formatBytes;
  readonly measure = formatMeasurement;
  readonly deviceSample = formatDeviceSample;
  readonly activeBenchmark = computed(() => this.state().busy === 'benchmark' ? this.state().benchmarks.at(-1) ?? null : null);
  readonly report = computed(() => buildReport(this.state()));
  readonly deviceText = computed(() => {
    const d = this.report().device;
    if (!d) return 'Device measurements unavailable. Sample asynchronously when native support is ready.';
    return [
      `${d.manufacturer ?? 'unavailable'} / ${d.model ?? 'unavailable'}`,
      `Android ${d.androidVersion ?? 'unavailable'} / SDK ${formatMeasurement(d['sdk'], '', 0)}`,
      `ABI: ${d.abi ?? 'unavailable'} / Supported: ${d.supportedAbis.join(', ')}`,
      `SoC: ${d.soc?.manufacturer ?? 'unavailable'} / ${d.soc?.model ?? 'unavailable'}`,
      `RAM total: ${formatBytes(d['totalRamBytes'])}`, `RAM available: ${formatBytes(d['availableRamBytes'])}`,
      `App PSS: ${formatBytes(d['appPssBytes'])}`, `RSS: ${formatBytes(d['rssBytes'])}`,
      `Native heap: ${formatBytes(d['nativeHeapBytes'])}`, `Java heap: ${formatBytes(d['javaHeapBytes'])}`,
      `Low memory: ${d.lowMemory ?? 'unavailable'} / Threshold: ${formatBytes(d['thresholdBytes'])}`,
      `Battery level: ${formatMeasurement(d['batteryLevel'], '%')}`,
      `Battery temperature: ${formatMeasurement(d['batteryTemperatureC'], 'C')}`,
      `Thermal status: ${formatMeasurement(d['thermalStatus'], '', 0)}`,
      `Sample time (Unix ms): ${formatMeasurement(d['timestamp'], 'ms', 0)}`,
    ].join('\n');
  });
  readonly installationText = computed(() => {
    const i = this.report().installation;
    const m = this.report().model;
    if (!i) return 'Official model metadata and storage measurements unavailable.';
    const last = i.metrics.lastAttempt;
    const download = i.metrics.lastDownload;
    return [
      `Official repository: ${i.source?.repository ?? 'unavailable'}`, `File: ${i.source?.filename ?? 'unavailable'}`,
      `Format: ${i.source?.format ?? 'unavailable'} / Revision: ${m?.revision ?? 'unavailable'}`,
      `Quantization: ${m?.quantization ?? 'unavailable'}`, `SHA-256: ${i.source?.sha256 ?? 'unavailable'}`,
      `Expected download: ${formatBytes(i['expectedBytes'])}`,
      `Required storage: ${formatBytes(i.requiredStorage?.['requiredBytes'])}`,
      `Required headroom: ${formatBytes(i.requiredStorage?.['headroomBytes'])}`,
      `Available storage: ${formatBytes(i['availableStorageBytes'])}`, `Installed size: ${formatBytes(i['installedBytes'])}`,
      `Storage category: ${i.storageCategory ?? 'not installed'}`,
      `Downloaded: ${formatBytes(i['downloadedBytes'])} / ${formatMeasurement(i['progressPercent'], '%')}`,
      `Verified: ${formatBytes(i['verifiedBytes'])} / ${formatMeasurement(i['verificationProgressPercent'], '%')}`,
      `Elapsed: ${formatSeconds(i['elapsedMs'])}`,
      `Recent / average: ${formatTransferRate(i['recentBytesPerSecond'])} / ${formatTransferRate(i['averageBytesPerSecond'])}`,
      `Attempts (download / verify / install / remove): ${['downloadAttempts', 'verificationAttempts', 'installAttempts', 'removeAttempts'].map(k => formatMeasurement(i.metrics[k], '', 0)).join(' / ')}`,
      `Failures / cancelled / interrupted: ${['failures', 'cancelled', 'interrupted'].map(k => formatMeasurement(i.metrics[k], '', 0)).join(' / ')}`,
      `Last download: ${download?.outcome ?? 'unavailable'} / TTFB: ${formatMeasurement(download?.['timeToFirstByteMs'], 'ms')}`,
      `Download duration: ${formatSeconds(download?.['downloadDurationMs'])} / Network: ${formatBytes(download?.['networkBytes'])}`,
      `Last download average: ${formatTransferRate(download?.['averageBytesPerSecond'])}`,
      `Last operation: ${last?.operation ?? 'unavailable'} / ${last?.outcome ?? 'unavailable'}`,
      `Verification / finalization / total: ${['verificationDurationMs', 'finalizationDurationMs', 'totalElapsedMs'].map(k => formatSeconds(last?.[k])).join(' / ')}`,
      `Storage before / after: ${formatBytes(last?.['availableStorageBeforeBytes'])} / ${formatBytes(last?.['availableStorageAfterBytes'])}`,
      `Last verification valid: ${i.metrics.lastVerification?.valid ?? 'unavailable'}`,
      `Persistence error: ${i.metrics.lastPersistenceError?.code ?? 'none reported'}`,
    ].join('\n');
  });
  readonly locked = computed(() => !!this.unavailable() || this.sampling() || this.confirmingBatch() || this.exporting() || !!this.state().busy || !!this.state().installer?.busy);
  readonly ready = computed(() => this.state().runtime === 'ready' && !this.locked());
  readonly errorText = computed(() => {
    const error = this.state().error ?? this.state().installer?.error;
    if (!error) return null;
    const safe = labError(error);
    return `${safe.code}: ${safe.message}${safe.actualTokens == null ? '' : ` Actual tokens: ${safe.actualTokens}; limit: ${safe.maxTokens ?? 'unavailable'}.`}`;
  });
  private environment: EmbeddingsEnvironment | null = null;
  private controller: EmbeddingsLabController | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor() { this.connect(); }

  ngOnDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  connect(): void {
    if (this.controller) return;
    try {
      const runtime = obtainEmbeddingsLabRuntime();
      this.environment = runtime.environment;
      this.controller = runtime.controller;
      this.unsubscribe = runtime.subscribe(state => this.state.set(state));
      this.unavailable.set(null);
    } catch (error) {
      const safe = labError(error);
      this.unavailable.set(`${safe.code}: ${safe.message}`);
    }
  }
  refresh(): void { this.controller?.refresh(); }
  async sample(): Promise<void> {
    if (!this.controller || this.sampling()) return;
    this.sampling.set(true);
    try { await this.controller.sampleDevice(); } finally { this.sampling.set(false); }
  }
  load(): void { void this.controller?.load(); }
  unload(): void { void this.controller?.unload(); }
  cancel(): void { this.controller?.cancel(); }
  cancelDownload(): void { this.controller?.cancelDownload(); }
  install(action: 'download' | 'verify' | 'install' | 'remove'): void { void this.controller?.installAction(action); }
  runSingle(): void { void this.controller?.single(this.input(), this.kind()); }
  warmUp(): void { void this.controller?.single('A deterministic warm-up document for the embeddings runtime.', 'document', true); }
  similarity(): void { void this.controller?.similarity(this.query(), this.documents()); }
  crossLanguage(): void { void this.controller?.similarity(CROSS_QUERY, CROSS_DOCUMENTS, true); }
  correctness(): void { void this.controller?.correctness(); }
  benchmark(count: 1 | 10 | 100 | 1000, cold = false, confirmed1000 = false): void {
    void this.controller?.benchmark({ mode: cold ? 'cold' : 'warm', size: this.size(), count, confirmed1000 });
  }
  async runBatch(fullMatrix: boolean, confirm: (message: string) => Promise<boolean>): Promise<void> {
    if (!this.controller || !this.ready() || (!fullMatrix && this.batchUnsupported())) return;
    const size = this.batchSize();
    const target = this.batchTarget();
    const count = this.batchCount();
    // Confirm total tier cost, not just the corpus size. Never start a default all-size suite.
    if (fullMatrix || count === 1000) {
      const plan = fullMatrix ? this.batchPlan().matrix : this.batchPlan().target;
      this.confirmingBatch.set(true);
      let accepted = false;
      try {
        accepted = await confirm(`${plan}\n${count === 1000 ? 'Sustained 1000 is battery heavy! ' : ''}This can take a long time, drain battery and heat the device. Safety checks may skip or stop tiers. Cancel waits for in-flight native work to drain.`);
      } finally { this.confirmingBatch.set(false); }
      if (!accepted || !this.ready()) return;
    }
    if (fullMatrix) await this.controller.batchComparison(size, count);
    else await this.controller.batchBenchmark(size, target, count);
  }
  setDocument(index: number, text: string): void {
    this.documents.update(documents => documents.map((value, i) => i === index ? text : value));
  }
  summary(result: VectorSummary): string {
    return [
      `${result.kind} | ${result.dimensions} finite dimensions | norm ${formatMeasurement(result.norm, '', 6)}`,
      `${result.tokenCount} actual tokens | ${formatMeasurement(result.inferenceDurationMs, 'ms')} inference | ${formatMeasurement(result.tokensPerMs, 'tokens/ms', 4)}`,
      `Warm before inference: ${result.warm ? 'yes' : 'no (first inference since load)'}`,
      `${result.modelId} | ${result.revision} | ${result.quantization}`,
      `First 12 (local display only): ${result.first12.map(value => value.toFixed(6)).join(', ')}`,
    ].join('\n');
  }
  benchmarkSummary(run: BenchmarkReport): string {
    return [
      `Completed / attempted: ${run.completed} / ${run.attempted}`,
      `Failures / cancelled / skipped: ${run.failures} / ${run.cancelled} / ${run.skipped}`,
      `Unreported items in rejected chunks: ${run.unreportedItems}`,
      `Actual tokens per document: ${formatMeasurement(run.actualTokens, '', 0)} / Target: ${formatMeasurement(run.targetTokens, '', 0)}`,
      `Tokenizer calls: ${run.tokenizerCalls}`,
      `Total tokens (completed results): ${formatMeasurement(run.totalTokens, 'tokens', 0)}`,
      `First inference warm: ${run.firstInferenceWarm ?? 'unavailable'} / Cold / warm counts: ${run.coldInferences} / ${run.warmInferences}`,
      `Total elapsed: ${formatSeconds(run.elapsedMs)}`,
      `Inference only: ${formatMeasurement(run.inferenceOnlyMs, 'ms')} / API elapsed: ${formatMeasurement(run.inferenceCallElapsedMs, 'ms')}`,
      `Diagnostics overhead: ${formatMeasurement(run.diagnosticsMs, 'ms')} / Tokenizer preparation: ${formatMeasurement(run.preparationMs, 'ms')}`,
      `Total minus measured inference: ${formatMeasurement(run.nonInferenceMs, 'ms')}`,
      `Latency count: ${run.latencyMs.count} / Total: ${formatMeasurement(run.latencyMs.total, 'ms')}`,
      `Latency mean / median / P95: ${[run.latencyMs.mean, run.latencyMs.median, run.latencyMs.p95].map(v => formatMeasurement(v, 'ms')).join(' / ')}`,
      `Throughput (total): ${formatMeasurement(run.documentsPerSecond, 'documents/s')}`,
      `Throughput (inference only): ${formatMeasurement(run.inferenceDocumentsPerSecond, 'documents/s')}`,
      `Token throughput (total elapsed): ${formatMeasurement(run.tokensPerSecond, 'tokens/s')}`,
      `Token throughput (inference only): ${formatMeasurement(run.inferenceTokensPerSecond, 'tokens/s')}`,
      formatDeviceSample(run.latestDevice),
      `PSS before / after: ${formatBytes(run.memoryBefore?.appPssBytes)} / ${formatBytes(run.memoryAfter?.appPssBytes)}`,
      `Observed sample peak PSS: ${formatBytes(run.samplePeakPssBytes)}`,
      `Device samples / errors: ${run.samples.length} / ${run.diagnosticErrors.length}`,
      `Battery temperature before / after: ${formatMeasurement(run.memoryBefore?.batteryTemperatureC, 'C')} / ${formatMeasurement(run.memoryAfter?.batteryTemperatureC, 'C')}`,
      `Thermal status before / after: ${formatMeasurement(run.memoryBefore?.thermalStatus, '', 0)} / ${formatMeasurement(run.memoryAfter?.thermalStatus, '', 0)}`,
    ].join('\n');
  }
  copy(): void {
    if (!this.environment) return;
    try { this.environment.copyText(humanReport(this.state())); this.notice.set('Privacy-filtered report copied.'); }
    catch { this.notice.set('Copy failed. Retry or export JSON.'); }
  }
  async export(): Promise<void> {
    if (!this.environment || this.exporting()) return;
    this.exporting.set(true);
    try { await this.environment.exportJson(serializeReport(this.state())); this.notice.set('JSON handed to the local Android share/save flow.'); }
    catch { this.notice.set('Export was cancelled or failed. Measurements are still available; retry export.'); }
    finally { this.exporting.set(false); }
  }
}
