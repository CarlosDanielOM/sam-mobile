# Durable sessions

A session is a durable context identity, not a generation, Activity, service, or
selected chat. UI selection never starts, pauses, cancels, or resumes execution.

## Boundaries

- `types.ts`: platform-independent domain and repository contracts.
- `session-engine.ts`: create/update/archive/restore, owned ancestry, work admission,
  and synchronous lifecycle subscriptions. No Angular, native, or SQL dependencies.
- `runtime-registry.ts`: process-local cancellation scopes and multiple work
  registrations per session. No durable work table or scheduler.
- `../persistence/`: SQLite and memory implementations of `SessionRepository`.
- `../generation/`: generation records, streams, telemetry, and the application-wide
  foreground adapter. The process singleton owns the shared session engine.
- `session-store.ts`: Angular selection/list state. Last selection is stored in
  NativeScript application settings; the UI creates a session only when no active
  session can be selected. Engine construction never creates a default.

## Persistence

Migration v5 evolves `conversations` in place. Its `id` is the session ID; existing
message/generation `conversationId` and telemetry `session_id` refer to that same
identity. No history is copied into a second session/conversation system.

Sessions have `id`, nullable title, extensible string kind, `active`/`archived`
state, optional opaque owner agent ID, optional parent session ID, timestamps,
and nullable archive timestamp. Owner IDs do not require an agent definition.
Parents have a normalized self-reference with `ON DELETE RESTRICT`. There is no
delete operation or persisted runtime state.

## Ownership And Cancellation

`parentSessionId` means lifetime ownership, not consultation or collaboration.
Archive atomically marks the entire owned subtree archived before cancelling its
scopes and work. It never deletes messages, generations, telemetry, or children.
Unrelated sessions and ancestors survive a child archive.

Restore changes only the requested session and requires active ancestors. It
allocates a fresh scope; children remain archived until explicitly restored.
Cancelled/interrupted generations are never resumed automatically.

Register each live operation with `engine.registerWork(sessionId, { id, kind,
cancel })`. Pass the returned session `signal` into future tool/subagent adapters,
and always call the idempotent `finish()` when the operation settles. A generation
keeps its own AbortController, so cancelling it does not abort its session or
siblings. Session cancellation aborts every registered generation controller.
Registrations remain counted while cancellation drains, even after restoration;
finishing an old registration cannot remove work in a fresh scope.

Events use `created`, `updated`, `archived`, `restored`, `work_started`,
`work_finished`, and `runtime_cancelled`, each with `sessionId`. Subscriptions
return an unsubscribe function. Selection events/state belong to the UI, not the
engine. Observer and work-cancellation callback exceptions cannot stop cleanup.

## Foreground And Recovery

There is one foreground service for all active generations. It starts/updates
from the global generation count, never from selection. With multiple tasks the
notification is a summary without Cancel; a sole task has an ID-scoped Cancel.
Other future work types must integrate with a foreground adapter if they need
Android background execution; merely registering generic work does not start it.

Warm UI recreation reuses the same controller/engine and rehydrates persisted
messages plus live snapshots without resending. A new process interrupts orphaned
generations but leaves session lifecycle unchanged. The global telemetry sweep
for unattached turns/runs is cold-runtime-only, before new requests are admitted;
recovery with live generations only interrupts identifiable orphan generations.

## Adapter Assumptions

The current repository contract is synchronous, matching the existing SQLite
layer. A future async remote adapter must explicitly evolve that contract while
preserving atomic subtree archival and serializing admission against archival.
Use one engine/runtime authority per repository/process, not one per UI or session.
Do not mutate lifecycle through repository methods behind a live engine.

## Verification

Run all core tests (SQLite tests use ephemeral in-memory databases):

```sh
node --experimental-test-module-mocks --import ./src/test-loader.mjs --test src/core/*.test.ts src/core/**/*.test.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/ngc --noEmit
ns build android --no-hmr
```

`../generation/sessions.test.ts` covers concurrent generation attribution,
archive/restore, late completion, and process recovery. `session-ui.test.ts`
exercises A/B/C through the actual chat/session facades and controller, including
UI teardown and reattachment. Android adapter tests mock native calls; physical
device task removal, notification delivery, and OS process killing still require
device verification. A foreground service does not guarantee survival of OS
process termination or override Android background-execution limits.
