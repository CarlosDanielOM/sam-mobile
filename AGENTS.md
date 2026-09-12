# NativeSam contributor notes

NativeScript 9 + Angular 22; Android is the current device target. Use standalone
components, OnPush, signals, and native layouts.

## Shared UI

Before UI work, read [the UI Kit guide](src/core/ui/README.md). The live reference
is **Menu → UI Kit**. Reuse primitives exported by `src/core/ui/index.ts` instead
of recreating buttons, inputs, selections, surfaces, typography, or spacing.
Keep semantic theme values in `src/core/ui/tokens.ts`.

**Interlude is the official app and UI Kit default.** Read and maintain
[DESIGN_LANGUAGE.md](DESIGN_LANGUAGE.md) for palette, geometry, typography,
animations, reduced motion, and future theme changes. Use the shared tokens;
never invent screen-specific colors or animation durations. Quiet, Facet, Ledger,
and Spectrum remain isolated gallery studies. Menu → Appearance saves production
preferences; gallery previews must never overwrite them. DND is an appearance
override, not phone notification control.

Use direct native Buttons in wrapping action layouts. Keep 48 dip touch targets,
8 dip action gaps, native width caps, wrapping labels, and system text scaling.
See the guide for NativeScript line-height and Tailwind property caveats.

Do not discard unrelated work already present in the tree. Use the existing
Android live runner if one is running; avoid concurrent runners for the same app.
Verify TypeScript, Angular template compilation, relevant tests, and on-device
rendering for layout changes. Never uninstall/clear app data without explicit
user authorization for that action.
