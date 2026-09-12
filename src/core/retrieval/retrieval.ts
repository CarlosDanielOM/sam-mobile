import type { EmbeddingService } from '../embeddings/types';
import { checkAbort, validateAccess, validateFilter, validateVector } from './validation';
import { embeddingFingerprint, fingerprintKey, RetrievalError, type Candidate, type DiagnosticSink, type IndexRepository, type LexicalIndex, type VectorIndex, type RetrievalQuery, type RetrievalService, type RetrievalResult, type SearchResponse } from './types';

export const DEFAULT_RRF = { k: 60, lexicalWeight: 1, vectorWeight: 1 };
export function fuse(lexical: Candidate[], vector: Candidate[], options = DEFAULT_RRF) {
  const merged = new Map<string, { id: string; revision: string; score: number; lexical?: Candidate; vector?: Candidate }>();
  for (const [kind, candidates, weight] of [['lexical', lexical, options.lexicalWeight], ['vector', vector, options.vectorWeight]] as const) {
    const seen = new Set<string>();
    for (const c of candidates) {
      if (seen.has(c.id)) continue; seen.add(c.id);
      const old = merged.get(c.id);
      // Concurrent content updates may produce two revisions; never fuse incompatible projections.
      if (old && old.revision !== c.revision) continue;
      const row = old ?? { id: c.id, revision: c.revision, score: 0 };
      row[kind] = c; row.score += weight / (options.k + c.rank); merged.set(c.id, row);
    }
  }
  return [...merged.values()].sort((a,b) => b.score - a.score || compareId(a.id,b.id));
}
export function compareId(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
export class LocalRetrievalService implements RetrievalService {
  private repository: IndexRepository; private lexical: LexicalIndex; private vectors: VectorIndex;
  private embeddings: EmbeddingService; private diagnostic: DiagnosticSink;
  constructor(repository: IndexRepository, lexical: LexicalIndex, vectors: VectorIndex,
    embeddings: EmbeddingService, diagnostic: DiagnosticSink = () => {}) {
    this.repository=repository; this.lexical=lexical; this.vectors=vectors; this.embeddings=embeddings; this.diagnostic=diagnostic;
  }
  private emit(event: Parameters<DiagnosticSink>[0]) { try { this.diagnostic(event); } catch {} }
  async search(query: RetrievalQuery): Promise<SearchResponse> {
    const start = Date.now(); checkAbort(query.signal); validateAccess(query.access); validateFilter(query.filter);
    if (!['lexical','vector','hybrid'].includes(query.mode) || typeof query.text !== 'string' || query.text.length > 8192) throw new RetrievalError('invalid_query', 'Invalid query text or mode.');
    const limit = query.limit ?? 10, candidateLimit = query.candidateLimit ?? Math.max(50, limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(candidateLimit) || candidateLimit < limit || candidateLimit > 500) throw new RetrievalError('invalid_limit', 'Result limit must be 1–100; candidates must cover it and be at most 500.');
    const rrf = { ...DEFAULT_RRF, ...query.rrf };
    if (!Number.isFinite(rrf.k) || rrf.k < 1 || rrf.k > 10000 || !Number.isFinite(rrf.lexicalWeight) || !Number.isFinite(rrf.vectorWeight) || rrf.lexicalWeight < 0 || rrf.vectorWeight < 0 || rrf.lexicalWeight + rrf.vectorWeight <= 0) throw new RetrievalError('invalid_rrf', 'Invalid RRF configuration.');
    // Snapshot caller inputs before asynchronous work; access remains authoritative throughout.
    const options = { access: JSON.parse(JSON.stringify(query.access)), filter: query.filter ? JSON.parse(JSON.stringify(query.filter)) : undefined, limit: candidateLimit, signal: query.signal };
    const response: SearchResponse = { requestedMode: query.mode, actualMode: query.mode, results: [], degradedReasons: [], durationMs: 0,
      timings: { queryEmbeddingMs: 0, lexicalMs: 0, vectorMs: 0, fusionMs: 0 }, candidates: { lexical: 0, vector: 0, merged: 0, final: 0 },
      backends: { lexical: this.lexical.backend, vector: this.vectors.backend }, embeddingFingerprint: null, rrf: query.mode === 'hybrid' ? rrf : null };
    this.emit({ event: 'search_start', at: start, requestedMode: query.mode });
    let lexical: Candidate[] = [], vector: Candidate[] = [];
    if (query.text.trim()) {
      if (query.mode !== 'vector') {
        const t = Date.now();
        try { lexical = await this.lexical.search(query.text, options); }
        catch (error) {
          checkAbort(query.signal);
          if (query.mode !== 'hybrid' || !query.allowDegraded) throw new RetrievalError('lexical_unavailable', 'Lexical search failed.');
          response.actualMode = 'vector'; response.degradedReasons.push('lexical_unavailable');
        } finally { response.timings.lexicalMs = Date.now() - t; }
      }
      if (query.mode !== 'lexical') {
        try {
          if (!this.embeddings.isLoaded()) throw new RetrievalError('embedding_unavailable', 'Load the installed embedding model explicitly before vector retrieval.');
          const f = embeddingFingerprint(this.embeddings.getModelInfo());
          const t = Date.now(); let embedded;
          try { embedded = await this.embeddings.embedQuery(query.text, { signal: query.signal }); }
          finally { response.timings.queryEmbeddingMs = Date.now() - t; }
          checkAbort(query.signal);
          if (embedded.modelId !== f.modelId || embedded.revision !== f.revision || embedded.quantization !== f.quantization || embedded.dimensions !== f.dimensions || fingerprintKey(embeddingFingerprint(this.embeddings.getModelInfo())) !== fingerprintKey(f)) throw new RetrievalError('fingerprint_changed', 'Embedding configuration changed during retrieval.');
          validateVector(embedded.vector, f); response.embeddingFingerprint = f;
          const v = Date.now();
          try { vector = await this.vectors.search(embedded.vector, f, options); }
          finally { response.timings.vectorMs = Date.now() - v; }
        } catch (error) {
          checkAbort(query.signal);
          const code = error instanceof RetrievalError ? error.code : 'vector_unavailable';
          if (query.mode !== 'hybrid' || !query.allowDegraded || response.actualMode === 'vector') throw new RetrievalError(code, 'Vector retrieval is unavailable.');
          response.actualMode = 'lexical'; response.degradedReasons.push(code); response.embeddingFingerprint = null;
        }
      }
    }
    checkAbort(query.signal); const fusionStart = Date.now();
    response.candidates.lexical = lexical.length; response.candidates.vector = vector.length;
    const merged = response.actualMode === 'hybrid' ? fuse(lexical, vector, rrf) :
      (response.actualMode === 'lexical' ? lexical : vector).map(c => ({ id: c.id, revision: c.revision, score: c.score,
        lexical: response.actualMode === 'lexical' ? c : undefined, vector: response.actualMode === 'vector' ? c : undefined }));
    response.candidates.merged = merged.length;
    const records = new Map((await this.repository.getMany(merged.map(c => c.id), options.access, options.filter)).map(r => [r.id, r]));
    for (const candidate of merged) {
      const record = records.get(candidate.id);
      // Final access/filter check is inside the repository; revision/readiness guards handle concurrent writes.
      if (!record || record.revision !== candidate.revision || (candidate.lexical && record.lexicalState !== 'ready')
        || (candidate.vector && (record.vectorState !== 'ready' || !record.embeddingFingerprint || fingerprintKey(record.embeddingFingerprint) !== fingerprintKey(response.embeddingFingerprint!)))) continue;
      const result: RetrievalResult = { item: record, rank: response.results.length + 1, score: candidate.score, mode: response.actualMode };
      if (candidate.lexical) result.lexical = { rank: candidate.lexical.rank, score: candidate.lexical.score, scoreKind: candidate.lexical.scoreKind };
      if (candidate.vector) result.vector = { rank: candidate.vector.rank, similarity: candidate.vector.score, scoreKind: candidate.vector.scoreKind, fingerprint: response.embeddingFingerprint! };
      response.results.push(result); if (response.results.length === limit) break;
    }
    checkAbort(query.signal);
    response.timings.fusionMs = Date.now() - fusionStart; response.candidates.final = response.results.length;
    response.durationMs = Date.now() - start;
    this.emit({ event: 'search_complete', at: Date.now(), durationMs: response.durationMs, requestedMode: query.mode, actualMode: response.actualMode,
      lexicalCandidates: lexical.length, vectorCandidates: vector.length, count: response.results.length });
    return response;
  }
}
