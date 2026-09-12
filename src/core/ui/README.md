# SAM UI Kit

Open **Menu → UI Kit** on Android. This is the live component reference, built
from the same exported primitives that new screens should reuse.

The gallery offers three monochrome directions (Quiet, Facet, Ledger) and a fourth
accent study (Spectrum: purple, red, blue, cyan-blue). The fifth, **Interlude**,
combines Quiet's rounded geometry, Ledger's serif headings and monospace labels,
and purple primary actions with cyan-blue secondary actions. Each has dark and
light tokens.

**Interlude is the official production and gallery default.** The living design
specification is [DESIGN_LANGUAGE.md](../../../DESIGN_LANGUAGE.md); update it whenever
you extend themes, component behavior, or motion. Other directions remain studies.

Menu → Appearance persists dark/light, Color duet / Monochrome, DND appearance,
and reduced motion. DND temporarily overrides the palette without changing the
preference or phone notifications. UI Kit provides its own `SamUiTheme` and
`SamMotion`, seeded from saved appearance, and never persists preview changes.

## Source of truth

- `tokens.ts`: all semantic colors, geometry, typography, spacing, layout limits.
- `theme.service.ts`: reactive direction/mode/accent, color preference and DND preview; Interlude is the
  library default. `AppAppearance` supplies the persisted production instance. Provide `SamUiTheme` at a screen boundary for isolated previews.
- `primitives.ts`: native button, surface, text, field, and action-layout directives.
- `choice.component.ts`: controlled checkbox/radio, including accessibility state.
- `index.ts`: public exports. Import from this barrel, not copied gallery styles.
- `../../app/ui-kit/`: compositions and working examples, not production business logic.

## Reuse the primitives

Add the directives/components used by your template to a standalone component's
`imports`, alongside `NativeScriptCommonModule`; retain `NO_ERRORS_SCHEMA` for
native views. Use `ChangeDetectionStrategy.OnPush` and signals.

```ts
import {
  SamButtonDirective, SamSurfaceDirective, SamTextDirective,
  SamFieldDirective, SamActionsDirective, SamActionDirective,
  SamChoiceComponent, SamUiTheme,
} from '../../core/ui';
```

```html
<StackLayout samSurface="card">
  <Label samText="heading" text="Workspace"></Label>
  <Label samText="body" text="Name" margin="16 0 8"></Label>
  <TextField samField accessibilityLabel="Workspace name"
    [text]="name()" (textChange)="onName($event)"></TextField>
  <FlexboxLayout samActions marginTop="16">
    <Button samButton="primary" samAction text="Save"
      [samBusy]="saving()" (tap)="save()"></Button>
    <Button samButton="secondary" samAction text="Cancel"
      (tap)="cancel()"></Button>
  </FlexboxLayout>
</StackLayout>
<sam-choice label="Remember context" [checked]="remember()"
  (checkedChange)="remember.set($event)"></sam-choice>
```

Radio groups are controlled by one parent signal. Set `kind="radio"`, bind
`[checked]="selection() === option"`, then set that signal on `checkedChange`.
A radio tap selects it, never unchecks the current selection. A disabled choice
emits nothing. `sam-choice` belongs in a StackLayout/GridLayout; wrapping action
rows use direct native Buttons.

| Primitive | Inputs / responsibility |
| --- | --- |
| `samButton` | `primary`, `secondary`, `ghost`, `danger`; `samDisabled`, `samBusy`, `samAlign` |
| `samActions` + `samAction` | Wrapping rows, 8 dip gaps, 136 dip preferred / 208 dip maximum button width |
| `samSurface` | `card`, `inset`, `raised`, `accent`, `support`; owns padding, border, fill, corners |
| `samText` | `display`, `heading`, `title`, `body`, `meta`, `code`; optional `samMuted`, `samAccent`, `samSupport` |
| `samField` | Native TextField/TextView; focus outline, `samInvalid`, `samFieldMinHeight` (minimum 48); screen owns values and validation |
| `samThemeScope` | Screen root palette/CSS bridge and native page appearance |
| `samPress` | Press/release movement for existing native actions; included by `samButton` |
| `samReveal` | Optional semantic replay key; cancellable insertion/content arrival |
| `sam-choice` | `label`, `kind`, `checked`, `disabled`, `checkedChange` |

Use `samAccent` / `samSurface="accent"` for the primary purple role and
`samSupport` / `samSurface="support"` for the cyan-blue role. Secondary buttons
use `secondaryAccent`, `secondarySurface`, and `secondaryBorder`; never hardcode
these colors in a screen. Monochrome maps both roles back to Quiet's grays while
preserving typography, layout, and selection cues.

Native Switch, Progress, and ActivityIndicator use the same theme tokens. There
is no new third-party widget dependency. The dialog example intentionally uses
the OS dialog, whose appearance follows the OS rather than the gallery preview.

## Layout and behavior rules

- Minimum 48 dip controls. Never shrink fonts to force controls onto one row.
- Wrap related actions, bound standalone actions, and keep at least 8 dip gaps.
- Set content `width="100%" maxWidth="760" horizontalAlignment="center"` with
  16 dip gutters. Keep the header outside the content ScrollView.
- NativeScript `lineHeight` adds spacing on Android; use 4 dip of extra leading,
  not a browser-style total line height of 20.
- The global Tailwind pipeline strips some native properties, including
  `max-width`. Use native `maxWidth` or the shared directives for width limits.
- Directives own visual properties; local CSS should arrange components rather
  than override their padding, fonts, or colors. Extend a shared input or token
  if a real use case needs another variant.
- `samButton` owns enabled state through `samDisabled`/`samBusy`; do not also
  bind `isEnabled`. Busy labels are supplied by the caller.
- Fields always need visible labels and accessibility labels; errors need text,
  not only a colored border. Radios share one selected value.
- Business actions stay in their screen/service. The UI kit contains no network,
  persistence, billing, or session operations.
- `samButton` includes `SamPressDirective`; do not also add `samPress` to it.
  Existing class-based buttons use `samPress`. Import `SamRevealDirective` and
  use `[samReveal]="semanticKey"` for a short fade/lift on insertion or key change.
  Never bind the key to polling, chat token updates, or field text.
- `SamMotion` uses `UI_MOTION` and checks app/device reduced motion. Animations
  cancel on replacement and unload. See DESIGN_LANGUAGE.md for the full contract.
- Put `samThemeScope` on each screen root. It owns inline CSS variables and Page
  appearance; avoid another inline style binding on that root. Existing `.sam-*`
  classes consume these variables; new UI should use native shared primitives.
- Add semantic colors centrally. Use foreground/background pairs; text contrast
  tests cover every palette/mode/accent. The first three previews are monochrome.

## Verification

```sh
npx tsc --noEmit
node --experimental-strip-types --experimental-test-module-mocks --test src/core/ui/*.test.ts
ns run android --no-hmr
```

The NativeScript webpack build checks Angular templates beyond plain `tsc`.
On-device review must include small widths, larger system text, both preview
modes, input focus/keyboard, disabled/loading actions, selection, and navigation.
The kit is Android-verified; iOS has not been visually verified.
