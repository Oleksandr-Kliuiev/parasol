/**
 * Tones of the visual system as CSS variables (defined for light and dark in styles.css). Neutrals come from the Fluent
 * theme tokens; these add the four accents, the wells and the rail. Text on a soft tone uses its `…T` step (≥ 4.5:1).
 */
export const h = {
  display: 'var(--h-display)',
  bg: 'var(--h-bg)',
  surface: 'var(--h-surface)',
  surface2: 'var(--h-surface-2)',
  /** Menus, popovers, dialogs and tooltips: the card colour in light, one step lighter than the cards in dark. */
  float: 'var(--h-float)',
  backdrop: 'var(--h-backdrop)',
  well: 'var(--h-well)',
  line: 'var(--h-line)',
  line2: 'var(--h-line-2)',
  /** The edge of a text field, select or picker at rest and under the pointer: 3:1 or more (WCAG 1.4.11). */
  fieldEdge: 'var(--h-field-edge)',
  fieldEdgeHover: 'var(--h-field-edge-hover)',
  text: 'var(--h-text)',
  muted: 'var(--h-muted)',
  faint: 'var(--h-faint)',
  ink: 'var(--h-ink)',
  onInk: 'var(--h-on-ink)',
  ember: 'var(--h-ember)',
  emberT: 'var(--h-ember-t)',
  emberSoft: 'var(--h-ember-soft)',
  iris: 'var(--h-iris)',
  irisT: 'var(--h-iris-t)',
  irisSoft: 'var(--h-iris-soft)',
  spruce: 'var(--h-spruce)',
  spruceT: 'var(--h-spruce-t)',
  spruceSoft: 'var(--h-spruce-soft)',
  saffron: 'var(--h-saffron)',
  saffronT: 'var(--h-saffron-t)',
  saffronSoft: 'var(--h-saffron-soft)',
  bad: 'var(--h-bad)',
  sideBg: 'var(--h-side-bg)',
  sideText: 'var(--h-side-text)',
  sideMuted: 'var(--h-side-muted)',
  sidePill: 'var(--h-side-pill)',
  sideLine: 'var(--h-side-line)',
} as const;

export type Tone = 'ember' | 'iris' | 'spruce' | 'saffron' | 'neutral';

/** Strong, text and soft step of a tone. */
export const tone: Record<Tone, { strong: string; text: string; soft: string }> = {
  ember: { strong: h.ember, text: h.emberT, soft: h.emberSoft },
  iris: { strong: h.iris, text: h.irisT, soft: h.irisSoft },
  spruce: { strong: h.spruce, text: h.spruceT, soft: h.spruceSoft },
  saffron: { strong: h.saffron, text: h.saffronT, soft: h.saffronSoft },
  neutral: { strong: h.faint, text: h.muted, soft: h.well },
};

/** The filled ember button: a light-to-deep gradient over #C8441D, so white text keeps 4.5:1 everywhere on it. */
export const emberFill = {
  backgroundColor: '#C8441D',
  backgroundImage: 'linear-gradient(180deg, #D4532C, #B8411B)',
  boxShadow: '0 8px 18px -10px rgba(201, 72, 32, 0.9), inset 0 1px rgba(255, 255, 255, 0.22)',
  color: '#FFFAF5',
} as const;

/** Card surface shared by Panel, tiles and the rows that look like cards. */
export const cardSurface = {
  backgroundColor: h.surface,
  border: `1px solid ${h.line}`,
  borderRadius: '20px',
  boxShadow: 'var(--shadow4)',
} as const;
