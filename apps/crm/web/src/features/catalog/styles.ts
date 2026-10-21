import { makeStyles, tokens } from '@fluentui/react-components';
import { h } from '../../app/hearth';
import { controlRow } from '../contracts/dialogStyles';

/** Shared by catalog and contract list pages, so both look the same. */
export const useCatalogStyles = makeStyles({
  // The tab row is a segmented control (global TabList style): no rule under it.
  tabs: { marginBottom: '20px', overflowX: 'auto', overflowY: 'hidden', scrollPaddingInline: '16px' },
  // On a phone the search and the filter fields take the full width, one per row.
  filters: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '12px', marginBottom: '16px', '@media (max-width: 560px)': { '& > .fui-SearchBox, & > .fui-Field, & > .fui-Input': { flex: '1 1 100%', maxWidth: '100%' }, '& .fui-Dropdown, & .fui-Field .fui-Input': { width: '100%', minWidth: 0, maxWidth: '100%' } } },
  search: { width: '100%', maxWidth: '320px' },
  // The card around a list table: the 20 px corners, hairline and soft shadow of every card; rows sit 8 px inside it.
  tableWrap: {
    overflowX: 'auto',
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: '20px',
    border: `1px solid ${h.line}`,
    boxShadow: tokens.shadow4,
    paddingLeft: '8px',
    paddingRight: '8px',
  },
  table: { minWidth: '720px' },
  // Figures align right, and so does their column header (Fluent puts the header text in a button).
  number: { textAlign: 'end', fontVariantNumeric: 'tabular-nums', '& .fui-TableHeaderCell__button': { justifyContent: 'flex-end' } },
  sku: { fontFamily: tokens.fontFamilyMonospace, fontSize: '12px', color: h.muted },
  name: { fontWeight: 700 },
  muted: { color: h.muted, fontSize: '12px' },
  more: { display: 'flex', justifyContent: 'center', paddingTop: '12px', paddingBottom: '12px' },
  // Phone card lists: one small card per record.
  cards: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '10px' },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    paddingTop: '12px',
    paddingBottom: '12px',
    paddingLeft: '14px',
    paddingRight: '14px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${h.line}`,
    borderRadius: '16px',
    boxShadow: tokens.shadow4,
  },
  cardMeta: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 8px', color: h.muted, fontSize: '12px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))', gap: '14px 16px', alignItems: 'start', '& .fui-Dropdown, & .fui-Combobox': { minWidth: 0 } },
  wide: { gridColumn: '1 / -1' },
  controlRow,
  // A switch in a filter row: the height of the 42 px controls next to it, so every control of the row shares one line.
  toggle: { display: 'inline-flex', alignItems: 'center', minHeight: '42px' },
  // An empty list on a phone, where the rows are cards: the empty state gets the card the table would have had.
  emptyCard: {
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: '20px',
    border: `1px solid ${h.line}`,
    boxShadow: tokens.shadow4,
  },
  // The buttons of a row keep to its right edge and never shrink below their label (a Fluent button clips its overflow,
  // so a squeezed one would cut its text).
  rowActions: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px', whiteSpace: 'nowrap', '& > *': { flexShrink: 0 } },
  // At most one quiet sentence about a list, under its filters.
  explainer: { display: 'block', maxWidth: '75ch', marginTop: 0, marginBottom: '12px', color: h.muted, fontSize: '13px', lineHeight: '19px' },
});

/** The dot of a status chip in the tone of the status's tint badge (the mapping of hearthSurfaces' badges). */
export const badgeDot: Record<'brand' | 'danger' | 'severe' | 'important' | 'informative' | 'subtle' | 'success' | 'warning', string> = {
  brand: h.ember,
  danger: h.ember,
  severe: h.ember,
  important: h.ink,
  informative: h.iris,
  subtle: h.faint,
  success: h.spruce,
  warning: h.saffron,
};
