# Android generation foreground service

SAM keeps the existing pi-ai / OkHttp SSE path in JavaScript. The Android
foreground service does not replace streaming; it keeps the process alive and
shows generation status while the app is backgrounded.

## Permissions

Added in `App_Resources/Android/src/main/AndroidManifest.xml`:

- `FOREGROUND_SERVICE` — required to run a foreground service
- `FOREGROUND_SERVICE_DATA_SYNC` — Android 14+ type permission for `dataSync`
- `POST_NOTIFICATIONS` — Android 13+ notification permission (requested at
  generation start while the activity is visible)

No unrelated permissions are requested.

## Service

- Class: `org.nativescript.nativesam.generation.GenerationForegroundService`
- Type: `android:foregroundServiceType="dataSync"`
- Started from the UI thread when the user presses Send (app is in the
  foreground)
- Stopped when no generation needs background execution
- Shared by every session; session selection and UI destruction never stop it
- Completion/failure notifications are posted for the last finishing generation
  only if the app is not visible

## Channels

- `sam.generation.working` — low-importance ongoing "SAM is thinking…"
- `sam.generation.done` — default-importance "SAM finished responding" /
  "SAM couldn't finish the response"

With one task, tapping a notification opens `com.tns.NativeScriptActivity` with
`sam.conversationId`. The application adapter selects that active session without
resuming work or restoring an archived session. Cancel aborts only that generation
through `AbortController` (wired in the OkHttp fetch adapter). Cancel intents have
generation-specific identities, so a stale action cannot target a newer request.

With multiple tasks, the working notification shows the global task count and
has no Cancel action or arbitrary session target. It opens the app's selected
session. The service remains alive until all active generations settle, including
cancelled generations waiting for bounded final usage. See `../sessions/README.md`
for session ownership, archive/restore, and process-recovery semantics.
