# Embedding Batching And Energy Reports

## Scope And Loaded Limits

Schema 2 adds measured batching and raw battery diagnostics to the existing
installation, load, single-inference and sequential benchmark fields. It does not
select a production profile. Host tests are not evidence of phone performance,
energy efficiency or sustained thermal behavior.

The native correctness fix uses eight private KV streams (`kv_unified=false`),
each with a 512-token context. Unified KV changed attention-reduction alignment
with packing order and failed the host cosine gate. This configuration avoids
that observed discrepancy; the representative multilingual count/order,
dimensions, finite-values and cosine gate must still pass on each device.
It is not exhaustive production correctness certification.

Expected loaded values for this build are below. Reports export the **actual
loaded values**, never substitute these expected constants for missing readings.

| Limit | Expected value |
| --- | ---: |
| `nBatch` | 1024 |
| `nUbatch` | 1024 |
| `nCtx` | 4096 |
| `nCtxSeq` | 512 |
| `maxParallelSequences` | 8 |
| `backendMaxParallelSequences` | 256 |

The backend ceiling of 256 is not allocated capacity. The token budget is the
minimum of the requested token policy, `nBatch`, `nUbatch` and `nCtx`. Equal-token
capacity is bounded by that budget divided by actual tokens per document, the
loaded sequence limits, and the requested sequence policy. Every document must
also fit `nCtxSeq`. Prefix and BOS tokens count toward the actual token length.

| Actual tokens/document | Maximum fitting sequences | Requested matrix targets |
| ---: | ---: | --- |
| 24 (short) | 8 | 1, 2, 5, 10, 20, 50, 100 |
| 128 | 8 | 1, 2, 5, 10, 20, 50 (optional) |
| 256 | 4 | 1, 2, 5, 10, 20 (optional) |
| 512 (maximum) | 2 | 1, 2, 5, 10 (optional) |

Larger requests are capped, not evidence of larger actual batches. The optional
128-token/50-target, 256-token/20-target and maximum-token/10-target tiers are
skipped when they cannot fit their requested target. Their exported reasons name
the target, actual tokens, required token count, loaded token budget,
per-sequence context, sequence limit and fitting capacity. Nonoptional capped
tiers remain visible, including duplicates of the same effective policy.

`true_batch` describes multi-sequence native API packing. The exported
`backendSequenceExecution: "serial_ubatches"` means this backend processes
sequence microbatches serially, **not true parallel sequence compute**. Do not
infer parallelism from the API name, target, chunk length or backend ceiling.

## Schema And Retention

The platform-neutral service preserves the ordered `embedDocuments()` array
result and adds `embedDocumentsMeasured()` for decode-level telemetry:

```ts
const batch = await service.embedDocumentsMeasured!(documents, {
  signal,
  batchMode: 'true_batch', // 'sequential' forces one sequence per native decode
  batchingPolicy: { maxSequencesPerBatch: 5, maxTokensPerBatch: 1024 },
});
// batch.embeddings preserves input order; batch.metrics describes actual decodes.
```

The measured capability is optional in the portable interface, but is implemented
by the Android adapter; the Lab refuses a missing capability rather than silently
falling back. Unspecified policy uses request ceilings of 100 sequences and 4096
tokens, capped by the loaded allocation limits. These ceilings are not a tuned
production recommendation. Single query/document calls retain real timing;
individual items in multi-document requests have `inferenceDurationMs: null`.

The AAR retains `embedBatch(String[])` and adds the asynchronous polling method
`embedBatchWithOptions(String[], String, int, int)`. The latter returns
`{ embeddings, metrics }`. Failed/cancelled requests publish no partial vectors
or metrics; completed earlier Lab requests remain recorded. CPU decode has a
cooperative abort callback, not hard preemption, and subsequent native packs and
queued cancelled requests do not execute. The engine remains reusable after
recoverable failures. Process kills, upstream assertions and a kernel OOM kill
cannot be recovered by an in-process exception handler.

`batchComparisons` preserves comparison status, requested document count and
target prefix, actual/target tokens, sizing cost, loaded limits and the separate
correctness gate. Each run includes requested/effective policy and batch size,
fitting capacity, actual per-decode sequences/tokens/native milliseconds,
native preparation and elapsed time, API wall time, warm wall time, throughput,
initial/middle/final blocks and their availability reasons. Failures, skips,
cancellation, unreported atomic work and sanitized errors are retained.

Samples include raw battery counters, current, status, plugged state and
monotonic timestamps as well as thermal state, temperature, PSS, native/Java
heap and available RAM. Before/after/latest samples, accumulated sample peaks,
minimum available RAM and thermal/temperature progression are separate fields.
Sample peaks may miss transient peaks. PSS deltas are observed process changes,
not exact model RAM. Accumulated peaks precede the runner's sample compaction.

All objects are constructed from explicit field whitelists. No input/corpus
text, vectors, private paths, URLs, credentials or device identifiers are
exported. Arbitrary adapter properties and serialization hooks are not copied.
Nonfinite/unavailable metrics become JSON `null`, not zeros. Known error messages
and diagnostic reason templates are reconstructed or allowlisted; unknown
reason text is explicitly omitted rather than copied into the report.

Retention ceilings are 10 comparisons, all seven supported tiers per retained
comparison, 1000 decodes per tier, 128 samples per run, 20 legacy benchmarks,
20 loads and 50 lab errors. The runner permits at most 1000 documents, so 1000
decode records retain even a sustained sequential baseline without truncation.
Out-of-contract array excess has explicit omission counts. `sampleCount`
records the runner's total before compaction, while export omission counts
describe additional omissions from the arrays supplied to the report builder.

The Android exporter currently has a **1 MiB UTF-8 limit**, not 2 MB. Schema 2
uses compact JSON and bounds the serialized report to that same limit. When
necessary it removes oldest complete comparisons, then old legacy benchmarks,
loads and errors, preserving the newest comparison preferentially. If even
that comparison cannot fit by itself, it is omitted whole with an explicit
count. It never drops individual tiers to fit the byte budget. Check
`retention.omittedBatchComparisons` and other omission counts; export after each
sweep when a complete multi-sweep archive is required. Report construction does
not change the controller's retained data.

## Timing And Conclusions

Batch warm measurements exclude corpus sizing, the correctness gate, model
loading, verification and downloading. Warm wall time includes safety
checkpoints and drained failed calls. Atomic rejected calls can execute native
work without trustworthy item results; `unreportedItems` makes this visible.
Successful throughput counts only completed, validated documents and tokens.

`effectiveMsPerDocument` is amortized warm wall time divided by completed
documents. It is **not interactive query latency**. The human report separately
shows actual existing warm single-query native measurements. These individual
observations do not supply end-to-end query latency percentiles. Legacy
single-document latency statistics retain their existing meaning.

The compact comparison table shows requested versus observed batch size,
outcome, completed work, wall/decode timing, throughput, amortized time and
energy normalization. Initial/middle/final throughput and sample memory/thermal
progression help identify sustained degradation rather than just a short burst.

Only successful, correctness-passed, equivalent-work runs within one shared
corpus sweep can receive a descriptive **fastest observed in this sweep**
summary, and only when more than 10% separates the top two observations. The
10% rule is a conservative display/noise screen, not statistical significance.
Missing measurements, mismatched work/tokens/loaded limits/token policy,
incomplete results or capped duplicate effective policies cannot produce that
claim. Independent comparisons are not pooled: the current comparison contract
does not snapshot historical corpus/model/configuration identities.

There is no production winner, energy ranking or production profile. A single
sweep is not independent repeated evidence and cannot establish an **observed
throughput leader**. Replicated, equivalent-work physical-device results are
required before making such a claim, even if one sweep looks substantially
faster. Interactive latency and bulk throughput are different objectives.

## Battery Interpretation

| Raw field | Unit/meaning |
| --- | --- |
| `chargeCounterUah` | Remaining charge, microampere-hours (uAh) |
| `currentNowUa`, `currentAverageUa` | Signed current, microamperes (uA) |
| `energyCounterNwh` | Remaining energy, nanowatt-hours (nWh) |
| `elapsedRealtimeMs` | Monotonic sample time, milliseconds |
| `plugged`, `status` | Plugged state and Android battery status |

Integer counters and decimal native timing values retain their numeric precision
in JSON. Estimates are mAh and mWh, with mAh/100 documents, mWh/100 documents and
mWh/1000 tokens where normalization is valid. Human energy columns show six
decimal places so small counter estimates do not become apparent zeroes;
display precision is **not** sensor accuracy.

Counter differences measure the **whole device including screen and system**,
not energy attributable solely to the app or model. Battery percentage is
display-only and never used to derive energy. Current is not integrated, charge
is not converted using an assumed voltage, and missing counters remain missing.

The energy policy requires reliable unplugged, explicitly discharging samples
(Android status 3), strictly increasing monotonic time and a window of at least
60 seconds. Each usable counter needs at least ten observed decreases, no
single step above 10% of the total decrease, and a minimum delta of 10 uAh or
10000 nWh. Resets, increases, implausible intervals, contradictory positive
current, unsupported values and inconsistent charge/energy deltas invalidate
the affected estimates. Ten changes screen obvious vendor quantization; the
largest observed step is not a known vendor least-significant bit or calibrated
resolution. Even accepted values remain `counter-estimate` measurements with
`observed-step-screened` resolution, not precise attribution.

Charge and energy have independent availability reasons. Short/coarse windows
remain unavailable with reasons and raw retained samples, never artificial
zero consumption. Work windows containing unreported native work do not have
per-document or per-token efficiency normalization.

## Physical Protocol

1. Use physical Samsung S24 Ultra, S24 and A56 devices. Record model/backend
   revisions and actual loaded limits. Do not substitute host test speed for
   phone measurements or select a production profile from it.
2. Download, verify, install and preload the same model **before** measurement.
   Keep these operations, corpus sizing and the correctness gate outside warm
   inference energy windows. Wait for installation/loading heat to dissipate.
3. Begin cooled and unplugged, at equivalent battery/thermal conditions. Keep
   screen brightness/state, power mode, background activity, network conditions
   and model/thread configuration equivalent. Record RAM, PSS, heap, thermal
   and battery samples throughout; do not bypass safety stops or missing safety
   diagnostics to obtain a larger tier.
4. Reuse the exact same prebuilt corpus, document order, document count and
   actual token count for every tier. Run the ascending safety matrix or its
   ascending prefix, not an unchecked jump to a large requested target. Verify
   representative correctness before interpreting throughput.
5. Start with the default **100 documents** for bounded diagnostics. A sustained
   **1000-document** battery experiment needs explicit user confirmation of the
   longer runtime, battery drain and heating. This is a maximum, not a guarantee
   of a usable 60-second/ten-change counter trace. The report does not authorize
   or implement confirmation; the execution caller must obtain it before running.
6. For battery work, confirm unplugged/discharging status and sufficient sample
   resolution. If the window is too short or quantized, retain the unavailable
   result and reason. Do not manufacture a reading from battery percentage or
   silently increase the workload beyond the confirmed count.
7. Export each sweep, cool back to equivalent conditions, and repeat independent
   sweeps across all three device classes. Ascending order can confound tier
   effects with heating; examine initial/middle/final rates and repeat/cool
   rather than calling adjacent capped targets independent replications.
8. Measure warm single-query latency separately for interactive use. Evaluate
   bulk throughput, sustained thermal behavior, memory pressure and device-wide
   energy estimates as distinct objectives. Leave production selection pending
    until replicated, comparable device evidence supports it.

## Local Verification

Verified on the development host on 2026-09-07:

- Project Node tests, TypeScript `tsc --noEmit` and Angular `ngc --noEmit` pass.
- `bash native/scripts/validate-host.sh` passes using the hash-verified Q8_0
  artifact. Minimum normalized-vector sequential/batched cosine is
  `0.9999999974086187`, with no failures of the unchanged `0.99999` gate.
- The 19 private-stream isolation cases are bit-identical, and all ten
  query/document comparisons against the original one-sequence context have
  zero raw difference. Native allocation/failure/cancellation recovery, token
  and sequence packing, ordering, partial packs and repeated runs pass.
- A forced fresh Kotlin JVM run passes all 12 tests. Java helper checks pass:
  58 battery-property checks, 29 diagnostics/export checks and 38 installer
  integrity/redirect checks including the official model fixture.
- `bash scripts/build-android.sh --console=plain` builds the release AAR,
  instrumentation APK and debug application APK. Artifact validation checks
  no bundled model, exact AAR/APK JNI identity, batch bridge metadata, ARM64,
  ELF/ZIP 16 KB alignment, report provider and debug signature.
- The pinned llama.cpp vendor tree is unchanged.

Artifacts are `native/build/outputs/aar/sam-embeddings.aar` and
`platforms/android/app/build/outputs/apk/debug/app-debug.apk`; the model-free
instrumentation APK is under `native/build/outputs/apk/androidTest/debug/`.
Android instrumentation and physical latency/throughput/PSS/thermal/energy
measurements have **not** run. No phone benchmark or production-policy conclusion
is inferred from these host acceptance checks. NativeScript reports an existing
unsupported `--console` option warning and SDK-tools XML-version warning; neither
prevented the build.
