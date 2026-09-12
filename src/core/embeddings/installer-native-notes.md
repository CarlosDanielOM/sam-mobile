# Android Installer Bridge

The Java implementation lives exclusively in
`App_Resources/Android/src/main/java/com/sam/embeddings/`. It requires the existing
OkHttp 4.12 and AndroidX Core dependencies and Android API 24+, compiling against API 35. It does not
modify Gradle, the manifest, TypeScript, or the inference AAR.

## Public Methods

```java
com.sam.embeddings.SamModelInstaller.getInstance(android.content.Context): SamModelInstaller
installer.getStatus(): String
installer.getModelMetadata(): String
installer.getInstalledModel(): String
installer.getRequiredStorage(): String
installer.download(): void
installer.cancelDownload(): void
installer.verify(): void
installer.install(): void
installer.remove(): void

com.sam.embeddings.ModelCatalog.getModelMetadata(): String
com.sam.embeddings.SamDeviceDiagnostics.snapshot(android.content.Context): String
com.sam.embeddings.SamDeviceDiagnostics.sample(android.content.Context): String
com.sam.embeddings.SamDeviceDiagnostics.exportReport(android.content.Context, String json): String
com.sam.embeddings.SamDeviceDiagnostics.poll(String requestId): String
```

Installer `String` results, diagnostics `snapshot()`, and diagnostics `poll()` are
JSON. Diagnostics `sample()` and `exportReport()` instead return opaque request ID
strings, not JSON. The installer's literal string `"null"` means no verified
installed model is available. Pass a context with a non-null application
context. Only the application context is retained; no Activity is retained.

The singleton is process-local. Use it from the main app process, and do not give
other components write access to its files. Inference must only read the path
returned by `getInstalledModel()`. The installer never loads or unloads inference.

## Operation Contract

- Initialization immediately returns a `verifying` snapshot with `busy: true`,
  then performs private-directory setup, metadata recovery, and final-file hashing
  on the worker. Wait for `busy: false` before offering operations.
- All mutation methods return immediately and use one serial executor. **Every
  command while busy is a no-op**, except `cancelDownload()`. This includes
  `remove()` and commands during recovery; poll status and retry after idle.
- `download()` checks any existing final, returns idempotently for an unchanged
  hash-verified installation, otherwise deletes only the old `.part`, downloads
  from byte zero, verifies size and SHA-256, and atomically finalizes. It does not
  resume or send `Range`/`If-Range`. A completed partial is also restarted by
  `download()`; use `install()` to verify and finalize it without downloading.
- `cancelDownload()` cancels the active OkHttp call or stops the download's
  verification before the rename commit point. Poll until idle before retrying.
  Partial bytes can remain but are never exposed to inference. Cancellation after
  the commit point does not roll back the verified installation. It does not
  cancel independent `verify()`, `install()`, `remove()`, or recovery operations.
- `verify()` always rehashes the final if present, temporarily withholding its
  installed path. If the final is invalid or absent it checks the partial. A valid
  partial remains `partial`, with `verificationProgressPercent: 100`; verification
  alone does not rename it. No model yields `not_installed` with `NO_MODEL`.
- `install()` returns idempotently for an unchanged verified final. Otherwise it
  checks the existing final, then fully verifies a completed partial and finalizes
  it. An incomplete or corrupt partial yields `invalid` and is not renamed.
- `remove()` requires the parent runtime to **unload inference first**. It deletes
  only this artifact's final/partial and known temporary metadata, not the models
  directory or other models. Small metadata remains to preserve attempt history.
  The parent must not reload inference until removal has finished.
- Retry `download()` after network, cancelled, corrupt, or stale-partial failures.
  Retry `verify()`/`install()` after transient storage or metadata failures. Failed
  cleanup is explicit (`DELETE_FAILED`), not silently ignored.

## Metadata Schema

`getModelMetadata()`, `ModelCatalog.getModelMetadata()`, and every `model` property
use exactly this shape. Native metadata is the adapter/UI's source of truth.

```json
{
  "modelId": "LiquidAI/LFM2.5-Embedding-350M",
  "repository": "LiquidAI/LFM2.5-Embedding-350M-GGUF",
  "revision": "a80de9c5b941d429104f0038292a0ef5a860e486",
  "filename": "LFM2.5-Embedding-350M-Q8_0.gguf",
  "expectedBytes": 379216640,
  "sha256": "6ec5f8e8750dbc8a0e40c431fd1b7b07a13688136b2244c5a1364b54d9032599",
  "dimensions": 1024,
  "maxTokens": 512,
  "quantization": "Q8_0",
  "format": "GGUF",
  "downloadUrl": "https://huggingface.co/LiquidAI/LFM2.5-Embedding-350M-GGUF/resolve/a80de9c5b941d429104f0038292a0ef5a860e486/LFM2.5-Embedding-350M-Q8_0.gguf"
}
```

The official tree endpoint was checked during implementation:
<https://huggingface.co/api/models/LiquidAI/LFM2.5-Embedding-350M-GGUF/tree/main>.
The download itself is pinned to the immutable revision, not `main`.

## Status Schema

```typescript
type InstallerState = 'not_installed' | 'downloading' | 'partial' | 'verifying'
  | 'installing' | 'installed' | 'invalid' | 'error';
type Operation = 'recovery' | 'download' | 'verify' | 'install' | 'remove';
type InstallerError = { code: string; message: string };
type TimedError = InstallerError & { timestamp: number };

interface InstallerStatus {
  state: InstallerState;
  busy: boolean;
  operation: Operation | null;
  downloadedBytes: number;
  expectedBytes: number;
  progressPercent: number;
  verifiedBytes: number;
  verificationProgressPercent: number;
  elapsedMs: number;
  recentBytesPerSecond: number;
  averageBytesPerSecond: number;
  availableStorageBytes: number;
  installedBytes: number;
  model: ModelMetadata; // Exact object above.
  metrics: InstallerMetrics;
  error?: InstallerError;
}

interface AttemptMetrics {
  operation: Operation;
  startedAt: number;
  completedAt?: number;
  outcome: 'running' | 'success' | 'error' | 'cancelled' | 'interrupted';
  downloadDurationMs: number;
  verificationDurationMs: number;
  finalizationDurationMs: number;
  totalElapsedMs: number;
  networkBytes: number;
  averageBytesPerSecond: number;
  timeToFirstByteMs: number | null;
  availableStorageBeforeBytes: number;
  availableStorageAfterBytes: number | null;
  error?: InstallerError;
}

interface InstallerMetrics {
  // Empty during initial setup. Counters appear when the first attempt starts.
  downloadAttempts?: number;
  verificationAttempts?: number;
  installAttempts?: number;
  removeAttempts?: number;
  failures?: number;
  cancelled?: number;
  interrupted?: number;
  lastAttempt?: AttemptMetrics;
  lastDownload?: AttemptMetrics;
  lastSuccessfulInstall?: AttemptMetrics;
  lastInterruptedAttempt?: AttemptMetrics;
  lastVerification?: {
    durationMs: number;
    bytes: number;
    valid: boolean;
    source: 'installed' | 'partial';
    timestamp: number;
  };
  lastError?: TimedError;
  lastPersistenceError?: TimedError;
}
```

- `getStatus()` only parses a small published JSON snapshot and performs storage
  and verified-file identity stats. It does not read model contents, hash, scan
  directories, or wait for the worker. Polling around 250-500 ms is sufficient.
- `progressPercent` represents artifact bytes present, **not overall completion**.
  It can be 100 while hashing or still `partial`. Use `state`, `busy`, and
  `getInstalledModel()` to decide availability. `installedBytes` counts only a
  trusted final, not an invalid final's disk usage.
- `partial` does not mean verified. A cancelled or network-failed attempt may have
  a complete-sized partial whose hash has never been checked. Errors can accompany
  `partial`, `not_installed`, or `installed`; a metadata/cleanup failure does not
  discard an independently verified good final.
- All durations use `SystemClock.elapsedRealtime()` and are milliseconds. Wall
  timestamps are epoch milliseconds. Total elapsed covers worker attempt work,
  excluding the final metrics persistence bookkeeping. Download duration includes
  HTTP setup, redirects, transfer, and payload fsync, not hashing or inference.
  TTFB measures the first payload byte from the start of the HTTP operation.
- `networkBytes` counts payload bytes successfully written during this attempt,
  not cached bytes or HTTP headers. Average speed uses that count and measured
  download duration. Recent speed samples roughly 500 ms of transfer and becomes
  zero after two seconds without new bytes, or outside `downloading`.
- Verification duration accumulates all integrity checks in the attempt, including
  an invalid old final before a replacement. `verificationAttempts` counts each
  such check (including recovery); other attempt counters count accepted commands.
  Failures count failed operations, cancellations separately, not every rejected
  old artifact during a successful repair.
- Metrics and errors persist through `AtomicFile`. Checkpoints are around two
  seconds apart while bytes are moving, plus phase transitions and completion.
  Interrupted durations reflect the last measured checkpoint, never invented time
  while the process was dead. `lastSuccessfulInstall` survives later recovery,
  verification, removal, and unsuccessful downloads. `lastError` is historical;
  top-level `error` describes the current result or a recovered partial's result.
- `availableStorageBytes` and other storage measurements use `-1` for unavailable,
  including before asynchronous storage setup. The installer fails closed if it
  cannot measure storage for download/finalization.

Expected error codes are `CANCELLED`, `INTERRUPTED`, `NO_MODEL`, `SIZE_MISMATCH`,
`HASH_MISMATCH`, `FILE_CHANGED`, `HTTP_ERROR`, `HTTP_ENCODING`, `HTTP_SIZE`,
`DOWNLOAD_INCOMPLETE`, `UNSAFE_REDIRECT`, `TOO_MANY_REDIRECTS`, `UNSAFE_PATH`,
`STORAGE_UNAVAILABLE`, `INSUFFICIENT_STORAGE`, `DELETE_FAILED`, `METADATA_IO`,
`METADATA_RECOVERED`, `NETWORK_IO`, and `STORAGE_IO`. Treat codes as extensible.
Raw exception text and signed redirect URLs are never published or persisted.

## Installed And Storage Results

```typescript
// getInstalledModel(), parsed:
type InstalledModel = null | {
  path: string; // Absolute app-private final path. Never a .part path.
  model: ModelMetadata;
  bytes: number; // 379216640
};

// getRequiredStorage(), parsed:
type RequiredStorage = {
  availableBytes: number; // -1 when unknown
  requiredBytes: number; // 513434368 = complete artifact + headroom
  headroomBytes: number; // 134217728 = 128 MiB
};
```

The storage result is a conservative **fresh-download budget**, even when already
installed or a partial exists. It does not credit the old partial or promise that
another app will not consume free space. Existing valid installs are idempotent
without this budget. Finalization only needs the headroom because it renames rather
than copying. Storage is checked again during download and before finalization.

## Durability And Security

The owned files are under `context.getNoBackupFilesDir()/models`:

- `LFM2.5-Embedding-350M-Q8_0.gguf`
- `LFM2.5-Embedding-350M-Q8_0.gguf.part`
- `sam-embedding-install.json` and its `AtomicFile` `.bak`/`.new` files

Android excludes `noBackupFilesDir` from automatic backup without a manifest
change. No shared/external storage or caller-supplied paths are accepted. Worker
operations reject symlinks, hard-linked model/metadata files, and nonregular files
beneath the canonical private root. Integrity verification checks file identity
before/after hashing and again before finalization; status/installed getters also
withhold a final whose identity, size, or modification time changed.

Downloads start at the official immutable HTTPS URL. Automatic redirects and
automatic connection retries are disabled. At most five redirects are followed,
only to HTTPS port 443 with no userinfo on `huggingface.co`, `hf.co`, or their
dot-boundary subdomains (including `cas-bridge.xethub.hf.co`). No credentials,
cookies, or custom trust manager are used. Nonallowlisted future CDN hosts fail
closed and require a reviewed catalog/policy update. Responses must be full HTTP
200 with no `Content-Range` or nonidentity encoding; byte count is bounded even
when content length is absent. Official SHA-256 remains the final authority.

The payload is fsynced, then `.part` is renamed to final on the same filesystem.
There is **no second full copy** and no deletion/overwrite of a verified good final
to begin downloading. Directory entries and metadata are synced. Atomic metadata
write completion is checked because Android's `AtomicFile` can log some rename
failures without throwing. Metadata is bounded when read and is never proof of
model integrity. Every process restart asynchronously rehashes any final before
publishing its path, even if persisted metadata says `installed`. A complete
partial is never automatically blessed. A crash after rename but before metadata
commit is recovered by rehashing the final.

There is no foreground service, wake lock, or WorkManager integration. **Downloads
are not promised to survive OS kill, force-stop, app exit, or suspension.** Killing
the process can leave a partial or interrupted verification; persisted `active`
attempts become `interrupted`. Intentional cancelled/error partials retain their
persisted result rather than being relabeled as interrupted. The app must reopen
the installer, wait for recovery, then explicitly retry. App uninstall deletes
the private installation. This is installation telemetry, not inference speed,
inference readiness, embedding quality, or runtime memory benchmarking.

## Diagnostics Schema

```typescript
interface DeviceDiagnostics {
  timestamp: number; // epoch ms
  manufacturer: string;
  model: string;
  androidVersion: string;
  sdk: number;
  abi: string | null; // first device-supported ABI, not a guessed CPU model
  supportedAbis: string[];
  soc?: { model: string; manufacturer?: string }; // reliable Build.SOC_* only, API 31+
  totalRamBytes: number | null;
  availableRamBytes: number | null;
  appPssBytes: number | null; // Debug total PSS, KiB converted to bytes
  nativeHeapBytes: number; // allocated native heap, not all native mappings
  javaHeapBytes: number; // Runtime.totalMemory - freeMemory
  batteryLevel: number | null; // percent 0..100, not a fraction
  batteryTemperatureC: number | null;
  thermalStatus: number | null; // Android 0..6, null before API 29/unavailable
  lowMemory: boolean | null;
  thresholdBytes: number | null;
}
```

`rssBytes` is intentionally omitted: no `/proc` scans are needed. Diagnostics read
only platform memory/build/power APIs and the battery sticky broadcast; no
receiver is retained and no extra permission, device identifier, or credential is
collected. Missing OEM data stays null, not a misleading zero. The preserved
`snapshot(Context)` API is synchronous and **throws `IllegalStateException` on the
main thread before sampling**. Background callers may still use it directly.
TypeScript/UI callers must use `sample()` and `poll()` below. Do not couple PSS
sampling to high-frequency download polling.

## Async Diagnostics And Export

All three new methods are static on `com.sam.embeddings.SamDeviceDiagnostics`:

```java
sample(Context context): String                       // opaque requestId
exportReport(Context context, String json): String    // opaque requestId, NOT void
poll(String requestId): String                       // JSON envelope below
```

`sample()` and `exportReport()` only admit a request on the caller thread. One
dedicated serial worker, separate from the installer/inference worker, performs
sampling, UTF-8 encoding, JSON validation, report file writes, fsync, cleanup, and
FileProvider lookup. Only application contexts are captured by queued tasks; no
Activity, callback into JavaScript, or long-lived receiver is retained.

```typescript
type DiagnosticsOperation = 'sample' | 'export_report';
type ExportResult = {
  chooserLaunched: true;
  filename: string;
  mimeType: 'application/json';
  bytes: number;
};
type DiagnosticsEnvelope = {
  requestId: string | null;
  operation: DiagnosticsOperation | null;
  state: 'pending' | 'completed';
  result: DeviceDiagnostics | ExportResult | null;
  error: { code: string; message: string } | null;
};
```

- Pending envelopes always have null `result` and `error`. Polling pending requests
  does not remove them and performs no sampling or file I/O.
- Completed success has an object `result` and null `error`. Completed failure has
  null `result` and an error object. `sample` results use the diagnostics schema
  above; `export_report` results use `ExportResult`.
- **The first terminal poll removes the result**, including errors. Unknown,
  consumed, expired, or previous-process IDs return `state: 'completed'`, null
  `operation`/`result`, and `error.code: 'UNKNOWN_REQUEST'`. Invalid-length/null IDs
  also return this envelope with null `requestId`.
- Unconsumed terminal results expire after ten minutes (monotonic time). At most
  16 unconsumed/pending requests are admitted. Reaching this bound throws a
  synchronous `IllegalStateException`; consume existing results before retrying.
- Only one export may be pending until its chooser launch completes/fails. A
  second export during this interval throws a synchronous `IllegalStateException`.
  Sampling remains available. This prevents retention cleanup from deleting a
  report whose chooser launch is still waiting on the main looper.
- Invalid contexts synchronously throw `IllegalArgumentException`. Report
  validation, sampling, file/provider, and launch failures use terminal envelopes.
  Async error codes: `DIAGNOSTICS_FAILED`, `INVALID_REPORT`, `REPORT_TOO_LARGE`,
  `UNSAFE_REPORT_PATH`, `REPORT_PROVIDER`, `REPORT_IO`, `SHARE_UNAVAILABLE`,
  `SHARE_LAUNCH_FAILED`, and `UNKNOWN_REQUEST`. Raw OS exception text/report content
  is not returned or logged.
- Requests are process-local, not durable jobs. Process death loses pending and
  completed results; there is no background-service survival guarantee.

Example adapter flow: obtain `id = sample(appContext)`, periodically call
`JSON.parse(poll(id))`, and stop polling immediately when `state === 'completed'`.
Use the same loop for `exportReport(appContext, whitelistedReportJson)`. No JNI
callback or JavaScript callback on a worker thread is needed.

## Local Report Sharing

`exportReport()` requires a JSON **object**, at most **1,048,576 UTF-8 bytes** and
64 object/array nesting levels. Malformed Unicode is rejected, not silently
replaced. Validation and encoding run on the worker; an O(1) string-length
admission check avoids retaining arbitrarily large input in the queue. Android's
`JsonReader` runs in nonlenient mode and requires end-of-document after the object.
The native method validates format/size, not semantic secrets: the parent must
supply its whitelisted report without credentials, tokens, private prompts,
identifiers, or other sensitive fields.

Reports use unique names, never a shared fixed filename:

```text
context.cacheDir/embedding-reports/sam-embeddings-report-<epochMs>-<requestUUID>.json
```

Successful preparation retains the current report plus the nine most recently
modified previous reports. Cleanup only considers names matching this exact owned
timestamp/UUID pattern in that directory. It does not recurse or delete unrelated
files. Directory symlinks, nonregular report files, and report hard links are
rejected. Failed preparation can leave a file if the OS refuses cleanup; a later
successful export retries retention. Cache eviction and the ten-report retention
window mean old shared files are not permanent storage.

The worker resolves a content URI through AndroidX `FileProvider` with authority
`context.getPackageName() + ".embeddings.reports"`. The main-looper handler calls
`applicationContext.startActivity()` with an `ACTION_SEND` chooser, MIME type
`application/json`, `EXTRA_STREAM`, `ClipData`, `FLAG_GRANT_READ_URI_PERMISSION`,
and chooser `FLAG_ACTIVITY_NEW_TASK`. There are no write grants, global recipient
pregrants, file:// URIs, automatic uploads, or direct network operations. Only the
user chooses a recipient; that recipient's subsequent handling is outside this
code's control.

`chooserLaunched: true` means `startActivity()` returned without throwing. It does
not confirm that Android displayed the chooser, that the user selected a target,
or that a recipient consumed the report. Android background-activity restrictions
still apply; invoke export following a visible, explicit user action.

The parent owns the required manifest/provider-path configuration. Use
`androidx.core.content.FileProvider`, authority `${applicationId}.embeddings.reports`,
`android:exported="false"`, `android:grantUriPermissions="true"`, and metadata name
`android.support.FILE_PROVIDER_PATHS`. Its XML must expose only this cache child:

```xml
<paths xmlns:android="http://schemas.android.com/apk/res/android">
  <cache-path name="embedding_reports" path="embedding-reports/" />
</paths>
```

No Gradle/manifest/XML edits are made by this implementation. Existing AndroidX
Core 1.13.0 supplies `FileProvider`. The model installer remains independent of
these cache reports. Review of `removeFiles()` found no missing `.bak` cleanup:
its preceding `persist()` must commit successfully and confirm both `.bak` and
`.new` are absent before removal starts; terminal persistence then retains metrics.
Deleting `.bak` blindly inside removal would bypass that recovery lifecycle.

## Verification

Standalone `javac --release 8 -Xlint:all -Werror` compilation uses Android API 35,
OkHttp 4.12, AndroidX Core/annotations, and the existing cached Okio/Kotlin jars. This is independent of app
Gradle. `tests/file-integrity.jsh` tests valid/corrupt/truncated/growing/missing
files, streaming/cancellation, redirect allowlisting, and public bridge signatures.
It optionally verifies a complete official artifact without modifying it.
`tests/diagnostics-requests.jsh` exercises pending/completed/error envelopes,
consume-once concurrency, request/chooser bounds, expiry, UTF-8 admission limits,
malformed Unicode, report filename scope, and all diagnostics bridge signatures.
For this test, put a JVM `org.json` jar before `android.jar` on the classpath;
Android's framework jar only contains runtime stubs.

With `CP` containing the Android/AndroidX/annotations/OkHttp/Okio/Kotlin jars and `OUT` an existing
temporary directory, run from the repository root:

```sh
javac --release 8 -Xlint:all -Werror -classpath "$CP" -d "$OUT" App_Resources/Android/src/main/java/com/sam/embeddings/*.java
jshell --class-path "$OUT:$CP" -R-Djava.io.tmpdir="$OUT" App_Resources/Android/src/main/java/com/sam/embeddings/tests/file-integrity.jsh
jshell --class-path "$JSON_JAR:$OUT:$CP" App_Resources/Android/src/main/java/com/sam/embeddings/tests/diagnostics-requests.jsh
# Optional full official fixture: add -R-Dsam.fixture=/absolute/path/to/model.gguf to jshell.
```

These tests do not execute Android framework stubs. Parent integration still
needs an app build and on-device checks for JSON/NativeScript bridging, cancellation
during network and hashing, process kill/recovery at each phase, real HTTP transfer,
low storage and fsync failures, removal after inference unload, and diagnostics
across API 24/29/31+. The Android JSON parser, filesystem retention/fsync, UI-thread
guard, FileProvider configuration, chooser dispatch, and read-only recipient
grants need on-device checks too. No app Gradle build, emulator, or device run is
performed here.
