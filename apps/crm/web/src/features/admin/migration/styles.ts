import { makeStyles, tokens } from '@fluentui/react-components';
import { h } from '../../../app/hearth';

/** Shared look of the migration tabs: a form card in the order of the work, and quiet result sections. */
export const useMigrationStyles = makeStyles({
  // Grid items may shrink below their content (a wide table scrolls inside its region instead of widening the page).
  stack: { display: 'grid', gap: '16px', minWidth: 0, '& > *': { minWidth: 0 } },
  form: { display: 'grid', gap: '16px', minWidth: 0, '& > *': { minWidth: 0 } },
  // The one explaining line under a card title.
  lead: { margin: '-6px 0 0', color: h.muted, fontSize: '13px', lineHeight: '20px', maxWidth: '75ch' },
  // A file picker of the form: the native input, drawn by the global style as a field (the picker's button inside, the
  // chosen name after it), as wide as a file name needs rather than the whole card.
  file: { maxWidth: '400px' },
  // The rows of a CSV read best in a fixed-width font.
  csv: { '& textarea': { fontFamily: tokens.fontFamilyMonospace, fontSize: '12.5px', lineHeight: '20px' } },
  // A hint of a few lines keeps to a readable measure.
  hint: { maxWidth: '75ch' },
  // The foot of a form: why a button cannot be used yet on the left, the buttons in the order of the work on the right.
  footer: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: '16px',
    rowGap: '12px',
    paddingTop: '16px',
    borderTop: `1px solid ${h.line}`,
  },
  reason: { display: 'flex', alignItems: 'flex-start', gap: '8px', flex: '1 1 260px', minWidth: 0, margin: 0, color: h.muted, fontSize: '13px', lineHeight: '20px', maxWidth: '75ch' },
  reasonIcon: { display: 'inline-flex', flexShrink: 0, marginTop: '2px', color: h.faint, '& svg': { width: '16px', height: '16px' } },
  ready: { color: h.spruceT },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '10px',
    marginLeft: 'auto',
    // On a phone the buttons share the row in equal parts, easy to reach with a thumb.
    '@media (max-width: 560px)': { width: '100%', '& > .fui-Button': { flex: '1 1 0' } },
  },
  note: { color: h.muted, fontSize: '13px', lineHeight: '20px', margin: 0, overflowWrap: 'anywhere' },
  // The facts of a result in one quiet line: kind · status · file · mapping.
  meta: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', color: h.muted, fontSize: '13px', lineHeight: '20px', margin: 0 },
  // Breakdowns of a result (reasons, warnings, owners): small wells side by side.
  sections: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))', gap: '12px', alignItems: 'start' },
  well: {
    display: 'grid',
    gap: '8px',
    minWidth: 0,
    paddingTop: '12px',
    paddingBottom: '12px',
    paddingLeft: '14px',
    paddingRight: '14px',
    borderRadius: '14px',
    backgroundColor: h.well,
    fontSize: '13px',
    lineHeight: '19px',
    overflowWrap: 'anywhere',
  },
  wellTitle: { margin: 0, fontSize: '12.5px', lineHeight: '18px', fontWeight: 700, color: h.text },
  wellHint: { margin: 0, color: h.muted, fontSize: '12.5px', lineHeight: '18px' },
  // A breakdown row: the reason on the left, its count on the right in tabular figures.
  counts: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '6px' },
  countRow: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', minWidth: 0 },
  countValue: { flexShrink: 0, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: h.text },
  // The counts per status of a comparison: each status pill with its number.
  statusCounts: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 18px' },
  statusCount: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px' },
});
