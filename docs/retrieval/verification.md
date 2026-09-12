# Retrieval implementation report — 2026-09-12

The implementation and debug APK are available. Host correctness/build checks passed. **Physical acceptance remains unverified** because `adb devices` reports no attached device. No real-model indexing throughput, vector/hybrid semantic metrics, Android FTS selection, worker device performance or device layout result is claimed.

## Requested report

1. **Existing database:** Android framework SQLite, shared `sam.db`, `SqliteStore` singleton, explicit cursor cleanup and versioned transactional migrations; previously version 5.
2. **Core contracts:** platform-neutral indexing/repository/lexical/vector/retrieval interfaces, query/result/response types, cancellation and structured diagnostics; public barrel `src/core/retrieval/index.ts`.
3. **Schema:** migration 6 adds projection records, binary vectors, backend/version state, indexes and isolated lab source fixtures. Existing source/telemetry tables are not modified.
4. **Items/provenance:** stable index ID; unique namespace/type/source tuple; system/type/source ID; searchable text; SHA-256; creation/update/index timestamps; metadata; scope; projection/schema versions; completion revision and vector fingerprint.
5. **Access:** required extensible `{kind,key}` scopes and authoritative grants; no implicit global access; filters cannot grant access; malformed scopes fail closed. Lab grants are isolated from production grants.
6. **Lexical backend:** real runtime FTS5 Unicode61 probe, then FTS4 Unicode61 fallback. FTS5 negative BM25 and FTS4 TF-IDF are truthfully labelled. No LIKE surrogate.
7. **Vector backend:** persistent `exact_flat` behind `VectorIndex`; no compatible vector extension already existed in this framework SQLite stack.
8. **Exact/ANN:** exact cosine, not ANN. Measured host limitations are below; no native ANN project was started.
9. **Binary format:** Float32 little-endian SQLite BLOB; 4,096 bytes per 1024-dimensional vector, plus measured database overhead.
10. **Fingerprint:** model/revision/quantization/dimensions/backend revision/format/preprocessing/normalization. Incompatible vectors are excluded and counted stale; selected stale work can be requeued.
11. **Lifecycle:** independent lexical pending/ready/failed and vector pending/ready/stale/failed; structured last failure. Lexical search can survive failed or unavailable embeddings.
12. **Queue/concurrency:** durable row queue; bounded process-level admission/drains; serialized short mutations; one drain; native embedding service reused. Inference and exact scanning run off the UI thread. Default batch size 1; explicit load policy; no launch reembedding.
13. **Delete/update/reindex:** atomic projection cleanup; source rows preserved; revision-guarded completion; old vectors excluded immediately after text updates; idempotent deletion; explicit retry/selective reindex.
14. **Hybrid:** reciprocal-rank fusion, default `k=60`, equal weights, configurable bounded candidates and final results, deterministic ties.
15. **Filters:** exact/subtree namespace, type, source system/type/id, created/updated inclusive ranges and scope. SQL parameters and literal FTS query building.
16. **Degradation:** lexical works unloaded; vector and strict hybrid raise unavailable errors; opt-in hybrid fallback explicitly reports actual modality and reasons. Both modalities unavailable is failure.
17. **Results/responses:** traceable source projection, final and modality ranks/raw scores, fingerprints, requested/actual modes, backend IDs, timings, counts, degradation and fusion config. No full vectors in search results.
18. **Lab:** menu route, 40 source fixtures, create/reset/rebuild/clear, manual CRUD, status/fingerprint/error display, model load, pending/retry/stale controls, filters and fixed fixture callers, expandable diagnostics, evaluation and synthetic/real benchmark controls.
19. **Multilingual/hard negatives:** 15 labelled queries implemented; host SQL lexical results below. Real Q8 vector/hybrid evaluation must be run on device. Inputs use production `embedQuery`/`embedDocument` paths without translation.
20. **Automated checks:** 350 tests passed; TypeScript and Angular compilation passed; fresh/upgrade/rollback/source-preservation tests passed; actual worker/native-connection dispatch is also exercised against a SQLite-backed Android API shim. Existing embedding adapter/lab/batching tests passed in the full suite.
21. **Benchmarks:** host synthetic 100/1,000/10,000 with seven measured searches per mode, one excluded warm-up; P50/P95 below. No real embedding stress or model download was run.
22. **Size/scaling:** 10,000 raw vectors = 40,960,000 bytes. Measured complete synthetic projection databases were about 58.8 MB. Exact scan approaches a second at that scale on this host; Android requires its own measurement.
23. **Limitations:** no attached device; no existing host Q8 model or host binary; therefore no real embedding evaluation/indexing timing or on-device rendering. Exact scan/FTS4 scaling, JS/native BLOB-copy overhead, page-granular cancellation, process-lifetime scheduling, no guaranteed suspended-app work. Database totals include other tables and free pages; no per-table/WAL attribution. See the architecture document for full semantics.
24. **APK:** `platforms/android/app/build/outputs/apk/debug/app-debug.apk`. Final artifact: 42,934,621 bytes; SHA-256 `7f00fd06a1f62ace57c6bda881319a09e0771837de23de5d45c1e3c4a1ddec89`. See artifact verification below.

## Host retrieval benchmarks

Linux x64, Node v26.4.0, local on-disk SQLite, synthetic normalized 1024-dimensional vectors, 50 candidates/modality, 10 final results. These are backend-only timings, **not Android or model timings**. Full data: [host-results.json](host-results.json). Date: 2026-09-12T08:02:28Z.

| Backend | Items | Lexical P50/P95 ms | Vector P50/P95 ms | Hybrid P50/P95 ms |
| --- | ---: | ---: | ---: | ---: |
| FTS5 | 100 | 1 / 2 | 10 / 11 | 10 / 11 |
| FTS5 | 1,000 | 3 / 4 | 87 / 91 | 89 / 92 |
| FTS5 | 10,000 | 20 / 21 | 854 / 882 | 878 / 889 |
| FTS4 | 100 | 3 / 6 | 9 / 9 | 10 / 13 |
| FTS4 | 1,000 | 19 / 26 | 78 / 81 | 96 / 98 |
| FTS4 | 10,000 | 687 / 716 | 791 / 820 | 1,467 / 1,720 |

At 10,000 items, this implementation is unsuitable for a sub-100-ms interactive backend budget on this host. A 1,000-item scan was around that budget before query embedding. There is no asserted universal device threshold, and no ANN replacement was added. Timings use millisecond clocks and include bounded paging, validation, candidate retention and result materialization. FTS4 broad-match scoring streams matches; it is more expensive than SQLite's built-in FTS5 ranking.

| Backend | Items | Raw vector bytes | Total database bytes | Synthetic setup ms |
| --- | ---: | ---: | ---: | ---: |
| FTS5 | 100 | 409,600 | 667,648 | 104 |
| FTS5 | 1,000 | 4,096,000 | 5,955,584 | 821 |
| FTS5 | 10,000 | 40,960,000 | 58,834,944 | 15,761 |
| FTS4 | 100 | 409,600 | 667,648 | 73 |
| FTS4 | 1,000 | 4,096,000 | 5,971,968 | 776 |
| FTS4 | 10,000 | 40,960,000 | 58,880,000 | 18,013 |

At 10,000 items, full database footprint was about 1.44× raw vector bytes, including content, provenance, lexical structures and SQLite overhead. Benchmark growth and before/after process RSS are in the JSON report. Host RSS includes caches and earlier benchmark allocations in the same process: it is not isolated per-index memory. Android backend memory currently samples Java heap; real indexing additionally samples app PSS/RSS, native and Java heaps.

## Labelled retrieval evaluation

Actual SQL results over the deterministic corpus, including all English/Spanish/cross-language/exact/hard-negative labels:

| Backend/mode | Queries | Top-1 | Recall@3 | Recall@5 | MRR |
| --- | ---: | ---: | ---: | ---: | ---: |
| FTS5 lexical | 15 | 66.7% | 100% | 100% | 0.8111 |
| FTS4 lexical | 15 | 60.0% | 93.3% | 100% | 0.7689 |
| Real Q8 vector | Not run | — | — | — | — |
| Real Q8 hybrid | Not run | — | — | — | — |

The lexical cross-language cases share some names and identifiers; these numbers do not demonstrate cross-language semantic embeddings. Exact per-query ranks/IDs and explicit unavailable statuses are retained in the report. No fake semantic score or exact-cosine snapshot is used as an evaluation label.

## Commands and artifact checks

Executed successfully:

```sh
node --experimental-test-module-mocks --import ./src/test-loader.mjs --test \
  src/core/*.test.ts src/core/**/*.test.ts \
  src/app/embeddings/*.test.ts src/app/retrieval/*.test.ts
npx tsc --noEmit
npx ngc --noEmit
ns build android --no-hmr
node scripts/check-embedding-artifacts.mjs
node --import ./src/test-loader.mjs scripts/benchmark-retrieval.ts
git diff --check
```

NativeScript compilation packages the retrieval UI chunk and the separate worker chunk; the Android Gradle build produces the debug APK. Artifact checks verify ARM64 JNI identity against the unchanged AAR, no bundled model, NativeScript bridge metadata, 16-KB ELF/ZIP alignment, report provider and debug signature. The only build warning observed was SDK XML tooling-version skew; it did not prevent assembly.

The embedding-native build/host validation scripts were deliberately not run: they would rebuild the unchanged native implementation and download the absent model. This respects the task's boundary. Existing embedding TypeScript integration tests and the unchanged packaged JNI/AAR identity were checked.

## Physical acceptance checklist

1. Install the debug APK as an update; preserve application data. Open existing sessions to check the v5→v6 upgrade on the device.
2. Open Menu → Retrieval Lab. Create Test Corpus while unloaded; confirm lexical-ready and vector-pending counts and lexical queries.
3. Load the already installed Q8 model (install through Embeddings Lab first if needed); process pending vectors. Inspect failures and compatible vector counts.
4. Search all three modes. Inspect modality evidence, fused ranking and provenance. Try `Where does Alex work?`, `What city does Lucia live in?`, `¿Dónde vive Ben?`, and `"INV-2026-0042"`.
5. Exercise namespace/type/date/scope filters and the fixed private-fixture caller. Confirm private-grant exclusion cannot be bypassed by a scope filter.
6. Edit/index/update/delete manual records; repeat identical indexing; observe metadata-only reuse and content-change invalidation. Cancel a drain and resume pending work.
7. Restart the app without clearing data. Confirm persisted sources, projections and states. Clear Lab Index and rebuild from retained lab sources.
8. Reset the deterministic corpus and run the evaluation; record actual lexical/vector/hybrid metrics. Run the modest real indexing benchmark and synthetic backends as needed.
9. Review small-screen/larger-text layout, keyboard, scrolling, loading/cancel states, light/dark appearance and navigation. Confirm conversations still do not retrieve or inject context.
