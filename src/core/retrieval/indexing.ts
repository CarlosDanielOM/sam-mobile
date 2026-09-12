import type { EmbeddingOptions, EmbeddingResult, EmbeddingService } from '../embeddings/types';
import { contentHash } from './hash';
import { checkAbort, validateItem, validateVector, validateFilter } from './validation';
import { embeddingFingerprint, fingerprintKey, RetrievalError, type DiagnosticSink, type IndexableItem, type IndexRecord, type IndexRepository, type IndexingService, type IndexingReport, type LexicalIndex, type VectorIndex, type RetrievalFilter, type SourceRef } from './types';

export interface IndexingPolicy {
  /** Never downloads. Default leaves unloaded model alone. */
  loadInstalledModel: boolean;
  autoProcess: boolean;
  batchSize: number;
  batchMode: 'sequential' | 'true_batch';
  maxPending: number;
  maxWorkPerDrain: number;
  maxAdmissions: number;
}
const defaults: IndexingPolicy = { loadInstalledModel: false, autoProcess: false, batchSize: 1,
  batchMode: 'sequential', maxPending: 10000, maxWorkPerDrain: 64, maxAdmissions: 128 };
/** Process-lifetime coordinator. Durable pending rows are the queue, not UI state. */
export class LocalIndexingService implements IndexingService {
  readonly policy: IndexingPolicy;
  private mutationTail: Promise<unknown> = Promise.resolve();
  private admissions = 0;
  private draining = false;
  private scheduled = false;
  readonly repository: IndexRepository; readonly lexical: LexicalIndex; readonly vectors: VectorIndex;
  readonly embeddings: EmbeddingService; private diagnostic: DiagnosticSink;
  constructor(repository: IndexRepository, lexical: LexicalIndex, vectors: VectorIndex,
    embeddings: EmbeddingService, policy: Partial<IndexingPolicy> = {}, diagnostic: DiagnosticSink = () => {}) {
    this.repository=repository; this.lexical=lexical; this.vectors=vectors; this.embeddings=embeddings; this.diagnostic=diagnostic;
    this.policy = { ...defaults, ...policy };
    for (const key of ['batchSize','maxPending','maxWorkPerDrain','maxAdmissions'] as const)
      if (!Number.isSafeInteger(this.policy[key]) || this.policy[key] < 1) throw new RetrievalError('invalid_policy', 'Queue policy must have positive integer bounds.');
    if (this.policy.batchSize > 16 || this.policy.maxWorkPerDrain > 1000 || this.policy.maxAdmissions > 1024) throw new RetrievalError('invalid_policy', 'Queue policy exceeds safe limits.');
  }
  fingerprint() { return embeddingFingerprint(this.embeddings.getModelInfo()); }
  private emit(event: Parameters<DiagnosticSink>[0]) { try { this.diagnostic(event); } catch { /* Diagnostics never own completion. */ } }
  private async serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.admissions >= this.policy.maxAdmissions) throw new RetrievalError('queue_full', 'Index admission queue is full. Retry later.');
    this.admissions++;
    // Serialize short admission/deletion/requeue mutations, never inference or search.
    // This gives removeBySource a barrier against all previously admitted source writes.
    const next = this.mutationTail.catch(() => {}).then(work); this.mutationTail = next;
    try { return await next; } finally { this.admissions--; }
  }
  async index(item: IndexableItem, options: { signal?: AbortSignal } = {}): Promise<IndexRecord> {
    validateItem(item); checkAbort(options.signal);
    // Capture input before any asynchronous work; callers may reuse their object.
    const snapshot = JSON.parse(JSON.stringify(item)) as IndexableItem;
    return this.serial(item.id, async () => {
      checkAbort(options.signal);
      if (!(await this.repository.get(snapshot.id)) && (await this.getStatistics()).pending >= this.policy.maxPending)
        throw new RetrievalError('queue_full', 'Durable pending limit reached. Process or remove pending items first.');
      const record = await this.repository.stage(snapshot, contentHash(snapshot.content), this.fingerprint());
      this.emit({ event: 'index_staged', at: Date.now(), count: 1 });
      // Once staging commits, cancellation leaves a durable pending lexical projection.
      checkAbort(options.signal);
      await this.prepareLexical(record);
      const result = (await this.repository.get(record.id))!;
      if (result.vectorState !== 'ready') this.emit({ event: 'embedding_pending', at: Date.now(), count: 1 });
      this.schedule(); return result;
    });
  }
  async indexMany(items: IndexableItem[], options: { signal?: AbortSignal } = {}): Promise<IndexRecord[]> {
    if (items.length > 1000) throw new RetrievalError('batch_too_large', 'Submit at most 1000 items per admission batch.');
    items.forEach(validateItem); const results: IndexRecord[] = [];
    for (const item of items) { checkAbort(options.signal); results.push(await this.index(item, options)); }
    return results;
  }
  private async prepareLexical(record: IndexRecord): Promise<void> {
    if (record.lexicalState === 'ready') return;
    try { const start = Date.now(); if (await this.lexical.upsert(record)) this.emit({ event: 'lexical_ready', at: Date.now(), count: 1, durationMs: Date.now() - start }); }
    catch (error) { await this.failure(record, 'lexical', error); }
  }
  private async failure(record: IndexRecord, stage: 'lexical' | 'vector', error: any): Promise<void> {
    // Do not persist native messages: they can echo private source text.
    const code = typeof error?.code === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(error.code) ? error.code : `${stage}_failed`;
    await this.repository.fail(record, { stage, code, at: Date.now(), retryable: true });
    this.emit({ event: 'index_failed', at: Date.now(), code, count: 1 });
  }
  private schedule() {
    if (!this.policy.autoProcess || this.scheduled || this.draining || !this.embeddings.isLoaded()) return;
    this.scheduled = true;
    setTimeout(() => { this.scheduled = false; void this.drain().then(r => { if (r.attempted === this.policy.maxWorkPerDrain && r.ready) this.schedule(); }).catch(() => {}); }, 0);
  }
  async drain(options: { signal?: AbortSignal; maxItems?: number; filter?: RetrievalFilter } = {}): Promise<IndexingReport> {
    if (this.draining) throw new RetrievalError('indexing_busy', 'An indexing drain is already active.');
    validateFilter(options.filter);
    const maxItems = options.maxItems ?? this.policy.maxWorkPerDrain;
    if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 1000) throw new RetrievalError('invalid_limit', 'Drain limit must be 1–1000.');
    this.draining = true;
    const start = Date.now();
    const report: IndexingReport = { attempted: 0, ready: 0, failed: 0, pending: 0, elapsedMs: 0, embeddingMs: 0, lexicalMs: 0, vectorPersistenceMs: 0, itemsPerSecond: 0, cancelled: false };
    try {
      checkAbort(options.signal);
      let records = await this.repository.work(maxItems, options.filter);
      for (const record of records) {
        checkAbort(options.signal); const startLex = Date.now(); await this.prepareLexical(record); report.lexicalMs += Date.now() - startLex;
      }
      // Lexical repair must not regenerate an already compatible vector.
      records = records.filter(record => record.vectorState !== 'ready');
      if (!records.length) return report;
      if (!this.embeddings.isLoaded() && this.policy.loadInstalledModel) {
        try { await this.embeddings.load({ signal: options.signal }); }
        catch (error) { checkAbort(options.signal); this.emit({ event: 'embedding_pending', at: Date.now(), code: 'model_unavailable', count: records.length }); }
      }
      if (!this.embeddings.isLoaded()) { report.pending = records.length; return report; }
      const fingerprint = this.fingerprint();
      const embedOptions: EmbeddingOptions = { signal: options.signal, batchMode: this.policy.batchMode,
        batchingPolicy: { maxSequencesPerBatch: this.policy.batchSize, maxTokensPerBatch: 2048 } };
      const persist = async (record: IndexRecord, result: EmbeddingResult) => {
        checkAbort(options.signal);
        if (result.modelId !== fingerprint.modelId || result.revision !== fingerprint.revision || result.quantization !== fingerprint.quantization || result.dimensions !== fingerprint.dimensions
          || fingerprintKey(this.fingerprint()) !== fingerprintKey(fingerprint)) throw new RetrievalError('fingerprint_changed', 'Embedding configuration changed during indexing.');
        validateVector(result.vector, fingerprint);
        const started = Date.now(); const written = await this.vectors.upsert(record, result.vector, fingerprint);
        report.vectorPersistenceMs += Date.now() - started;
        if (written) { report.ready++; this.emit({ event: 'embedding_complete', at: Date.now(), count: 1 }); }
      };
      const single = async (record: IndexRecord) => {
        const t = Date.now(); let result: EmbeddingResult;
        try { result = await this.embeddings.embedDocument(record.content, embedOptions); }
        finally { report.embeddingMs += Date.now() - t; }
        await persist(record, result);
      };
      for (let i = 0; i < records.length; i += this.policy.batchSize) {
        checkAbort(options.signal); const batch = records.slice(i, i + this.policy.batchSize); report.attempted += batch.length;
        if (batch.length === 1) {
          try { await single(batch[0]); } catch (error) { checkAbort(options.signal); report.failed++; await this.failure(batch[0], 'vector', error); }
        } else {
          let results: EmbeddingResult[];
          const t = Date.now();
          try { results = await this.embeddings.embedDocuments(batch.map(r => r.content), embedOptions); }
          catch { checkAbort(options.signal); /* Isolate a bad document with individual retries. */ }
          finally { report.embeddingMs += Date.now() - t; }
          for (let j = 0; j < batch.length; j++) {
            try { if (results?.length === batch.length) await persist(batch[j], results[j]); else await single(batch[j]); }
            catch (error) { checkAbort(options.signal); report.failed++; await this.failure(batch[j], 'vector', error); }
          }
        }
      }
      return report;
    } catch (error) {
      if (options.signal?.aborted || (error as any)?.code === 'cancelled') { report.cancelled = true; return report; }
      throw error;
    } finally {
      this.draining = false; report.elapsedMs = Date.now() - start;
      report.itemsPerSecond = report.elapsedMs ? report.ready * 1000 / report.elapsedMs : 0;
    }
  }
  remove(id: string) { return this.serial(id, () => this.repository.remove(id)); }
  removeBySource(source: SourceRef) { return this.serial('source', () => this.repository.removeBySource(source)); }
  async reindex(options: { ids?: string[]; filter?: RetrievalFilter; staleOnly?: boolean } = {}) {
    validateFilter(options.filter); const count = await this.serial('reindex', () => this.repository.requeue(this.fingerprint(), options));
    this.emit({ event: 'reindex', at: Date.now(), count }); this.schedule(); return count;
  }
  getStatus(id: string) { return this.repository.get(id); }
  getStatistics(filter?: RetrievalFilter) { validateFilter(filter); return this.repository.statistics(this.fingerprint(), filter); }
}
