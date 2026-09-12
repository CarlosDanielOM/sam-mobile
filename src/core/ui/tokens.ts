/** Canonical SAM UI tokens. Keep this module native/Angular-free. */
export type UiDirection = 'quiet' | 'facet' | 'ledger' | 'spectrum' | 'interlude';
export type UiColorMode = 'color' | 'mono';
export const effectiveColorMode = (preference: UiColorMode, doNotDisturb: boolean): UiColorMode => doNotDisturb ? 'mono' : preference;
export type UiMode = 'dark' | 'light';
export type UiAccent = 'purple' | 'red' | 'blue' | 'cyan';
export const UI_DIRECTIONS = [
  { id: 'quiet' as const, number: '01', name: 'Quiet', title: 'Room to think.', description: 'Soft edges. Quiet surfaces. A little more breathing room.', detail: 'Rounded / understated / familiar' },
  { id: 'facet' as const, number: '02', name: 'Facet', title: 'A place for every piece.', description: 'Honeycomb geometry, substantial outlines, and controls with a little weight.', detail: 'Geometric / tactile / modular' },
  { id: 'ledger' as const, number: '03', name: 'Ledger', title: 'Clarity, line by line.', description: 'Crisp corners, fine rules, and typography that does the work.', detail: 'Editorial / precise / compact' },
  { id: 'spectrum' as const, number: '04', name: 'Spectrum', title: 'A brighter kind of focus.', description: 'An ink-dark foundation with four interchangeable accents.', detail: 'Expressive / luminous / adaptable' },
  { id: 'interlude' as const, number: '05', name: 'Interlude', title: 'Space for a quieter mind.', description: 'Soft curves. Editorial rhythm. Purple and cyan-blue, in conversation.', detail: 'Quiet curves / Ledger character' },
];
export const UI_ACCENTS: UiAccent[] = ['purple', 'red', 'blue', 'cyan'];
export const UI_SPACE = { tiny: 4, gap: 8, small: 12, inset: 16, section: 24, large: 32 } as const;
export const UI_TYPE = { display: 30, heading: 20, title: 16, body: 14, meta: 12, code: 13 } as const;
export const UI_LAYOUT = { touch: 48, content: 760, action: 136, actionMax: 208, gutter: 16 } as const;

export function uiTokens(direction: UiDirection, mode: UiMode, accent: UiAccent = 'purple', colorMode: UiColorMode = 'color') {
  const dark = mode === 'dark';
  const colors = dark ? {
    background: '#0c0c10', surface: '#17171c', inset: '#101014', raised: '#232329',
    text: '#f3f3f5', muted: '#aaaab4', line: '#34343e', control: '#777783',
    accent: '#ededf2', onAccent: '#141418', danger: '#ffb4b6',
  } : {
    background: '#f4f4f6', surface: '#ffffff', inset: '#ededf1', raised: '#e3e3e9',
    text: '#17171c', muted: '#5e5e6a', line: '#d0d0d8', control: '#7a7a86',
    accent: '#22222b', onAccent: '#ffffff', danger: '#a52534',
  };
  // Monochrome directions intentionally keep all examples neutral.
  if (direction !== 'spectrum') colors.danger = colors.text;
  if (direction === 'facet') {
    colors.line = dark ? '#54545e' : '#b4b4be';
    colors.raised = dark ? '#2b2b34' : '#e4e4ec';
  }
  if (direction === 'ledger') {
    colors.background = dark ? '#101010' : '#f5f3ef';
    colors.surface = dark ? '#101010' : '#f5f3ef';
    colors.inset = dark ? '#1a1a1a' : '#ebe8e2';
    colors.raised = dark ? '#262626' : '#e2ded6';
  }
  if (direction === 'spectrum') {
    colors.background = dark ? '#0d0c17' : '#f5f3fa';
    colors.surface = dark ? '#191724' : '#ffffff';
    colors.inset = dark ? '#12101c' : '#eeebf5';
    colors.raised = dark ? '#2a253b' : '#e6e0f1';
    const accents = dark
      ? { purple: '#c4a8ff', red: '#ffabb5', blue: '#9ac5ff', cyan: '#8bd5ff' }
      : { purple: '#6840b5', red: '#ac2945', blue: '#235fab', cyan: '#00659a' };
    colors.accent = accents[accent];
    colors.onAccent = dark ? '#13101d' : '#ffffff';
  }
  // Interlude keeps Quiet's neutral foundations; color has two distinct roles.
  const mixed = direction === 'interlude' && colorMode === 'color';
  if (mixed) {
    colors.accent = dark ? '#c4a8ff' : '#6840b5';
    colors.onAccent = dark ? '#13101d' : '#ffffff';
    colors.danger = dark ? '#ffb4b6' : '#a52534';
  }
  return {
    ...colors,
    secondaryAccent: mixed ? (dark ? '#8bd5ff' : '#00659a') : colors.text,
    secondaryBorder: mixed ? (dark ? '#8bd5ff' : '#00659a') : colors.control,
    secondarySurface: mixed ? (dark ? '#14232e' : '#e3f1fc') : colors.surface,
    accentSurface: mixed ? (dark ? '#261f35' : '#f0e9fc') : colors.raised,
    radius: direction === 'ledger' ? 3 : direction === 'facet' ? 12 : 22,
    controlRadius: direction === 'ledger' ? 3 : direction === 'facet' ? 10 : 24,
    border: direction === 'facet' ? 2 : 1,
    insetSize: direction === 'ledger' ? 14 : 18,
    displayFont: ['ledger', 'interlude'].includes(direction) ? 'serif' : 'sans-serif',
    labelFont: ['ledger', 'interlude'].includes(direction) ? 'monospace' : 'sans-serif',
  };
}
export type UiTokens = ReturnType<typeof uiTokens>;
