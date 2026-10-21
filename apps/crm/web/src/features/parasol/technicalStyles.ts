import { makeStyles, tokens, type BadgeProps } from '@fluentui/react-components';
import { h } from '../../app/hearth';

export const useTechnicalStyles = makeStyles({
  // The lists of the workspace in one segmented row; on a narrow card the row scrolls sideways (never a 2 × 2 block).
  tabs: { flexWrap: 'nowrap', maxWidth: '100%', overflowX: 'auto', scrollbarWidth: 'none', marginTop: '18px',
    '::-webkit-scrollbar': { display: 'none' }, '& > .fui-Tab': { flexShrink: 0, paddingLeft: '11px', paddingRight: '11px' },
    '& .fui-Tab__content': { whiteSpace: 'nowrap' } },
  queueSection: { marginTop: tokens.spacingVerticalM },
  section: { marginTop: '20px', minWidth: 0, overflowWrap: 'anywhere' },
  identifier: { fontFamily: 'inherit', fontSize: 'inherit' },
  queueFacts: { display: 'grid', gap: tokens.spacingVerticalXS, marginBlock: tokens.spacingVerticalS },
  queueTools: { gap: tokens.spacingHorizontalS, marginBlock: tokens.spacingVerticalS },
  queueFooter: { gap: tokens.spacingHorizontalS, marginBlock: tokens.spacingVerticalS },
  // The disclosure around a detailsSummary: turns the chevron when open (Griffel keeps '&' first in a selector).
  details: { '&[open] > summary::before': { transform: 'rotate(45deg)' } },
  // Disclosures read as a quiet row with a chevron that turns when open (no browser triangle).
  detailsSummary: { cursor: 'pointer', minHeight: '32px', paddingBlock: tokens.spacingVerticalXS, listStyle: 'none',
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 8px', color: h.muted, fontSize: '13px', fontWeight: 700,
    '::-webkit-details-marker': { display: 'none' },
    '::before': { content: '""', width: '6px', height: '6px', flexShrink: 0, marginLeft: '2px', marginRight: '2px',
      borderRight: '1.5px solid currentColor', borderBottom: '1.5px solid currentColor', transform: 'rotate(-45deg)',
      transitionProperty: 'transform', transitionDuration: '0.2s' },
    ':hover': { color: h.text },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '4px' } },
  heading: { fontSize: tokens.fontSizeBase400, fontWeight: 600, marginBlock: tokens.spacingVerticalS,
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '4px' } },
  tools: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: tokens.spacingHorizontalM,
    marginBlock: tokens.spacingVerticalM, minWidth: 0 },
  list: { listStyle: 'none', padding: 0, marginBlock: tokens.spacingVerticalM, display: 'grid', gap: tokens.spacingVerticalS },
  scrollList: { maxHeight: 'min(60vh, 480px)', overflowY: 'auto', scrollPaddingBlock: '16px',
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '-2px' } },
  // A record inside a card: a quiet well, no second border, so lists read as rows and not as cards in cards. A row that
  // holds one attention item (flag, text, state and action) moves the state under the text when the row itself is narrow,
  // as the customer card's column is on a desktop: the item's own media query only knows the viewport.
  row: { backgroundColor: tokens.colorNeutralBackground3, borderRadius: '14px', paddingBlock: '12px', paddingInline: '14px',
    display: 'grid', gap: tokens.spacingVerticalS, minWidth: 0, overflowWrap: 'anywhere', containerType: 'inline-size',
    '@container (max-width: 600px)': {
      '& > div:only-child:not([data-technical-item])': { gridTemplateColumns: '32px minmax(0, 1fr)' },
      '& > div:only-child:not([data-technical-item]) > div:nth-child(3)': { gridColumn: '2', alignItems: 'flex-start' },
      '& > div:only-child:not([data-technical-item]) > div:nth-child(3) > div:first-child': { justifyContent: 'flex-start' },
    } },
  raisedRow: { backgroundColor: h.surface, border: `1px solid ${h.line}` },
  // Headings of the technical lists in display type.
  display: { fontFamily: h.display, fontSize: '16px', lineHeight: '22px', letterSpacing: '-0.01em', marginBottom: '4px' },
  // Muted 13 px explanations under a heading; the records themselves keep the body size.
  note: { color: h.muted, fontSize: '13px', lineHeight: '20px', margin: 0 },
  status: { color: h.muted, fontSize: '13px', lineHeight: '20px' },
  // Filters of a list in one toolbar: controls of one height on one line (labels are read, not shown).
  toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '10px', rowGap: '10px', marginTop: '14px', marginBottom: '10px', minWidth: 0,
    '& > .fui-Field': { flex: '1 1 150px', minWidth: 0 }, '& > .fui-Field:first-child': { flex: '2 1 200px' },
    '& .fui-Input, & .fui-Select': { width: '100%', minWidth: 0 } },
  facts: { marginBlock: tokens.spacingVerticalS },
  // A filter's label in a toolbar: read by screen readers, the control says what it filters.
  hiddenLabel: { position: 'absolute', width: '1px', height: '1px', margin: '-1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0, padding: 0 },
  search: { maxWidth: '360px', marginBottom: tokens.spacingVerticalS },
  deviceAction: { justifySelf: 'start', maxWidth: '100%', whiteSpace: 'normal', textAlign: 'start' },
  badges: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  footer: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalM, marginBlock: tokens.spacingVerticalM, color: h.muted, fontSize: '13px' },
});

/** Only a current snapshot is green; everything else asks to be looked at. */
export const resourceTone: Record<'OK' | 'STALE' | 'ERROR' | 'MISSING' | 'FIXTURE', BadgeProps['color']> = {
  OK: 'success', STALE: 'warning', ERROR: 'danger', MISSING: 'subtle', FIXTURE: 'informative',
};
