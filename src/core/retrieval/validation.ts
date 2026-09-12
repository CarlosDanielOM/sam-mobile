import { RetrievalError, type AccessScope, type IndexableItem, type RetrievalAccess, type RetrievalFilter, type EmbeddingFingerprint } from './types';
const name = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/;
export function validName(value: unknown): value is string { return typeof value === 'string' && value.length <= 128 && name.test(value); }
export function validScope(scope: AccessScope): boolean {
  return !!scope && validName(scope.kind) && typeof scope.key === 'string' && scope.key.length > 0 && scope.key.length <= 256 && !/[\u0000-\u001f]/.test(scope.key)
    && (scope.kind !== 'global' || scope.key === '*');
}
export function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw new RetrievalError('cancelled', 'Operation cancelled.'); }
export function validateAccess(access: RetrievalAccess): void {
  if (!access || !Array.isArray(access.grants) || access.grants.length > 64 || !access.grants.every(validScope)) throw new RetrievalError('invalid_access', 'Authoritative valid access grants are required.');
}
export function allowed(item: IndexableItem, access: RetrievalAccess): boolean {
  return validScope(item.scope) && !!access?.grants?.some(s => validScope(s) && s.kind === item.scope.kind && s.key === item.scope.key);
}
export function validateItem(item: IndexableItem): void {
  if (!item || typeof item.id !== 'string' || !item.id.length || item.id.length > 512 || /\u0000/.test(item.id)
    || !validName(item.namespace) || !validName(item.type) || !validName(item.source?.system) || !validName(item.source?.type)
    || typeof item.source?.id !== 'string' || !item.source.id.length || item.source.id.length > 512 || /\u0000/.test(item.source.id)
    || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 100000 || /\u0000/.test(item.content)
    || !Number.isSafeInteger(item.createdAt) || !Number.isSafeInteger(item.updatedAt) || item.createdAt < 0 || item.updatedAt < item.createdAt
    || !validScope(item.scope) || (item.projectionVersion !== undefined && (!Number.isSafeInteger(item.projectionVersion) || item.projectionVersion < 1))) {
    throw new RetrievalError('invalid_item', 'Invalid identity, namespace, source, text, timestamps, scope or projection version.');
  }
  if (item.metadata !== undefined) {
    const visit = (value: unknown, depth: number): boolean => depth < 20 && (value === null || typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value)) || (Array.isArray(value) && value.every(v => visit(v, depth + 1)))
      || (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(v => visit(v, depth + 1))));
    if (!item.metadata || Array.isArray(item.metadata) || typeof item.metadata !== 'object' || !visit(item.metadata, 0) || JSON.stringify(item.metadata).length > 65536)
      throw new RetrievalError('invalid_metadata', 'Metadata must be a bounded JSON object.');
  }
}
export function validateFilter(filter?: RetrievalFilter): void {
  if (!filter) return;
  if ((filter.namespaces && (!Array.isArray(filter.namespaces) || filter.namespaces.length > 64 || !filter.namespaces.every(n => validName(n?.value) && (n.subtree === undefined || typeof n.subtree === 'boolean'))))
    || (filter.types && (!Array.isArray(filter.types) || filter.types.length > 64 || !filter.types.every(validName)))
    || (filter.scopes && (!Array.isArray(filter.scopes) || filter.scopes.length > 64 || !filter.scopes.every(validScope)))
    || (filter.source?.system !== undefined && !validName(filter.source.system)) || (filter.source?.type !== undefined && !validName(filter.source.type))
    || (filter.source?.id !== undefined && (typeof filter.source.id !== 'string' || !filter.source.id.length || filter.source.id.length > 512))) throw new RetrievalError('invalid_filter', 'Invalid filter.');
  for (const range of [filter.createdAt, filter.updatedAt]) if (range && ((range.from !== undefined && (!Number.isSafeInteger(range.from) || range.from < 0))
    || (range.to !== undefined && (!Number.isSafeInteger(range.to) || range.to < 0)) || (range.from !== undefined && range.to !== undefined && range.from > range.to))) throw new RetrievalError('invalid_filter', 'Invalid time range.');
}
export function matches(item: IndexableItem, filter?: RetrievalFilter): boolean {
  if (!filter) return true;
  return (!filter.namespaces || filter.namespaces.some(n => item.namespace === n.value || (n.subtree && item.namespace.startsWith(n.value + '.'))))
    && (!filter.types || filter.types.includes(item.type))
    && (!filter.scopes || filter.scopes.some(s => s.kind === item.scope.kind && s.key === item.scope.key))
    && (!filter.source || Object.entries(filter.source).every(([k, v]) => item.source[k] === v))
    && [ ['createdAt', filter.createdAt], ['updatedAt', filter.updatedAt] ].every(([key, range]: any) => !range || ((range.from === undefined || item[key] >= range.from) && (range.to === undefined || item[key] <= range.to)));
}
export function validateVector(vector: readonly number[], f: EmbeddingFingerprint): void {
  if (!f || typeof f.modelId !== 'string' || !f.modelId || typeof f.revision !== 'string' || !f.revision || typeof f.quantization !== 'string' || typeof f.backendRevision !== 'string' || typeof f.preprocessing !== 'string' || !f.preprocessing || f.format !== 'float32_le_v1' || typeof f.normalized !== 'boolean') throw new RetrievalError('invalid_fingerprint', 'Invalid embedding fingerprint.');
  if (!Number.isSafeInteger(f.dimensions) || f.dimensions < 1 || f.dimensions > 16384 || vector.length !== f.dimensions || !vector.every(Number.isFinite)) throw new RetrievalError('invalid_vector', 'Vector dimensions or values are invalid.');
  let norm = 0; for (const v of vector) norm += v * v;
  if (!Number.isFinite(norm) || norm <= 0 || (f.normalized && Math.abs(norm - 1) > 0.01)) throw new RetrievalError('invalid_vector', 'Vector normalization is invalid.');
}
/** IEEE 754 Float32, explicit little endian; 1024 dimensions = 4096 raw bytes. */
export function encodeVector(vector: readonly number[], f: EmbeddingFingerprint): Uint8Array {
  validateVector(vector, f); const bytes = new Uint8Array(vector.length * 4); const view = new DataView(bytes.buffer);
  vector.forEach((v, i) => view.setFloat32(i * 4, v, true));
  // Float32 conversion can overflow/underflow even when input doubles are finite.
  validateVector(Array.from({length:vector.length},(_,i)=>view.getFloat32(i*4,true)),f); return bytes;
}
export function decodeVector(bytes: Uint8Array, f: EmbeddingFingerprint): number[] {
  if (bytes.byteLength !== f.dimensions * 4) throw new RetrievalError('invalid_vector', 'Invalid vector byte length.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = Array.from({ length: f.dimensions }, (_, i) => view.getFloat32(i * 4, true)); validateVector(vector, f); return vector;
}
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (!a.length || a.length !== b.length) throw new RetrievalError('invalid_vector', 'Vectors must have equal nonzero dimensions.');
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) throw new RetrievalError('invalid_vector', 'Nonfinite vector.'); dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  if (!aa || !bb || !Number.isFinite(aa * bb)) throw new RetrievalError('invalid_vector', 'Invalid vector norm.');
  return Math.max(-1, Math.min(1, dot / Math.sqrt(aa * bb)));
}
/** Literal Unicode terms OR quoted phrases. No caller FTS operators reach SQLite. */
export function lexicalExpression(text: string): string {
  const parts: string[] = [];
  for (const match of text.matchAll(/"([^"]*)"|([^\s"]+)/gu)) {
    const words = (match[1] ?? match[2]).match(/[\p{L}\p{N}]+/gu) ?? [];
    if (words.length) parts.push('"' + words.join(' ') + '"');
    if (parts.length >= 64) break;
  }
  return parts.join(' OR ');
}
