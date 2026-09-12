# SAM design language

**Official theme: Interlude.** Adopted 2026-09-11. Dark, Color duet, and smooth
motion are the defaults. This document describes the design intent and is the
living reference for future UI, theme, and animation work.

## Character

Quiet's generous curves meet Ledger's editorial character. Use neutral foundations,
serif display text, clear sans-serif body copy, and monospace labels. Purple and
cyan-blue coexist with distinct roles. Surfaces feel calm; movement feels soft,
short, and deliberate. Keep text, actions, and state understandable at a glance.

Interlude is used on Home/chat, Providers, Agents, Embeddings Lab, the drawer,
Appearance, Retrieval Lab, and the initial UI Kit view. Quiet, Facet, Ledger, and Spectrum remain
isolated design studies in the kit. A future study becomes production only when
explicitly adopted; adding a study never changes the app's saved appearance.

## Source of truth

| Source | Responsibility |
| --- | --- |
| [tokens.ts](src/core/ui/tokens.ts) | Semantic palette, typography, geometry and spacing values |
| [motion-tokens.ts](src/core/ui/motion-tokens.ts) | Motion timings, easing, and distances |
| [Shared kit guide](src/core/ui/README.md) | Component APIs and NativeScript implementation rules |
| [Appearance preferences](src/core/ui/appearance.ts) | Validated, versioned preference contract |
| [AppAppearance](src/core/ui/app-appearance.service.ts) | Persisted production settings |
| [Theme scope](src/core/ui/theme-scope.directive.ts) | CSS bridge for existing screens |
| [Motion primitives](src/core/ui/motion.ts) | Cancellable native movement and reduced-motion behavior |
| Menu → UI Kit | Interactive examples, including Motion |
| Menu → Appearance | Saved app preferences |

Change numeric/color values in the token modules, then update this document and
the live examples in the same change. Screens consume semantic roles, never
invent their own palette or timing constants.

## Palette and appearance

| Role | Dark | Light | Use |
| --- | --- | --- | --- |
| Background | `#0c0c10` | `#f4f4f6` | Screen foundation |
| Surface | `#17171c` | `#ffffff` | Cards and drawer |
| Inset | `#101014` | `#ededf1` | Fields and supporting groups |
| Raised | `#232329` | `#e3e3e9` | Summary and emphasis |
| Text | `#f3f3f5` | `#17171c` | Main content |
| Muted | `#aaaab4` | `#5e5e6a` | Supporting text |
| Primary purple | `#c4a8ff` | `#6840b5` | Main actions and creation |
| Supporting cyan-blue | `#8bd5ff` | `#00659a` | Secondary actions and exploration |
| Purple surface | `#261f35` | `#f0e9fc` | Primary-tinted groups and user messages |
| Cyan-blue surface | `#14232e` | `#e3f1fc` | Supporting groups and secondary buttons |

Use paired foreground/background tokens (`accent` + `onAccent`,
`secondaryAccent` + `secondarySurface`). Cyan leans blue, never teal/green.
Use semantic `danger` with a written explanation for errors and destructive
operations. A color alone must never communicate selection, success, or failure.

**Monochrome** maps the two accent roles and error styling to Quiet's grays;
it keeps the same geometry, typography, contrast, and state cues.

**Do not disturb** is an app appearance override. It temporarily displays
monochrome without changing the saved Color duet / Monochrome preference.
Turning DND off restores that preference, including after restarting SAM.
It does not request Android notification-policy access, silence notifications,
or follow the phone's DND state. Keep this distinction clear in user-facing copy.

**Dark/light**, **palette**, **DND**, and **reduced motion** are independent saved
settings under `sam.appearance.v1`. Invalid fields fall back independently.
Gallery experiments are local, start from saved appearance, and never overwrite
production settings. New installs default to Interlude dark/color with DND off.

## Shape, type, and layout

- Cards: 22 dip corners, 1 dip outline. Controls: 24 dip corners.
- Display: 30 dip system serif. Headings: 20; titles: 16; body: 14; meta: 12;
  code: 13. Body and ordinary headings use system sans-serif; labels and numeric
  metadata use monospace. Existing app navigation titles use serif.
- Minimum control target: 48 × 48 dip. Keep at least 8 dip between related actions.
- Spacing scale: 4, 8, 12, 16, 24, 32. Screen gutters: 16; content cap: 760.
- Related actions share a wrapping row. Preferred width 136, maximum 208 dip in
  the shared primitive. Existing diagnostic layouts can keep their bounded sizes.
- Narrow layouts and larger text may stack controls. Never shrink text to fit.
- Wrap labels, keep visible field labels, and expose selected/disabled state.
- Preserve precise cost readouts such as `$0.00042`.
- NativeScript lineHeight adds leading: use 4, not a browser line height of 20.

## Motion language

Motion confirms touch, explains arrival, and preserves the relationship between
views. Actions start immediately; animation never gates a network request, save,
or cancellation. Only drawer navigation waits for its short exit so the menu has
visibly left before the next page arrives.

| Interaction | Duration | Movement |
| --- | --- | --- |
| Press | 80 ms | Scale to 0.985 |
| Release/cancel | 180 ms | Ease back to 1 |
| Panel arrival / semantic content change | 240 ms | Fade from 0.65 with an 8 dip upward arrival |
| Drawer entrance | 280 ms | Slide from the left; scrim fades in |
| Drawer exit | 200 ms | Slide out; scrim fades away |
| Menu destination | 240 ms | Native page fade |

Use `easeOut` for this first motion family. No bounce, overshoot, perpetual ambient
loops, or stacked animation queues. Animate opacity and transforms; avoid
animating layout width/height. One motion owner per view; a new gesture cancels
its predecessor. Always cancel on unload/destroy and restore scale/opacity.

`samButton` includes press feedback. Existing class-based buttons opt in with
`samPress`. `samReveal` runs on insertion or a meaningful key change (selected
panel, edited item, palette preview). Never key it to streamed tokens, polling,
progress counts, or each keystroke. Keep long lists and chat history steady.
Native switches, loading indicators and OS dialogs keep their platform behavior.

**Reduced motion** removes the custom transforms, fades, and navigation
transitions. Both the saved in-app switch and the device preference can request
it. Android checks animator duration scale; iOS checks Reduce Motion. The system
setting is read at the next interaction, so returning from device settings works.
DND changes the palette; it does not silently change the independent motion choice.

## Extending the language

1. Describe the need and where users encounter it. Extend an existing semantic
   role or component input before creating a parallel implementation.
2. Add the shared token/primitive and an interactive example in the UI Kit.
3. Cover dark/light, color/monochrome, DND overrides, disabled/loading/error states,
   larger text, and reduced motion where relevant.
4. For new animations, specify trigger, duration, easing, distance, interruption,
   cleanup, reduced-motion behavior, and whether business actions run immediately.
5. Update this document and the kit guide, with a dated entry below. Keep earlier
   studies available unless their removal is explicitly requested.
6. Verify TypeScript, Angular templates, relevant behavior tests, and actual
   device rendering. Test rapid taps and leaving during animations. A screenshot
   alone does not verify motion; capture frames or watch a recording as well.

## Change log

- **2026-09-11 — Interlude adopted:** official app and kit default; purple/cyan-blue
  plus saved monochrome, DND appearance override, dark/light, reduced motion.
  Added shared press/release, panel arrivals, drawer entrance/exit, and page fades.

Android is the current visual verification target. iOS behavior uses native APIs
but has not been visually verified. Do not describe gallery experiments or future
motion ideas as shipped production behavior.
