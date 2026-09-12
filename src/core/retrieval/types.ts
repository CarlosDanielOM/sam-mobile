import type { EmbeddingModelInfo } from '../embeddings/types';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export interface SourceRef { system: string; type: string; id: string }
/** Grants are issued by the trusted caller boundary, never taken from a search form. */
export interface AccessScope { kind: string; key: string }
export interface RetrievalAccess { grants: readonly AccessScope[] }
export interface IndexableItem {
  id: string;
  namespace: string;
  type: string;
  source: SourceRef;
  content: string;
  createdAt: number;
  updatedAt: number;
  /** Required: there is no implicit globally visible default. */
  scope: AccessScope;
  metadata?: JsonObject;
  projectionVersion?: number;
}
export interface EmbeddingFingerprint {
  modelId: string;
  revision: string;
  quantization: string;
  dimensions: number;
  backendRevision: string;
  format: 'float32_le_v1';
  preprocessing: string;
  normalized: boolean;
}
export interface IndexFailure { stage: 'lexical' | 'vector'; code: string; at: number; retryable: boolean }
export interface IndexRecord extends IndexableItem {
  contentHash: string;
  revision: string;
  indexedAt: number;
  schemaVersion: number;
  projectionVersion: number;
  lexicalState: 'pending' | 'ready' | 'failed';
  vectorState: 'pending' | 'ready' | 'stale' | 'failed';
  embeddingFingerprint: EmbeddingFingerprint | null;
  failure: IndexFailure | null;
}
export interface RetrievalFilter {
  namespaces?: { value: string; subtree?: boolean }[];
  types?: string[];
  source?: { system?: string; type?: string; id?: string };
  createdAt?: { from?: number; to?: number };
  updatedAt?: { from?: number; to?: number };
  scopes?: AccessScope[];
}
export type RetrievalMode = 'lexical' | 'vector' | 'hybrid';
export interface RetrievalQuery {
  text: string;
  mode: RetrievalMode;
  access: RetrievalAccess;
  filter?: RetrievalFilter;
  limit?: number;
  candidateLimit?: number;
  allowDegraded?: boolean;
  signal?: AbortSignal;
  rrf?: { k?: number; lexicalWeight?: number; vectorWeight?: number };
}
export interface Candidate {
  id: string;
  revision: string;
  score: number;
  rank: number;
  scoreKind: string;
}
export interface RetrievalResult {
  item: IndexRecord;
  rank: number;
  score: number;
  mode: RetrievalMode;
  lexical?: { rank: number; score: number; scoreKind: string };
  vector?: { rank: number; similarity: number; scoreKind: string; fingerprint: EmbeddingFingerprint };
}
export interface SearchResponse {
  requestedMode: RetrievalMode;
  actualMode: RetrievalMode;
  results: RetrievalResult[];
  degradedReasons: string[];
  durationMs: number;
  timings: { queryEmbeddingMs: number; lexicalMs: number; vectorMs: number; fusionMs: number };
  candidates: { lexical: number; vector: number; merged: number; final: number };
  backends: { lexical: string; vector: string };
  embeddingFingerprint: EmbeddingFingerprint | null;
  rrf: { k: number; lexicalWeight: number; vectorWeight: number } | null;
}
export interface IndexStatistics {
  total: number; lexical: number; vectors: number; compatible: number;
  pending: number; stale: number; failed: number; vectorBytes: number;
  databaseBytes: number; databaseAllocatedBytes: number; averageVectorBytes: number;
  lexicalBackend: string; vectorBackend: string;
}
export interface SearchOptions { access: RetrievalAccess; filter?: RetrievalFilter; limit: number; signal?: AbortSignal }
export interface LexicalIndex {
  readonly backend: string;
  upsert(record: IndexRecord): Promise<boolean>;
  remove(id: string): Promise<void>;
  search(text: string, options: SearchOptions): Promise<Candidate[]>;
}
export interface VectorIndex {
  readonly backend: string;
  upsert(record: IndexRecord, vector: readonly number[], fingerprint: EmbeddingFingerprint): Promise<boolean>;
  remove(id: string): Promise<void>;
  search(vector: readonly number[], fingerprint: EmbeddingFingerprint, options: SearchOptions): Promise<Candidate[]>;
}
/** All completion writes must compare revision; source deletion never occurs here. */
export interface IndexRepository {
  stage(item: IndexableItem, hash: string, fingerprint: EmbeddingFingerprint): Promise<IndexRecord>;
  get(id: string): Promise<IndexRecord | null>;
  getMany(ids: string[], access: RetrievalAccess, filter?: RetrievalFilter): Promise<IndexRecord[]>;
  work(limit: number, filter?: RetrievalFilter): Promise<IndexRecord[]>;
  fail(record: IndexRecord, failure: IndexFailure): Promise<void>;
  remove(id: string): Promise<void>;
  removeBySource(source: SourceRef): Promise<number>;
  requeue(fingerprint: EmbeddingFingerprint, options: { ids?: string[]; filter?: RetrievalFilter; staleOnly?: boolean }): Promise<number>;
  statistics(fingerprint: EmbeddingFingerprint, filter?: RetrievalFilter): Promise<IndexStatistics>;
}
export interface IndexingService {
  index(item: IndexableItem, options?: { signal?: AbortSignal }): Promise<IndexRecord>;
  indexMany(items: IndexableItem[], options?: { signal?: AbortSignal }): Promise<IndexRecord[]>;
  drain(options?: { signal?: AbortSignal; maxItems?: number; filter?: RetrievalFilter }): Promise<IndexingReport>;
  remove(id: string): Promise<void>;
  removeBySource(source: SourceRef): Promise<number>;
  reindex(options?: { ids?: string[]; filter?: RetrievalFilter; staleOnly?: boolean }): Promise<number>;
  getStatus(id: string): Promise<IndexRecord | null>;
  getStatistics(filter?: RetrievalFilter): Promise<IndexStatistics>;
}
export interface IndexingReport {
  attempted: number; ready: number; failed: number; pending: number;
  elapsedMs: number; embeddingMs: number; lexicalMs: number; vectorPersistenceMs: number;
  itemsPerSecond: number; cancelled: boolean;
}
export interface RetrievalService { search(query: RetrievalQuery): Promise<SearchResponse> }
export interface RetrievalDiagnostic {
  event: 'index_staged' | 'lexical_ready' | 'embedding_pending' | 'embedding_complete' | 'index_failed' | 'search_start' | 'search_complete' | 'reindex';
  at: number; count?: number; durationMs?: number; code?: string;
  requestedMode?: RetrievalMode; actualMode?: RetrievalMode;
  lexicalCandidates?: number; vectorCandidates?: number;
}
export type DiagnosticSink = (event: RetrievalDiagnostic) => void;
export class RetrievalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'RetrievalError'; }
}
export function embeddingFingerprint(info: EmbeddingModelInfo, preprocessing = 'embedding_service_document_v1'): EmbeddingFingerprint {
  return { modelId: info.modelId, revision: info.revision, quantization: info.quantization,
    dimensions: info.dimensions, backendRevision: info.backendRevision ?? 'unspecified',
    format: 'float32_le_v1', preprocessing, normalized: true };
}
export function fingerprintKey(f: EmbeddingFingerprint): string {
  return JSON.stringify([f.modelId, f.revision, f.quantization, f.dimensions, f.backendRevision,
    f.format, f.preprocessing, f.normalized]);
}
