# Sam Embeddings AAR

Standalone Android Kotlin/JNI library for the official LiquidAI dense embedding
model. No NativeScript, Angular, Activity, Context, model downloader, server,
chat template, GPU driver, or model asset is required by the library.

## Build

Toolchain pins: JDK 17, Gradle 8.14.3, Android Gradle Plugin 8.11.1, Kotlin
2.1.21, compile SDK 35, min SDK 24, NDK 28.2.13676358 (r28c), CMake 3.31.6.
Only `arm64-v8a` is built, using portable `armv8-a` CPU instructions. OpenMP,
KleidiAI, GPU backends, dynamically loaded backends, tools, and server are off.

```bash
export ANDROID_HOME=/home/dom/Android/Sdk
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
  'platforms;android-35' 'ndk;28.2.13676358' 'cmake;3.31.6'
bash native/scripts/build-android.sh --console=plain
```

Output: `native/build/outputs/aar/sam-embeddings.aar`.

The script uses the existing `platforms/android/gradlew` only as a Gradle
bootstrap with `-p native`. To build outside this workspace, set `GRADLE` to an
absolute Gradle 8.14.3 executable/wrapper. All build configuration is in this
folder. No app or App_Resources files are read by Gradle or changed.

`fetch-llama.sh` fetches exactly
`465e49b9cea78a68b9c244ffb48d0ee24a82873d` into gitignored
`native/vendor/llama.cpp`. It rejects a different or dirty checkout. CMake also
checks the commit. nlohmann JSON comes from that pinned checkout. No upstream
patches are applied. Build outputs and downloaded source must not be committed.

The AAR packages `jni/arm64-v8a/libsam-embeddings.so`. llama.cpp, ggml, and the
C++ runtime are statically linked into it; its only dynamic dependencies are
Android system `libc.so`, `libm.so`, and `libdl.so`. ELF LOAD segments use 16 KB
alignment. The consuming APK must also use 16 KB-compatible JNI ZIP packaging
(AGP 8.5.1+). Device execution on 16 KB pages still needs physical validation.
Third-party notices are included in `assets/sam-embeddings/`.

For a raw AAR consumer, add the Kotlin runtime explicitly because file-based
AAR dependencies do not carry Maven transitive dependencies:

```kotlin
implementation(files("libs/sam-embeddings.aar"))
implementation("org.jetbrains.kotlin:kotlin-stdlib:2.1.21")
```

`org.json` is supplied by Android. Consumer ProGuard rules preserve the public
bridge and JNI method/class names. There is no application manifest permission
or initialization component.

## Model Contract

| Field | Value |
| --- | --- |
| HF repository | `LiquidAI/LFM2.5-Embedding-350M-GGUF` |
| Revision | `a80de9c5b941d429104f0038292a0ef5a860e486` |
| Filename | `LFM2.5-Embedding-350M-Q8_0.gguf` |
| Bytes | `379216640` |
| SHA-256 | `6ec5f8e8750dbc8a0e40c431fd1b7b07a13688136b2244c5a1364b54d9032599` |
| Model ID in results | `LiquidAI/LFM2.5-Embedding-350M` |
| Output | 1024-dimensional CLS embedding, L2 normalized |
| Limit | 512 tokens **including prefix and BOS** |

The caller owns installation, hash verification, file permissions, storage,
and the model license. Supply an absolute, readable, app-private regular file.
Keep that verified file immutable while loaded: llama.cpp memory-maps it.
Do not overwrite, truncate, or replace it in place; unload first. Never package
the model in the AAR/APK. This module does not download models at runtime.

Load validates exact byte length and typed GGUF metadata before replacing an
existing model: `lfm2`, 1024 dimensions, noncausal attention, CLS pooling, Q8_0,
BOS enabled, EOS disabled, and the official inventory of 93 Q8_0 + 55 F32
tensors. It validates the loaded vocabulary/output dimensions too. This is not
a cryptographic authenticity check or a sandbox for hostile GGUFs. The caller
must verify the SHA-256 before calling load; native exceptions become structured
errors, but upstream assertions, process OOM kills, and mmap file truncation
cannot be caught as C++ exceptions.

## Public API

Class: `com.sam.embeddings.SamEmbeddingEngine`, public zero-argument constructor.
Non-null Kotlin arguments are required (Java/JNI bridge callers must not pass null).

```kotlin
fun loadModel(path: String): String
fun unloadModel(): String
fun embedQuery(text: String): String
fun embedDocument(text: String): String
fun embedBatch(texts: Array<String>): String
fun embedBatchWithOptions(texts: Array<String>, mode: String, maxSequences: Int, maxTokens: Int): String
fun tokenize(text: String, kind: String): String
fun poll(requestId: String): String
fun cancel(requestId: String) // void at the Java boundary
fun isLoaded(): Boolean
fun getModelInfo(): String
fun getState(): String
fun close() // AutoCloseable; asynchronous teardown, not a blocking join
```

The load, unload, embedding, batch and tokenize methods return a unique request ID immediately. They do not
return results directly. Poll on a timer, not a busy loop on the UI thread.
Requests are FIFO in submission-lock order, even when multiple callers submit
concurrently. Both batch methods capture a copy of the array. `embedBatch`
uses the new native batch operation with `true_batch`, a requested target of
100 sequences and 4096 tokens, but preserves its legacy array result shape.
`embedBatchWithOptions` returns embeddings and metrics together. Neither API
implements true batching by looping over `embedDocument`.

Polling envelopes:

```json
{"status":"pending"}
{"status":"completed","result":{}}
{"status":"error","error":{"code":"INPUT_TOO_LONG","message":"Input exceeds 512 tokens including prefix and BOS","actualTokens":513,"maxTokens":512}}
{"status":"cancelled"}
```

`poll` consumes terminal responses exactly once. Further polls, or unknown IDs,
return `error` with code `UNKNOWN_REQUEST`. Pending responses are not consumed.
Terminal results have no expiry; consume every request, including cancelled
ones, to release retained JSON/vector memory. No background callback or Promise
bridge is required. The queue has no automatic backpressure; bound submissions
and batch sizes in the caller.

Result schemas:

| Operation | `result` |
| --- | --- |
| Load | `{loadDurationMs: number, modelInfo: ModelInfo}` |
| Unload | `{unloaded: true}` (also when already unloaded) |
| Query/document | `Embedding` |
| Legacy batch | `Embedding[]`, in input order; no partial results on error/cancellation |
| Batch with options | `{embeddings: Embedding[], metrics: BatchMetrics}`, atomic and in input order |
| Tokenize | `{tokenCount: number}`, including prefix/BOS even above 512 |

```typescript
type ModelInfo = {
  modelId: 'LiquidAI/LFM2.5-Embedding-350M';
  revision: 'a80de9c5b941d429104f0038292a0ef5a860e486';
  quantization: 'Q8_0';
  dimensions: 1024;
  maxTokens: 512;
  backendRevision: '465e49b9cea78a68b9c244ffb48d0ee24a82873d';
  batchMode: 'true_batch';
  batchLimits?: NativeBatchLimits; // only when published from a loaded context
};
type Embedding = {
  vector: number[];
  dimensions: 1024;
  modelId: 'LiquidAI/LFM2.5-Embedding-350M';
  revision: 'a80de9c5b941d429104f0038292a0ef5a860e486';
  quantization: 'Q8_0';
  tokenCount: number;
  inferenceDurationMs: number | null;
  warm: boolean;
};
type NativeBatchLimits = {
  nBatch: number;
  nUbatch: number;
  nCtx: number;
  nCtxSeq: number;
  maxParallelSequences: number;
  backendMaxParallelSequences: number;
  backendSequenceExecution: 'serial_ubatches';
};
type BatchMetrics = {
  mode: 'sequential' | 'true_batch';
  requestedBatchSize: number; // maxSequences, not document count
  effectiveBatchSize: number; // maximum observed sequences in one llama_decode
  nativeDecodeCount: number;
  totalTokens: number;
  totalElapsedMs: number;
  nativeDecodeMs: number;
  preparationMs: number;
  effectiveMsPerDocument: number;
  documentsPerSecond: number;
  tokensPerSecond: number;
  limits: NativeBatchLimits;
  decodes: {sequences: number; tokens: number; nativeDecodeMs: number}[];
};
```

`getModelInfo()` always returns the supported model contract, including when
unloaded. It includes `batchLimits` only after a successful load. The load
worker caches the returned model-info JSON; synchronous callers never read the
native context. Unload, cancelled load, failed replacement and close clear the
cached limits when the worker publishes the unloaded state. A rejected load
that preserves the old context preserves its limits. Use `isLoaded()` and
`getState()` for current worker-published state.
States are `unloaded`, `loading`, `ready`, `unloading`, `error`. Queued load/unload
operations change state only when their turn begins. Validation or inference
errors do not discard an otherwise loaded model; it remains `ready`. An error
with no loaded model publishes `error`; a later load/unload can recover.

`warm` means at least one successful inference has occurred since the current
model/context was loaded, not a cached vector or a hidden warm-up run. The first
decode after load reports `false` for all its embeddings. A completed decode
in a later-failed/cancelled request still warms the context. For a singleton,
`inferenceDurationMs` is the actual measured batch-buffer setup, memory reset,
decode, CLS extraction and normalization time, excluding queue wait and
tokenization. For every multi-item request it is `null`, including sequential
mode and legacy batches. Per-item latency is not derived from amortized time.
`loadDurationMs` excludes queue wait and includes metadata/model/context setup.

Error codes include `INVALID_ARGUMENT`, `EMPTY_INPUT`, `INPUT_TOO_LONG`,
`INVALID_PATH`, `INVALID_MODEL`, `MODEL_NOT_LOADED`, `MODEL_LOAD_FAILED`,
`NATIVE_INIT_FAILED`, `TOKENIZATION_FAILED`, `INFERENCE_FAILED`, `NATIVE_ERROR`,
`OUT_OF_MEMORY`, `ENGINE_CLOSED`, and `UNKNOWN_REQUEST`. Only oversized errors
include `actualTokens` and `maxTokens`. Cancellation is a distinct status, not
an inference failure.

## Preprocessing

Pass raw text, not chat messages. `kind` is exactly `query` or `document`.
Preprocessing is shared by tokenize and embedding in C++: always prepend
`kind + ": "` to the unchanged raw text. Prefix-like user text is literal content,
not formatting: raw `query: foo` becomes `query: query: foo` for a query, and raw
`document: foo` becomes `document: document: foo` for a document. Nothing is
deduplicated or stripped. No trimming, case conversion, chat templating,
truncation, or EOS appending is performed. Only empty/whitespace-only raw text
is rejected as empty; raw `query:`, `query: `, and `document: ` are legitimate.

The official tokenizer config sets `add_bos_token=true`, `add_eos_token=false`;
llama.cpp tokenizes with `add_special=true`, `parse_special=false`. BOS ID 1
is inserted automatically. User spellings such as `<|startoftext|>` or
`<|endoftext|>` remain literal text rather than injected control tokens. This
intentionally differs from upstream CLI's `parse_special=true` for such literal
spellings; ordinary text uses the same tokenizer. Added tokens not classified
as special retain the GGUF tokenizer's normal behavior.

Text crosses JNI as standard UTF-8 byte arrays, preserving supplementary Unicode
and embedded NUL bytes. Malformed UTF-16 (unpaired surrogates) is rejected in
Kotlin before UTF-8 conversion for both text (`INVALID_ARGUMENT`) and model
paths (`INVALID_PATH`). Valid supplementary characters in paths are preserved;
NUL remains invalid in paths. Response JSON is ASCII escaped before
`NewStringUTF`; modified UTF-8 is never used for model input.

Important source observations at the pinned backend: `src/models/lfm2.cpp`
lines 196-204 implement the bidirectional centered convolution padding;
`include/llama.h` documents the CPU abort callback and decode abort return 2.
The official GGUF stores `lfm2.context_length=128000`, inherited from the base
model. This library deliberately enforces the official **embedding model's 512**
limit instead, independently of the larger multi-sequence context.
See the official [model card](https://huggingface.co/LiquidAI/LFM2.5-Embedding-350M),
[tokenizer config](https://huggingface.co/LiquidAI/LFM2.5-Embedding-350M/blob/main/tokenizer_config.json),
and [pinned GGUF card](https://huggingface.co/LiquidAI/LFM2.5-Embedding-350M-GGUF/blob/a80de9c5b941d429104f0038292a0ef5a860e486/README.md).

## Native Batching

Options are exact: `mode` is `sequential` or `true_batch`, `maxSequences` is
1..100, and `maxTokens` is 1..4096. There must be 1..1000 documents. Invalid
configuration fails with `INVALID_ARGUMENT`; an empty array is `EMPTY_INPUT`.
All documents are tokenized once upfront, before any decode. The unchanged
document prefix/BOS counts against the 512-token per-document limit. An input
above 512 is `INPUT_TOO_LONG`; one above the requested or loaded token budget
is `INVALID_ARGUMENT`. Documents are never split, truncated, padded or sorted.

Consecutive documents are packed until the next document would exceed either
the sequence target or the minimum of the token target and actual `nBatch`,
`nUbatch`, `nCtx`. Each document is also bounded by actual `nCtxSeq` and 512.
Targets above actual backend capacity are capped for packing, not treated as
allocated capacity. Sequential mode uses the same preprocessing and decode
path with one sequence per decode; its requested sequence target is still
reported unchanged. A final partial pack is decoded normally.

Each pack is **one official `llama_decode`** containing a `llama_batch` with
independent sequence IDs and positions starting at zero for each document.
Every token belongs to exactly one sequence; all outputs are enabled. CLS
vectors are obtained with `llama_get_embeddings_seq`, copied and normalized
before clearing memory. The wrapper owns batch buffers using C++ RAII rather
than relying on the pinned `llama_batch_init`'s unchecked per-token mallocs.

This does **not** mean parallel backend sequence execution. At the pinned
revision, `src/llama-context.cpp:1668-1669` sets `output_all` from embeddings
mode, and `src/llama-memory-hybrid.cpp:77-79` uses `split_seq` for these outputs.
LFM2 therefore executes serial internal ubatches. Metrics explicitly report
`backendSequenceExecution: 'serial_ubatches'`; `nativeDecodeCount` counts API
calls, not internal ubatches. No vendor patch, alternative convolution,
embedding-mode toggle or splitting bypass is used.

Timing is measured using `steady_clock`, not estimated. `totalElapsedMs`
covers the C++ batch operation through final memory cleanup, excluding queue
wait, Kotlin/JNI UTF-8 conversion and JSON serialization. `preparationMs` sums
upfront validation/tokenization and each pack's construction/reset phase.
`nativeDecodeMs` sums measured decode-and-synchronize intervals; extraction,
normalization and cleanup make total time larger than those two phases.
Throughputs use total elapsed time and actual document/token counts.
`effectiveMsPerDocument` is total elapsed time divided by document count.
There are no additional public metric fields beyond the schema above.

### Fixed Allocation Budget

The context uses the official **`kv_unified=false`** option, with at most
**eight private 512-token KV streams**: `n_seq_max=min(8,
llama_max_parallel_sequences())`, `n_ctx=512*n_seq_max`, and fixed
`n_batch=n_ubatch=1024`. Eight streams fit the fixed 4096-cell context budget;
100 private streams would allocate 512*100 cells. There are no device profiles,
alignment padding, reordered documents or adaptive retries. Requested targets
remain valid over 1..100 sequences and 1..4096 tokens, but packing caps them at
the actual eight-sequence/1024-token decode capacities.

Unified KV was investigated but rejected for correctness: its packed token
offset changes floating-point attention reductions, failing the strict cosine
gate. Private streams preserve the isolated sequence's KV origin, mask width
and reduction layout without changing model code or preprocessing. The official
serial internal ubatch behavior is unchanged. See the investigation below.

Measured host allocation for the selected configuration is **84.02 MiB compute,
48.00 MiB KV, and 0.62 MiB recurrent state**. The initial output buffer is
2.03 MiB and grows with token outputs; the mapped model is 359.37 MiB. A stress
run reached 789,240 KiB peak RSS. These are host measurements, not Android
memory guarantees or additive RSS accounting. Android allocation/performance
remains unmeasured.

For comparison, the rejected unified 4096-context/4096-decode configuration
reserved 1185.24 MiB compute and reached 1,786,932 KiB peak RSS. Unified
4096-context/1024-decode reserved 317.99 MiB compute, while unified
1024-context/1024-decode reserved 98.85 MiB. All three unified configurations
retained the numerical mismatch; reducing their memory budget was not a fix.

Reported limits come from `llama_n_batch`, `llama_n_ubatch`, `llama_n_ctx`,
`llama_n_ctx_seq`, `llama_n_seq_max` and `llama_max_parallel_sequences`, not from
requested parameters. Observed values are `1024, 1024, 4096, 512, 8, 256`
respectively. `nCtxSeq=512` is the private capacity of each stream, not a
shared 4096-token allowance for an individual document.

## Lifetime And Cancellation

One instance owns one worker, one native Engine, one model, and one mutable
context. All native model/context operations run serially on that worker.
The sole cross-thread JNI operation is cancellation: it writes a stable native
atomic flag under the same Kotlin lifetime lock used for creation/destruction
and active-request transitions. No concurrent context mutation or pointer
free is permitted. Backend initialization is process-wide and runs once;
individual instances never free the shared backend registry.

- Repeat load of the same immutable path is idempotent and keeps warm state.
- Another path is validated before unloading the old model. If replacement
  allocation/load then fails, the engine is unloaded; it never holds two models.
- Repeated unload is safe. Each actual reload resets warm state.
- `cancel` on unknown/terminal IDs is a no-op. Queued requests are skipped when
  reached; polling can remain pending until the active operation yields.
- Active load uses llama.cpp's progress callback. Active inference uses its CPU
  abort callback; tokenization and setup check cancellation at safe boundaries.
  This is cooperative, not hard preemption; metadata reads, tokenization,
  allocation, and teardown can take time before yielding.
- KV and recurrent convolution memory are cleared before and after every
  decode, including aborts and allocation/extraction exceptions. Cleanup
  synchronizes first. Cancellation is checked during preparation, before each
  pack and decode, after decode, and before returning. CPU abort is enabled.
  The abort flag resets before the next request.
- A cancelled active load unloads its model before publishing cancellation,
  including an idempotent same-path load. Cancelling unload does not roll back
  teardown. Batch responses are atomic: an exception or cancellation discards
  all vectors/metrics, even after earlier packs completed. Cancellation does
  not roll back elapsed CPU work or warm state from completed decodes.
- `close()` atomically stops accepting work, requests cancellation for all
  outstanding work, queues destruction after it, and shuts down the executor.
  It is idempotent and nonblocking; keep polling existing IDs if results matter.
  Newly submitted requests return `ENGINE_CLOSED`. Construct a new instance to
  reopen. Always call `close`; there is no finalizer relying on GC timing.

## Verification

```bash
bash native/scripts/validate-host.sh
bash native/scripts/build-android.sh --console=plain
```

The validation script downloads only to `/tmp/opencode`, verifies SHA-256 and
size, builds the same C++ engine as Android, and runs the engine smoke suite
plus a focused public-API sequence-isolation/legacy-singleton check.
No server, database, Docker, or production operation is involved.

The initial compatibility gate also built and ran unmodified upstream
`llama-embedding` at the pinned revision against the exact Q8 artifact.
`query: What is panda?` tokenized to `[1,11582,535,3747,856,64192,540]`, with
no EOS. The shared engine's normalized first component agrees with upstream
CLI (`-0.0278193`) and its panda-document retrieval scores were approximately
`[-0.175668, 0.051509, 0.564711]`, correctly ordered from unrelated greeting to
full panda description. These are smoke checks, not a full HF/BF16 quality
equivalence benchmark.

Host coverage includes exact 1024 dimensions, finite/unit-norm output,
English/Spanish within-language and cross-language ranking (both panda documents
must outrank both unrelated bicycle documents for each query language),
upstream CLI component agreement, literal raw-prefix preservation, literal
special tokens, supplementary Unicode/NUL (11 tokens in the fixture), exact
512-token acceptance, 513-token rejection, oversized counting (604 tokens),
repeat-input isolation, active abort/reset, idempotent unload, and reload.
Batch tests cover variable-length order, multi-sequence calls, all eight sequence IDs,
101 documents with a requested target of 100 capped at actual capacity,
sequence/token packing with partial final packs, actual-capacity saturation,
singleton and null multi-item timing, metrics arithmetic, upfront invalid and
oversized rejection, repeated cancellation/failure recovery and warm state.
Host-only hooks inject allocation exceptions and post-decode failures after
one pack has succeeded, plus cancellation before/after later decodes. These
simulate recoverable wrapper failures, not process OOM kills or upstream
assertions; they are absent from Android compilation.
Unit tests exercise FIFO polling/consumption, queued and active cancellation,
close ordering, Unicode bytes, raw prefix-like text, path-surrogate validation,
invalid input, native-init recovery, and 160
submissions from eight concurrent callers.

Instrumentation APK: `native/build/outputs/apk/androidTest/debug/sam-embeddings-debug-androidTest.apk`.
It contains **no model**. On a physical ARM64 device, install the test APK and
supply an already provisioned, hash-verified file readable from that test
package's private storage. The test also verifies its hash before loading:

```bash
adb install -r native/build/outputs/apk/androidTest/debug/sam-embeddings-debug-androidTest.apk
adb shell am instrument -w \
  -e modelPath /data/user/0/com.sam.embeddings.test/files/LFM2.5-Embedding-350M-Q8_0.gguf \
  com.sam.embeddings.test/androidx.test.runner.AndroidJUnitRunner
```

Alternatively use `connectedDebugAndroidTest` with
`-Pandroid.testInstrumentationRunnerArguments.modelPath=/absolute/private/path`.
The model-dependent test explicitly skips when no `modelPath` is supplied; the
JNI/invalid-path test still runs. The library itself never references a Context;
only instrumentation accesses test runner arguments.

### Numerical Investigation

The original unified-KV implementation failed the unchanged `cosine >= 0.99999`
gate. The 512-token fixture is `hello` followed by 508 ` hello` repetitions,
including document prefix/BOS in the count. Alone versus after the 12-token
`A bicycle has two wheels and pedals.`, its raw-vector cosine was
`0.9999509521132539`. The unmodified pinned official CLI independently
reproduced `0.9999509519243702` (seven-decimal output precision).

Focused experiments using only public llama APIs distinguish the cause:

- Isolated IDs 0, 1 and 99 produce bit-identical vectors. Swapping the two IDs
  does not change the mismatch. Decoding the long input first is bit-identical.
- A preceding 512-token sequence is bit-identical, regardless of its content.
  Prefix lengths 8, 16, 24 and 32 are bit-identical; lengths 4, 12 and 20 give
  exactly the same mismatch even with different content. Prefix length 17
  reaches cosine `0.999944710808375`. The dependence is on KV token offset,
  not predecessor semantics or the sequence ID.
- Tensor capture through `cb_eval` finds identical layer-2 QK scores over all
  4,194,304 valid entries, but a maximum softmax difference of
  `1.7881393432617188e-7`. Every masked probability is exactly zero, ruling out
  attention to other sequences in this reproduction. Layer-2 attention output differs by up to
  `1.0728836059570313e-6`; the first differing captured CLS row is at attention
  layer 8. Early recurrent shortconv outputs match. Later normalization and
  quantized layers amplify the rounding difference to a final raw component
  difference of `0.05715516209602356`.
- The pinned `ggml/src/ggml-cpu/vec.cpp:541-550` sums softmax exponentials in
  eight-element AVX2/FMA groups, in float before adding to the double sum.
  Leading masked cells shift that reduction grouping. `ops.cpp:5675-5683`
  normalizes by the resulting sum. This explains the measured offset pattern.
- `llama-memory-recurrent.cpp:141-158` clears state metadata and buffers;
  `llama-graph.cpp:280-325` selects CLS independently by minimum sequence
  position. Graph reuse has no public context parameter; the diagnostic
  `LLAMA_GRAPH_REUSE_DISABLE=1` environment switch does not fix the mismatch.
  One CPU thread, `no_perf=false`, `op_offload=true` and deprecated warmup mode
  also reproduce it. Earlier F32-KV and flash-attention trials did not fix it.
- Official non-unified KV with two, then eight bounded private streams makes
  every tested prefix offset, reversed order, swapped ID, equal-length pair
  and repeated singleton **bit-identical**. It eliminates the changing
  reduction layout without patching vendor code or padding input tokens.

`tests/batch-investigate.cpp` preserves the reproducer and tensor trace. After
the host build, run these optional diagnostics with the verified local model:

```bash
/tmp/opencode/sam-host-build/sam-batch-investigate /tmp/opencode/LFM2.5-Embedding-350M-Q8_0.gguf default
/tmp/opencode/sam-host-build/sam-batch-investigate /tmp/opencode/LFM2.5-Embedding-350M-Q8_0.gguf trace
/tmp/opencode/sam-host-build/sam-batch-investigate /tmp/opencode/LFM2.5-Embedding-350M-Q8_0.gguf separate_kv_8
```

Unified variants are diagnostic negative controls and report
`meetsCosineTolerance:false`; they are not production modes. The private-KV
variant is an acceptance gate and exits nonzero on any cosine below `0.99999`
or any raw difference from the original singleton context. It compares query
and document fixtures, including 512 tokens, Unicode/NUL and literal prefixes,
against the original `n_ctx=n_batch=n_ubatch=512`, one-sequence context.

Current host validation **passes without weakening tolerance**. The original
mixed-pack regression reports zero cosine failures. Additional forward,
reversed and rotated packs at lengths 4, 7, 17, 127, 255, 256, 257 and 512 pass;
the minimum normalized-vector dot product across the host suite is
`0.9999999974086187`. Focused private-stream
cases have cosine `1.0` and maximum raw difference `0.0`, and all ten original
query/document singleton comparisons have maximum raw difference `0.0`.
Production true batching remains enabled with bounded private streams;
sequential mode remains available explicitly. No runtime numerical override,
experimental bypass, process-global environment change or silent fallback is
used.

All **12 JVM unit tests passed**; the release AAR and instrumentation APK built.
Instrumentation includes the same strict cosine assertion and remains unrun.
Release-bytecode inspection confirms both batch API signatures; the shared
library exports the new JNI batch entry point. Current ELF inspection confirms
16 KB LOAD alignment and only `libc.so`, `libm.so` and `libdl.so` dependencies.
No device was used, so physical instrumentation, Android
performance/memory behavior, and actual 16 KB-page execution remain unverified.
App integration/APK packaging belongs to the consuming project.
