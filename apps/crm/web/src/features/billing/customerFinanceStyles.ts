import { makeStyles, tokens } from '@fluentui/react-components';
import { h } from '../../app/hearth';

/** Customer finance in the visual system: sections with a title row, framed tables that scroll inside the card. */
export const useCustomerFinanceStyles = makeStyles({
  stack: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '14px', minWidth: 0 },
  // A section starts with its title and, on the right, the action that belongs to it.
  sectionHead: { display: 'flex', flexWrap: 'wrap', gap: '8px 12px', alignItems: 'center', justifyContent: 'space-between', minWidth: 0, minHeight: '36px' },
  // Under its own tab a section's title would repeat the tab: it stays for screen readers only.
  srOnly: { position: 'absolute', width: '1px', height: '1px', margin: '-1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0, padding: 0 },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px 16px',
    alignItems: 'center',
    minWidth: 0,
    '& button': { maxWidth: '100%' },
    '& a': { display: 'inline-flex', alignItems: 'center', minHeight: '32px', maxWidth: '100%', fontWeight: 600 },
  },
  // One quiet line of meaning under a title or a figure row.
  note: { margin: 0, maxWidth: '75ch', color: h.muted, fontSize: '13px', lineHeight: '20px', overflowWrap: 'anywhere' },
  muted: { color: h.muted, margin: 0, fontSize: '12.5px', lineHeight: '18px', overflowWrap: 'anywhere' },
  heading: { margin: 0, fontFamily: h.display, fontSize: '15px', lineHeight: '22px', fontWeight: 600, letterSpacing: '-0.01em', overflowWrap: 'anywhere' },
  // "Document details" is the place focus lands; the document's own name is the title under it.
  eyebrow: {
    margin: 0,
    color: h.muted,
    fontSize: '12px',
    lineHeight: '16px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px', borderRadius: '4px' },
  },
  docTitle: { margin: 0, fontFamily: h.display, fontSize: '19px', lineHeight: '26px', fontWeight: 600, letterSpacing: '-0.015em', overflowWrap: 'anywhere' },
  text: { margin: 0, overflowWrap: 'anywhere' },
  // The section tabs stay one row; on a phone the row scrolls sideways with a fading edge.
  tabs: { marginTop: '12px', marginBottom: '16px', maxWidth: '100%', overflowX: 'auto', overflowY: 'hidden', scrollPaddingInline: '16px' },
  // A table framed inside the card; long lists scroll inside the frame, the header stays in view.
  scroll: {
    maxHeight: '440px',
    overflow: 'auto',
    minWidth: 0,
    border: `1px solid ${h.line}`,
    borderRadius: '14px',
    backgroundColor: h.surface,
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px' },
    '& thead th': { position: 'sticky', top: 0, zIndex: 1, backgroundColor: h.surface },
    '& th': { boxSizing: 'border-box' },
    '& td': { paddingTop: '10px', paddingBottom: '10px' },
  },
  // Columns take the room their content needs (auto layout), so a tablet-wide card still shows the whole table.
  table: { minWidth: '600px', tableLayout: 'auto' },
  wideTable: { minWidth: '640px', tableLayout: 'auto' },
  // Phones: one row per document, the figures under the name, the action at the end.
  rows: { listStyleType: 'none', margin: 0, padding: 0, border: `1px solid ${h.line}`, borderRadius: '14px', overflow: 'hidden' },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: '6px 12px',
    paddingTop: '12px',
    paddingBottom: '12px',
    paddingLeft: '14px',
    paddingRight: '14px',
    borderTop: `1px solid ${h.line}`,
    ':first-child': { borderTop: 'none' },
  },
  rowMain: { display: 'grid', gap: '2px', minWidth: 0 },
  number: { textAlign: 'end', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', '& .fui-TableHeaderCell__button': { justifyContent: 'flex-end' } },
  strong: { fontWeight: 600 },
  actionColumn: { width: '132px' },
  // Saved files as rows in a frame: the file, when it was saved, and its download.
  frame: { listStyleType: 'none', margin: 0, padding: 0, border: `1px solid ${h.line}`, borderRadius: '14px', overflow: 'hidden' },
  fileRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '8px 12px',
    paddingTop: '12px',
    paddingBottom: '12px',
    paddingLeft: '14px',
    paddingRight: '14px',
    borderTop: `1px solid ${h.line}`,
    ':first-child': { borderTop: 'none' },
  },
  fileIcon: { display: 'grid', placeItems: 'center', flexShrink: 0, width: '32px', height: '32px', borderRadius: '10px', backgroundColor: h.emberSoft, color: h.emberT },
  fileMain: { display: 'grid', gap: '2px', flexGrow: 1, flexShrink: 1, flexBasis: '200px', minWidth: 0 },
  toggleRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '8px 16px' },
  error: { color: h.emberT, margin: 0, fontSize: '12.5px', lineHeight: '18px' },
});
