import { makeStyles } from '@fluentui/react-components';
import { h } from '../../app/hearth';

/**
 * Pieces for panels whose content runs to the card edges (`Panel flush`): padded text, a table whose outer cells line up
 * with the panel title, and a bare list for `RecordRow`s. Shared by the finance, service and licence pages.
 */
export const useFlushStyles = makeStyles({
  // Panel's own phone padding is a media rule; this keeps the content on the card edges there too (longhands, as Panel's).
  panel: { '@media (max-width: 600px)': { paddingLeft: 0, paddingRight: 0, paddingBottom: 0 } },
  body: {
    marginTop: 0,
    marginBottom: '12px',
    paddingLeft: '20px',
    paddingRight: '20px',
    '@media (max-width: 600px)': { paddingLeft: '16px', paddingRight: '16px' },
  },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px' },
  scroll: { overflowX: 'auto', scrollPaddingInline: '16px', borderTop: `1px solid ${h.line}` },
  table: {
    '& td': { paddingTop: '10px', paddingBottom: '10px' },
    '& th:first-child': { paddingLeft: '20px' },
    '& td:first-child': { paddingLeft: '20px' },
    '& th:last-child': { paddingRight: '20px' },
    '& td:last-child': { paddingRight: '20px' },
    '@media (max-width: 600px)': {
      '& th:first-child': { paddingLeft: '16px' },
      '& td:first-child': { paddingLeft: '16px' },
      '& th:last-child': { paddingRight: '16px' },
      '& td:last-child': { paddingRight: '16px' },
    },
  },
  foot: { paddingLeft: '20px', paddingRight: '20px', paddingBottom: '4px', '@media (max-width: 600px)': { paddingLeft: '16px', paddingRight: '16px' } },
  list: { listStyleType: 'none', margin: 0, padding: 0 },
  // Cells of a page table: a cell with a second line (a date under a number, a reason under a line) keeps air above and below.
  cells: { '& td': { paddingTop: '10px', paddingBottom: '10px' } },
});

/** A page's key figures fill the row (three tiles share it, five fit beside each other) instead of leaving empty columns. */
export const useStatFitStyles = makeStyles({
  fit: { gridTemplateColumns: 'repeat(auto-fit, minmax(min(190px, 100%), 1fr))' },
  // An amount needs the whole row on a phone: "NOK 184,250.00" does not fit half of it.
  money: { '@media (max-width: 560px)': { gridColumn: '1 / -1' } },
});
