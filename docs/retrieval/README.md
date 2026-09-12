# Local indexing and retrieval

SAM now has a reusable, local-first searchable projection and a dedicated **Menu → Retrieval Lab**. Its only producer is the lab. Chat, sessions, provider prompts, tool execution, memory and context construction do not call it.

## Architecture and integration

The existing persistence architecture is a process singleton: `persistence()` selects `SqliteStore` on Android and `MemoryStore` in non-Android tests. Android uses framework `SQLiteDatabase`, application context, `sam.db`, parameter binding, explicit cursor cleanup, and transactional forward migrations tracked in `schema_migrations`. The former current schema was version 5. Session/message/generation/telemetry repositories remain authoritative and unchanged.

Migration **6** adds `retrieval_items`, `retrieval_vectors`, `retrieval_backend`, supporting indexes, and `retrieval_lab_sources`. The last table belongs exclusively to the developer lab and holds its durable fixture source data. There are no foreign keys from the generic projection into source tables, so removing index records cannot cascade into SAM source data.

`SqliteStore.prepareRetrievalDatabase()` runs the existing migration owner before the retrieval worker opens its own connection to the same database file. The worker does not introduce another database or another migration runner. Capability-dependent FTS DDL and its backend/version marker are committed together on the first retrieval initialization. No model is loaded, downloaded, or reembedded during initialization.

The process-level runtime reuses `getEmbeddingsEnvironment().service`, including its existing native admission queue and background inference. Neither the embedding engine, installer, native library nor Q8 AAR was modified or rebuilt. Retrieval does not use `PolicyEngine`: tool execution authority and information visibility are distinct contracts.

## Public core contracts

Import platform-independent contracts from `src/core/retrieval/index.ts`:

- `IndexableItem`, `IndexRecord`, `SourceRef`, `AccessScope`, `RetrievalAccess`.
- `IndexingService`: `index`, `indexMany`, `drain`, `remove`, `removeBySource`, `reindex`, `getStatus`, `getStatistics`.
- `IndexRepository`, `LexicalIndex`, `VectorIndex` storage interfaces.
- `RetrievalService.search(RetrievalQuery): Promise<SearchResponse>`.
- `RetrievalResult`, embedding fingerprints, structured errors and content-free diagnostics.

Core contains no NativeScript, SQLite or Android dependencies. The SQLite implementation lives alongside the other persistence adapters. Android composition is opt-in through `obtainRetrievalRuntime()`; a future server may replace services/repositories/backends without changing retrieval callers. There is no server transport in this change.

```ts
const item: IndexableItem = {
  id: 'document-projection:123',
  namespace: 'documents.personal',
  type: 'document',
  source: { system: 'documents', type: 'record', id: '123' },
  content: 'Searchable projection of an independently durable source.',
  createdAt: 1000,
  updatedAt: 2000,
  scope: { kind: 'agent', key: 'sam' },
  projectionVersion: 1,
  metadata: { title: 'Example' },
};
// The source repository must commit its own source first.
await indexing.index(item); // durable admission + lexical projection, no inference wait
await indexing.drain({ maxItems: 64, signal }); // explicitly scheduled background work
const response = await retrieval.search({
  text: 'Find my example', mode: 'hybrid', limit: 10, candidateLimit: 50,
  access: trustedCallerAccess, // minted by your application boundary, never a user form
  filter: { namespaces: [{ value: 'documents', subtree: true }] },
  allowDegraded: true, signal,
});
```

### Identity, provenance and validation

Index identity (`id`) is distinct from source identity (`system/type/id`). An index ID cannot be reassigned to another source. The namespace/type/source tuple is unique; a repeated projection cannot create duplicate index IDs. Namespace and type values are extensible, bounded lowercase dotted identifiers, not a closed enum. IDs and scope keys are opaque bounded strings. Searchable content, timestamps, JSON metadata and projection versions are validated; older source timestamps cannot replace a newer projection.

Each durable record retains content, SHA-256 of UTF-8 content, a completion revision token, source creation/change timestamps, indexing timestamp, projection version, index schema version, scope, metadata, modality states, embedding fingerprint and the latest structured failure. Hash equality is also checked against actual content. Metadata-only changes preserve the vector revision and do not regenerate embeddings. A projection-version change invalidates vectors even if text is unchanged.

### Access and filters

There is **no implicit global visibility**. Every item requires `{ kind, key }`; every search requires authoritative `grants`. A global item uses `{ kind: 'global', key: '*' }` and is visible only when that grant is explicitly present. Extensible session, agent and subsystem scopes use the same matching mechanism. Malformed scope/grant data fails closed. Index administration APIs are trusted producer/operator APIs, not read authorization endpoints.

All modalities apply access grants and filters before retaining top candidates. The final record fetch repeats access/filter checks and verifies revision/readiness. Scope filters only narrow grants. Namespaces support exact matching or descendants separated by a dot: `memory.semantic` belongs to `memory`, `memory2` does not. Filters also cover types, source system/type/id, inclusive created/updated time ranges and exact scope pairs. Empty filter arrays match nothing. There is no raw SQL or arbitrary metadata expression API.

### Lifecycle, queue and consistency

Lexical state is `pending | ready | failed`; vector state is `pending | ready | stale | failed`. A valid lexical projection survives vector failures. Pending rows are the durable queue: process death cannot strand an ephemeral RUNNING lease. An interrupted operation can be explicitly drained after restart.

Index admission and short delete/requeue mutations are serialized and bounded (128 admissions by default). Embedding inference and retrieval do not hold this mutation queue. Only one drain runs per coordinator; another drain receives `indexing_busy`. Default drains select at most 64 records; an explicit bounded drain may select up to 1,000. New pending admission defaults to a 10,000-row limit. `indexMany` accepts at most 1,000 records and applies backpressure by awaiting durable admission, not inference.

The default policy is `autoProcess: false`, `loadInstalledModel: false`, batch size **1**, sequential batch mode. Consumers may explicitly enable bounded automatic processing while the process/model are available, or allow loading an already installed model. No policy downloads models or provides guaranteed execution while Android suspends/kills the app. There is no WorkManager or foreground service added here.

Batch sizes up to 16 are configurable. Multiple documents use the existing `embedDocuments()` contract. A failed batch is retried individually to isolate bad records; embedding duration includes the failed attempt and individual retry costs. The implementation assumes neither parallel native execution nor a throughput benefit from larger batches. The native `serial_ubatches` behavior remains unchanged.

Content updates commit a new revision and make old vectors ineligible immediately. Lexical repair follows admission. Successful vector persistence atomically replaces the BLOB and marks that revision ready. Every completion/failure write checks the revision; late work cannot overwrite new content or resurrect deleted/recreated IDs. The previous vector bytes may remain stored for safe replacement but cannot participate in retrieval. A cancelled operation leaves durable pending/stale work and preserves committed projections. Failed rows require explicit `reindex()`/Retry; drains do not spin on failures.

`remove(id)` and `removeBySource(ref)` remove metadata, FTS rows, vectors and the row-owned queue/failure state, idempotently. Source-wide removal waits for previously admitted writes. Later producer submissions may index the source again; source ownership must stop submissions when its source is deleted. `reindex({ ids, filter, staleOnly })` invalidates selected completion revisions and requeues them. No full model migration is scheduled on launch.

### Fingerprint and vector backend

Each vector stores a canonical compatibility key containing model ID, revision, quantization, dimensions, backend revision, `float32_le_v1`, document-preprocessing version, and normalization expectation. The current adapter naturally supplies LFM2.5 Q8_0/1024 metadata; the retrieval backend has no LFM-specific prefix logic. Changing any compatibility field makes existing vectors detectably stale. Statistics distinguish stored/compatible/stale/pending/failed vectors, and selective reindexing can repair them. Counts may overlap: a pending replacement can still retain physically stored stale bytes.

There was no compatible vector extension in the existing Android framework SQLite stack. The selected backend is **`exact_flat`**, an exact cosine scan, **not ANN**. No native extension, custom HNSW, or native model rebuild was introduced. Vectors are IEEE-754 Float32 **little-endian BLOBs**, never JSON database values. A 1024-dimensional vector is exactly **4,096 raw bytes**. IPC may carry numeric arrays; durable storage does not.

Dimensions, finite values, nonzero norm, Float32 representability and expected unit normalization (squared-norm tolerance 0.01) are checked. Scoring explicitly computes cosine (`dot / (norm(a) * norm(b))`), even for nearly unit vectors. Wrong fingerprints cannot be compared, and malformed stored vectors fail the modality instead of silently entering rankings.

All Android BLOB reads/writes and distance arithmetic run in the dedicated NativeScript worker. Exact scans use the fingerprint/ID index and keyset pages of 64; only bounded top candidates are retained. Worker RPC has bounded admission, cooperative cancellation, structured sanitized errors and its own connection. Queued work can be cancelled; an individual synchronous SQLite statement is not preemptible. FTS4 matching and vector scans yield between pages. The native embedding service separately owns inference cancellation.

### Lexical backend and hybrid ranking

First initialization creates a real temporary FTS5 table with `unicode61 remove_diacritics 2`. If that capability is unavailable, it uses **FTS4 Unicode61**, not `LIKE '%text%'`. The selected backend is persisted and displayed. Both implementations have automated English/Spanish, diacritic, quoted phrase, punctuation and identifier tests. Device-specific FTS availability is discovered at runtime; no physical-device FTS5 claim is made by host tests.

FTS5 reports `fts5_negative_bm25` (negated SQLite BM25, higher is better). FTS4 uses actual inverted-index matches with labelled `fts4_tf_idf`: sum over matched phrases/columns of `(1 + log(tf)) * log(1 + N / df)`. It is not advertised as BM25. MATCH scan order is fixed before indexed record lookup to avoid a repeated-scan query plan. FTS4 matching is streamed by docid pages, retaining top candidates only.

Raw input never becomes an FTS expression: the query builder extracts Unicode letter/number terms, quotes them, and ORs literal terms/quoted phrases. Punctuation inside an identifier becomes a phrase of tokenizer terms. Quoted phrases mean exact **token sequences**, not byte-identical strings. No stemming, translation or LFM-specific query prefixes are applied. Empty lexical queries return no matches.

Vector retrieval calls `embedQuery()` exactly once. Hybrid uses **reciprocal-rank fusion**, not addition of lexical and cosine values:

`lexicalWeight / (k + lexicalRank) + vectorWeight / (k + vectorRank)`

Default `k = 60`, both weights 1. Candidate counts and final limit are distinct: normally 50 per modality, then 10 final results; caps are 500 and 100. Duplicates merge by index ID/revision. Ties use stable ID ordering. No reranker, recency bonus or LLM score exists.

Lexical mode works unloaded. Vector mode raises a structured unavailable error when query embeddings cannot run. Strict hybrid also fails; `allowDegraded: true` permits an explicitly reported surviving modality. If both fail the request fails. Empty text returns an empty response without inference. Responses never silently label lexical-only results hybrid.

Results expose the full searchable projection with source provenance, timestamps, metadata/scope, final rank/score, modality ranks/raw scores, and the relevant fingerprint, **not vector arrays**. Responses include requested/actual modes, degraded reasons, total and per-stage timings, candidate/final counts, backend IDs and RRF configuration. Fusion timing includes final authorized materialization.

## Retrieval Lab

- Create/Reset deterministic test sources; clear projections while retaining sources; rebuild; process pending; retry failures; reindex stale vectors.
- Explicitly load the installed model; installation remains in Embeddings Lab.
- Edit namespace/type/content/source ID, optional timestamps/JSON metadata, and normal/private lab fixture scope; Index/Update/Delete and inspect hashes, states, fingerprint, revision, latency and failures.
- Lexical/vector/hybrid query modes, bounded candidates/final limit, namespace exact/subtree, type, creation time and scope filters. Select between two fixed **lab fixture callers** to demonstrate private-grant exclusion.
- Ranked previews include lexical and vector evidence, with expandable provenance and search diagnostics. There are no generated explanations.
- The 40 deterministic fixtures cover English/Spanish, cross-language facts, paraphrases, hard negatives, similar names, ambiguous terms, amounts, dates and identifiers across several namespaces/types.
- Fifteen labelled queries report Top-1, Recall@3, Recall@5 and MRR separately for each actual modality. Missing modalities are unavailable, not zero-quality semantic results. Reset sources first for the baseline evaluation.
- The real-indexing benchmark measures admission (hash/storage/lexical), admission lexical time, drain lexical work, embedding time, vector persistence, end-to-end time, throughput, failures and before/after device memory. It does not run automatically.
- Backend benchmarks create isolated synthetic 1024-dimensional vectors at 100/1,000/10,000, run a warm-up plus seven measured searches per modality, report P50/P95/candidates/memory/storage, then remove only benchmark-owned projections. Larger runs are not implemented. Cancellation also cleans temporary benchmark projections; cleanup may take time.
- Diagnostics are a bounded process-local ring containing event types, codes, counts and timings. No source content or vectors go to PostHog, cloud services, or normal diagnostic logs. Reports stay on the lab screen; the checked-in host report contains only deterministic lab data and aggregate synthetic metrics.

## Verification and limitations

See [verification.md](verification.md) for commands, measured results, APK, and device limitations; [host-results.json](host-results.json) contains the complete reproducible host report.

The device is the authority for Android worker/BLOB bridge overhead, FTS selection, memory, real embedding ranking and layout. Host tests cannot establish those results. Exact-flat scan remains intentionally replaceable; use the measured scale limits rather than describing this backend as ANN. The shared database byte total includes source/telemetry tables and freelist pages. Occupied-page counts and isolated benchmark growth are reported; per-table physical attribution and WAL/journal totals are not implemented.

Reference behavior: [SQLite FTS5](https://www.sqlite.org/fts5.html), [FTS4 matchinfo](https://www.sqlite.org/fts3.html#matchinfo), and [NativeScript worker isolation](https://docs.nativescript.org/guide/multithreading). Runtime capability tests, SQL-backed tests and build artifacts are used in addition to documentation.
