# Local Embeddings And Physical Device Testing

## Scope

SAM's Embeddings Lab installs the official Liquid AI Q8_0 model separately and
executes inference in the Android process. There is no inference server, local
HTTP listener, Termux, external runtime, GPU requirement, model in the APK, or
model in the AAR. Internet is needed to install the model, not to embed text.

No memory, retrieval system, vector persistence, RAG, context management, model
router, automatic message embeddings, or database migration is included.
Diagnostic vectors are temporary. Existing provider/generation/session/tool and
telemetry systems remain independent.

## Verified Model

The official model card and tokenizer were checked on 2026-09-06. Source revision
for the original model: `f35ae2c91d687658dbf1f2b449382f0b019b9808`.

| Property | Verified value |
| --- | --- |
| Model | `LiquidAI/LFM2.5-Embedding-350M` |
| Official GGUF repository | `LiquidAI/LFM2.5-Embedding-350M-GGUF` |
| GGUF revision | `a80de9c5b941d429104f0038292a0ef5a860e486` |
| Filename | `LFM2.5-Embedding-350M-Q8_0.gguf` |
| Quantization | Q8_0, no substitution |
| Exact size | 379,216,640 bytes, 379.216640 MB, approximately 361.65 MiB |
| Official LFS SHA-256 | `6ec5f8e8750dbc8a0e40c431fd1b7b07a13688136b2244c5a1364b54d9032599` |
| Output | 1024-dimensional CLS vector |
| Retrieval input limit | 512 tokens, enforced including prefix and BOS |
| Prompts | `query: ` and `document: ` |
| Tokenizer | BOS enabled, ID 1; EOS not appended; no lowercasing |
| Normalization | Model examples explicitly L2-normalize for cosine; runtime does so |
| Pooling/attention | CLS, bidirectional attention and centered noncausal convolution |
| License | Liquid LFM Open License v1.0; review before redistribution/commercial use |

Sources:

- [Official original model card](https://huggingface.co/LiquidAI/LFM2.5-Embedding-350M/blob/f35ae2c91d687658dbf1f2b449382f0b019b9808/README.md)
- [Official tokenizer configuration](https://huggingface.co/LiquidAI/LFM2.5-Embedding-350M/blob/f35ae2c91d687658dbf1f2b449382f0b019b9808/tokenizer_config.json)
- [Pinned official GGUF model card](https://huggingface.co/LiquidAI/LFM2.5-Embedding-350M-GGUF/blob/a80de9c5b941d429104f0038292a0ef5a860e486/README.md)
- [Official artifact size and LFS hash](https://huggingface.co/api/models/LiquidAI/LFM2.5-Embedding-350M-GGUF/tree/a80de9c5b941d429104f0038292a0ef5a860e486)
- [Official model license](https://huggingface.co/LiquidAI/LFM2.5-Embedding-350M-GGUF/blob/a80de9c5b941d429104f0038292a0ef5a860e486/LICENSE)

The GGUF has an inherited backbone context length of 128000. That is **not** the
documented retrieval length; the runtime deliberately uses 512. The official
GGUF card recommends llama.cpp but does not specify a minimum commit/version.
This implementation pins and tests
`465e49b9cea78a68b9c244ffb48d0ee24a82873d`, with no upstream patches.

## Architecture

```text
NativeScript / Angular Embeddings Lab
  -> platform-independent EmbeddingService + EmbeddingModelInstaller contracts
  -> Android adapter (process singleton, coordinated admission)
  -> sam-embeddings.aar / Kotlin SamEmbeddingEngine
  -> JNI / shared C++ engine
  -> pinned llama.cpp / portable ARM64 CPU
  -> verified external app-private Q8_0 GGUF
```

| Layer | Source |
| --- | --- |
| Core contracts and structured errors | `src/core/embeddings/types.ts` |
| Cosine, norm, statistics | `src/core/embeddings/math.ts` |
| Diagnostic controller and repeatable workloads | `src/core/embeddings/lab.ts` |
| Versioned JSON/privacy and human report | `src/core/embeddings/report.ts` |
| Serialized adapter, no framework imports | `src/core/embeddings/android-adapter.ts` |
| NativeScript application-context bridge | `src/core/embeddings/android.ts` |
| Official download catalog | `App_Resources/Android/src/main/java/com/sam/embeddings/ModelCatalog.java` |
| Installer and diagnostics/export | Same directory, `SamModelInstaller.java`, `SamDeviceDiagnostics.java` |
| Reusable native library | `native/` |
| UI and process-lifetime diagnostic state | `src/app/embeddings/` |

`EmbeddingService` exposes load, unload, query/document embedding, ordered
document batches, actual token counts, readiness, state, and model info. Results
include vector, dimensions, model/revision/quantization, token count, native
inference milliseconds and whether prior successful inference warmed the context.
No runtime contract accepts an Android context, path, JNI handle, or GGUF option.
A future server adapter can implement that contract without changing its callers.

The Kotlin API accepts an external file path and returns request IDs. It provides
`loadModel`, `unloadModel`, `embedQuery`, `embedDocument`, `embedBatch`, `tokenize`,
`poll`, `cancel`, `isLoaded`, `getState`, `getModelInfo`, and `close`.
See [native API/lifetime details](../native/README.md).

Raw text always receives the appropriate prefix exactly once at the native
boundary. Literal user text beginning with `query: ` remains literal text and is
not mistaken for caller-applied formatting. No chat template is used. Tokenization
adds BOS, not EOS; special-token spellings in user input are literal, not control
tokens. Standard UTF-8 byte arrays preserve supplementary characters and NUL;
unpaired UTF-16 surrogates are rejected. Over-limit errors report actual and max
tokens. Text is never silently truncated.

## Installation And Storage

The installer lives separately from the inference AAR. The application catalog
is the only runtime download-URL authority. Downloads use the official Hugging
Face immutable-revision HTTPS URL, including reviewed Hugging Face CDN redirects.
No mirror, login token, cookie, or provider credential is used.

Files live under Android `noBackupFilesDir/models`, excluded from automatic
backups. The application does not need shared-storage permissions for the model.
It checks fresh-download free space for the full artifact plus 128 MiB headroom
(513,434,368 bytes total), checks again while writing, and finalizes by rename
on the same filesystem, not a second complete copy.

```text
not_installed -> downloading (.gguf.part) -> verifying -> installing -> installed
                               |                |
                               +-> partial      +-> invalid/error
```

Expected size and the official SHA-256 must both match before installation. The
payload is fsynced, renamed atomically, and accompanied by fsynced AtomicFile
metadata. Startup rehashes a final file off-thread before publishing its installed
path; saved metadata alone never establishes trust. A completed partial remains
uninstalled until explicit verify/install. A failed hash cannot become installed.
Native loading additionally checks GGUF architecture, pooling, bidirectionality,
tensor quantization, dimensions, tokenizer flags and successful llama.cpp parsing.

**Resume policy:** safe restart, not HTTP range resume. Range/If-Range behavior
across the official signed CDN redirects has not been certified on these phones.
Cancellation/network failure/interruption can retain an uninstalled partial;
Download / retry deletes it and starts at byte zero. Install partial can verify
and finalize a fully downloaded partial without another download. The UI says
explicitly that download retry is not resume.

Repeated download taps are rejected as busy, rather than scheduling a surprise
second download. Valid installations are idempotent. Removal drains existing
embedding work, unloads, then deletes model/partial files. Load requests cannot
overtake removal. Verification/install/download operations also unload first if
needed. See [installer schemas and recovery](../src/core/embeddings/installer-native-notes.md).

Updates require a reviewed catalog revision/size/hash change and corresponding
native model-contract/test update, followed by rebuilding the same architecture.
Never silently follow `main` or replace weights while mapped. There is no model
marketplace or automatic update. Current metadata supports validating/replacing
an old or invalid artifact, without deleting a verified good final to start a
download. Keep the same revision on every phone in a comparison.

## Concurrency And Lifecycle

All native model/context operations run on one Kotlin worker. The TypeScript
admission queue additionally coordinates installer mutation with native work,
accepts up to 128 outstanding requests, and bounds document calls to 1000 items.
Inference never runs on the Android UI thread. Download/hashing and diagnostic
PSS/file-export work also run on native workers.

Installed and loaded are separate. Loading is explicit and lazy, duplicate loads
are serialized and same-path idempotent, unloading is repeatable, and failures
leave a recoverable engine. No automatic idle unloading is enabled. Model unload
does not remove the installed file.

Queued cancellation skips execution. Active inference/load cancellation is
cooperative via llama.cpp callbacks, not hard preemption. The adapter drains the
terminal result before releasing its file-mutation lock. Recurrent/KV state is
cleared around each embedding and after cancellation. A hung native backend must
not be force-freed or have its mapped file removed; restart the app if a genuine
backend hang prevents cooperative draining. Cancellation does not roll back
already completed items or a committed installation.

Batching currently means ordered **sequential** execution on one context. Lab
tests use chunks of at most ten, sample between chunks, and discard vectors after
summarizing. Failed/cancelled chunks expose no partial vectors, so their missing
measurements are labeled unreported, not fabricated.

Native environment and Lab controller are module/process singletons. Angular
root recreation reattaches signals without creating another controller; page
destruction only stops page polling. There are no retained Activity references.
Application background/foreground does not explicitly unload or destroy the
engine. This does not confer guaranteed background execution: no embedding
foreground service, wake lock, or WorkManager job is added. Android may suspend
or kill the process. Installer metrics survive process interruption; Lab inference
reports are in-memory, so export before force-stop or process termination.
Existing foreground generation is not repurposed or stopped by the Lab.

## Measurements And Export

The Lab has Device, Installation, Runtime, Single Embedding, Similarity,
Cross-Language, Benchmarks, and Export sections. Normal use requires no logcat.

Installation records expected/downloaded bytes, percentage, elapsed, recent and
average transfer rates, TTFB, verification/finalization/total durations, storage
before/after, attempts, errors, cancellations, and interrupted checkpoints.
Those metrics are never included in native load or inference latency.

Device snapshots include manufacturer/model, Android/SDK/ABI, reliable SoC fields,
total/available RAM, process PSS, native/Java heaps, battery percentage/temperature,
thermal status and low-memory state where Android exposes them. RSS is currently
unavailable, not a guessed value. PSS deltas are observed process impact, not exact
model RAM; mmap file size is not used as a RAM estimate. Sampled peaks can miss
brief allocation peaks.

Single results show token count, native timing, norm, finite/dimension validation,
first 12 values and cold/warm metadata. Similarity and Spanish/English rankings
use production query/document paths and computed cosine, never preset scores.

Short/~128/~256/near512 inputs are sized with the actual tokenizer. Cold means
unloaded -> measured load -> first inference, not flushed OS caches. Warm tests
never load implicitly; first-inference metadata discloses whether the context had
actually run before. An explicit warm-up button is available. Tests report total,
tokenizer/diagnostic overhead, inference-only, mean/median/nearest-rank P95,
document/token throughput, errors/cancellations, memory samples and thermals.
The manual 1000 test requires confirmation and stops on Android low memory or
severe thermal status (3+). It never attempts intentional OOM.

Copy produces a concise standardized report. JSON schema version 1 retains the
latest 20 benchmarks/loads, 50 errors, and bounded samples. Serialization builds
fresh whitelisted objects: no raw text, vectors/previews, absolute paths, URLs,
chat/session data, credentials, or unique device identifiers. JSON files are
written locally to a bounded private cache directory and shared only through an
Android FileProvider and user chooser. There is no automatic upload. Choose a
local/offline share recipient when data must stay on-device.

## Build And Automated Verification

Toolchains: JDK 17, Gradle 8.14.3, native AGP 8.11.1/Kotlin 2.1.21,
NDK r28c `28.2.13676358`, CMake 3.31.6, compile/target SDK 35, min SDK 24.
The AAR is arm64-v8a only, portable ARMv8-A CPU, at most four threads, with
llama.cpp/ggml/libc++ statically linked into `libsam-embeddings.so`. No GPU backend,
OpenMP or vendor accelerator is required. ELF LOAD and APK ZIP alignment are
checked for 16 KB pages; actual 16 KB-device execution still needs validation.

From the repository root:

```sh
node --experimental-test-module-mocks --import ./src/test-loader.mjs --test src/core/*.test.ts src/core/**/*.test.ts src/app/embeddings/*.test.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/ngc --noEmit
bash native/scripts/validate-host.sh
bash scripts/build-android.sh
node scripts/check-embedding-artifacts.mjs
```

The native build script also builds the instrumentation APK and runs Kotlin JVM
tests. Direct app Gradle verification after NativeScript preparation:
`platforms/android/gradlew -p platforms/android app:assembleDebug --console=plain`.
NativeScript build: `ns build android --no-hmr`. The consuming Gradle file tracks
the local AAR as a metadata-generator input to prevent stale NativeScript bridge
metadata. Package checks confirm JNI identity, public bridge names, no model,
report provider, debug signature and alignment.

Host validation downloads the exact hash-verified model only to `/tmp/opencode`.
It builds/runs the same C++ engine, not a server. Tests cover real dimensions,
normalization, repeat stability, English/Spanish rankings, UTF-8, literal prefixes,
512/513 token acceptance/rejection, native abort recovery and load/unload. Mocked
TypeScript tests cover installer states, ordering, cancellation, load failures,
removal safety, workload statistics, privacy and UI reattachment. Java helper tests
cover file integrity, redirect restrictions and diagnostics/export bounds;
commands are in the installer notes.

Outputs:

- Debug APK: `platforms/android/app/build/outputs/apk/debug/app-debug.apk`
- Reusable AAR: `native/build/outputs/aar/sam-embeddings.aar`
- Native instrumentation APK: `native/build/outputs/apk/androidTest/debug/sam-embeddings-debug-androidTest.apk`

These are development-signed artifacts, not a release signing setup. Raw AAR
consumers must add Kotlin stdlib (2.1.21 or compatible newer runtime); see the
native README. Source/vendor/build outputs are not model packaging locations.

Implementation verification: 243 project/core/Lab tests passed, nine Kotlin JVM
tests passed, TypeScript and Angular compilation passed, shared-engine host
numerical validation passed with the exact official Q8_0, and AAR/instrumentation
packaging plus both direct Gradle and NativeScript debug builds passed. Java
helper validation passed 38 installer checks and 29 diagnostics/export checks.
The final package checker verified the AAR's native library matches the APK and
that all three public NativeScript bridge classes are present in metadata.

No physical device was attached during implementation. Host embeddings and
automated builds do **not** prove Android JNI execution, OEM file behavior,
NativeScript rendering, network rates, temperatures or phone memory usage. Those
remain physical acceptance checks. No phone benchmark values are supplied as
though measured.

## Same Sequence On Every Phone

Run on S24 Ultra, S24, and A56 with the same APK and pinned model revision. Use
comparable battery/charging state, cool starting temperatures, Wi-Fi conditions
and benchmark order. Note Exynos/Snapdragon/model differences using reported
SoC information, not device-name assumptions. Keep the app foreground for the
baseline throughput comparison; background interruption is a separate test.

1. Install the debug APK through the phone's normal APK installer. Do not uninstall an existing SAM with valuable data solely for this test; uninstall deletes app-private data. A genuinely fresh phone starts without a model.
2. Open SAM's menu, then Embeddings Lab. Wait for startup verification/recovery to finish.
3. Tap Sample device. Record device, battery, thermal, storage and memory baseline. Confirm the model is not installed on a fresh app.
4. Tap Download / retry. This downloads the official Q8_0 model through the app, without adb or manual copying.
5. Watch progress, speed and verification. Wait for installed, then record TTFB, download, verification, finalization, total time and available storage. Do not count these as inference.
6. Tap Load model. Wait for ready.
7. Record native load milliseconds, PSS before/after and observed process delta.
8. Enter a short text. Choose Query mode and Embed input; then Document mode and Embed input. Check 1024 finite values, norm near 1, token count and warm flag.
9. Run Rank A / B / C and Run correctness diagnostics. Related account-recovery content should beat the unrelated cooking document; repeat-input difference should be small.
10. Run Rank English documents for the fixed Spanish query. Record the actual ranking; do not expect fixed scores.
11. To measure cold explicitly, unload, choose Short, and tap Cold: load + first inference. Then run Warm / 1 document for Short, ~128, ~256, Near 512 in that order. Repeat runs for more single-case observations. Actual token counts must be shown and no input may exceed 512.
12. Select ~128 tokens and run Warm / 10 documents.
13. Keep ~128 selected and run Warm / 100 documents.
14. Optionally run Manual / 1000 documents and explicitly confirm. Watch progress, memory and thermals. Cancel if needed; never run this automatically.
15. Tap Sample device after completion. Record temperature/thermal status and any safety stop or memory pressure.
16. Unload model. Installed status must remain intact.
17. Load model again.
18. Generate one embedding to verify recovery; its first-inference warm flag should be false.
19. Tap Copy human report. Retain it alongside the phone model and APK identity.
20. Tap Share / save JSON and select a local destination. Retain the schema version/model revision with results for cross-device comparison.

## Physical Fault And Lifecycle Pass

Do this separately from baseline performance measurements. Do not intentionally
exhaust RAM or fill a phone's storage to failure.

- Cancel a download midway, reopen the page, observe partial, and retry from zero. If it finished writing before cancellation, Install partial must still verify first.
- Interrupt the network during download, restore connectivity, and retry. Confirm no partial can be loaded.
- Force-stop SAM during download or verification using Android App info, then reopen. Confirm interrupted/partial or startup revalidation, never falsely ready. Export preexisting Lab reports before force-stop.
- Reopen an already valid installation and verify again; no second model download should be required. Remove, reinstall through the UI, and load again.
- Cancel a batch, wait for draining, then embed another query. Repeat load/unload and benchmark cycles while watching process memory for sustained growth.
- Rapidly navigate away/back and rotate the device during work. The UI should reattach to the same work/results without another load or download.
- Background/foreground during a batch, including while an existing generation foreground service keeps SAM alive. Confirm neither subsystem cancels the other. Mark interrupted benchmark runs as unsuitable for baseline timing comparisons.
- Use large system text and landscape orientation. Confirm wrapped controls, visible progress/error text, cancellation and scroll access to Export.
- Use an oversized text and verify structured actual/max-token rejection, then retry a short text. Empty input must not crash.
- Native instrumentation/helper tests cover invalid paths/corrupt fixtures/init failures; do not manually alter a mapped model or deliberately OOM a physical device.
