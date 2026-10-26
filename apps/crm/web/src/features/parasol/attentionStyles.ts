import { makeStyles } from '@fluentui/react-components';
import { h } from '../../app/hearth';

/** The look of a personal Atlas read: My day's attention panel and the observation queue share it. */
export const useAttentionStyles = makeStyles({
  stack: { display: 'grid', gap: '14px' },
  note: { color: h.muted, fontSize: '13px', lineHeight: '19px', maxWidth: '75ch' },
  // The result of the read as one line in a well: what was read, and when.
  status: {
    display: 'grid',
    gap: '6px',
    paddingTop: '10px',
    paddingBottom: '10px',
    paddingLeft: '12px',
    paddingRight: '14px',
    borderRadius: '12px',
    backgroundColor: h.spruceSoft,
    color: h.text,
  },
  statusText: { display: 'inline-flex', alignItems: 'center', gap: '8px', fontWeight: 700, '& svg': { flexShrink: 0 } },
  // A read with a gap (partial, unread or unmatched customers) is told in the warning tone, never in the green of a full read.
  statusGap: { backgroundColor: h.saffronSoft },
  completeIcon: { color: h.spruceT },
  gapIcon: { color: h.saffronT },
  statusLine: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 12px' },
  // Why the read is not complete, in the same well as the reading itself (one box, not a stack of banners).
  statusNote: { color: h.text, fontSize: '13px', lineHeight: '19px', paddingLeft: '24px', maxWidth: '80ch' },
  // The reading time ends the line on a wide card; on a phone it wraps under the text and starts where the text starts.
  checked: { color: h.muted, fontSize: '12.5px', marginLeft: 'auto', '@media (max-width: 560px)': { marginLeft: '24px' } },
  totals: { display: 'grid', gap: '4px', marginTop: '4px' },
  totalsLine: { fontSize: '14px', lineHeight: '20px', fontWeight: 700, color: h.text },
  // One customer: a warm well holding its urgent rows on the card colour.
  customer: { display: 'grid', gap: '10px', backgroundColor: h.surface2, border: `1px solid ${h.line}` },
  customerHead: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px' },
  customerName: { margin: 0, flex: '1 1 200px', fontFamily: h.display, fontSize: '16px', lineHeight: '22px', fontWeight: 600, letterSpacing: '-0.01em' },
  counts: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
  meta: { display: 'flex', flexWrap: 'wrap', columnGap: '14px', rowGap: '2px', color: h.muted, fontSize: '12.5px', lineHeight: '18px', '&:empty': { display: 'none' } },
  partial: { color: h.saffronT, fontWeight: 600 },
  caption: { color: h.muted, fontSize: '12.5px', lineHeight: '18px', fontWeight: 600 },
  open: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontWeight: 700, justifySelf: 'start', whiteSpace: 'nowrap' },
  // The compact row of a customer with nothing urgent: lighter, on the card colour, the name in body size.
  quiet: { gap: '6px', backgroundColor: h.surface, paddingTop: '12px', paddingBottom: '10px' },
  quietName: { fontSize: '14.5px', lineHeight: '20px', fontFamily: 'inherit', fontWeight: 700, letterSpacing: 0 },
  sources: { display: 'grid', gap: '8px', paddingTop: '4px' },
  about: { display: 'grid', gap: '10px', paddingTop: '6px' },
  sourceRows: { display: 'grid', gap: '6px' },
  sourceRow: { display: 'grid', gap: '2px', paddingTop: '8px', paddingBottom: '8px', paddingLeft: '12px', paddingRight: '12px', borderRadius: '12px', backgroundColor: h.surface, border: `1px solid ${h.line}` },
  sourceHead: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '4px 10px' },
  // Disclosures read as a quiet row with a turning chevron.
  details: { '&[open] > summary::before': { transform: 'rotate(45deg)' } },
  summary: {
    cursor: 'pointer',
    listStyle: 'none',
    color: h.muted,
    fontSize: '13px',
    fontWeight: 700,
    minHeight: '32px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    borderRadius: '8px',
    '::-webkit-details-marker': { display: 'none' },
    '::before': {
      content: '""',
      width: '6px',
      height: '6px',
      flexShrink: 0,
      marginLeft: '2px',
      marginRight: '2px',
      borderRight: `1.5px solid currentColor`,
      borderBottom: `1.5px solid currentColor`,
      transform: 'rotate(-45deg)',
      transitionProperty: 'transform',
      transitionDuration: '0.2s',
    },
    ':hover': { color: h.text },
    ':focus-visible': { outline: `2px solid ${h.ember}`, outlineOffset: '2px' },
  },
  hidden: { position: 'absolute', width: '1px', height: '1px', margin: '-1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0, padding: 0 },
});
