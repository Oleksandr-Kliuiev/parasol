import { makeStyles, tokens } from '@fluentui/react-components';
import { h } from '../../app/hearth';

/*
 * Table containers of the settings pages, next to ScrollTable: the same card for the few tables that must stay a
 * focusable, labelled region at every width (their tests and the e2e specs find them by that name), and the inset
 * frame for a table that sits inside a Panel, where a second card shadow would look like a card on a card.
 */
export const useTableCardStyles = makeStyles({
  // The look of ScrollTable for a hand-made scroll region.
  region: {
    overflowX: 'auto',
    scrollPaddingInline: '16px',
    minWidth: 0,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow4,
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px' },
  },
  // A table inside a card: a hairline frame, no second shadow.
  inset: {
    overflowX: 'auto',
    scrollPaddingInline: '16px',
    minWidth: 0,
    backgroundColor: 'transparent',
    borderRadius: '14px',
    border: `1px solid ${h.line}`,
    boxShadow: 'none',
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px' },
  },
  // Minimum widths: below them the table scrolls inside its card instead of squeezing its columns.
  min560: { minWidth: '560px' },
  min720: { minWidth: '720px' },
  min800: { minWidth: '800px' },
  min880: { minWidth: '880px' },
  // Rows of small tables whose cells hold two lines (a pill over a note, a name over an id): 8 px above and below.
  roomy: { '& .fui-TableCell': { paddingTop: '8px', paddingBottom: '8px' } },
  // Fixed columns of fixed-layout tables, so the text columns get the room: a checkbox, a row button.
  checkCol: { width: '48px' },
  lineCol: { width: '72px' },
  actionCol: { width: '168px', whiteSpace: 'nowrap' },
  // A date and time ("21.10.2026, 01:30") on one line: a fixed-layout table would otherwise give it an equal share it overruns.
  dateTimeCol: { width: '156px' },
  number: { textAlign: 'end', fontVariantNumeric: 'tabular-nums' },
  // A header over a right-aligned number column: the header text sits over the digits.
  numberHead: { textAlign: 'end', '& .fui-TableHeaderCell__button': { justifyContent: 'flex-end' } },
  nowrap: { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
  name: { fontWeight: tokens.fontWeightSemibold, overflowWrap: 'anywhere' },
  // A code or key under a name: monospace, quiet.
  code: { display: 'block', fontFamily: tokens.fontFamilyMonospace, fontSize: '12px', lineHeight: '18px', color: h.muted, overflowWrap: 'anywhere' },
  // A quiet cell (reasons, field lists, counts).
  muted: { color: h.muted, fontSize: '13px', lineHeight: '18px', overflowWrap: 'anywhere' },
  // A second, quiet line in a cell.
  sub: { display: 'block', color: h.muted, fontSize: '13px', lineHeight: '18px', overflowWrap: 'anywhere' },
  // Buttons of a row: side by side, never wrapped under each other one by one.
  rowActions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' },
});
