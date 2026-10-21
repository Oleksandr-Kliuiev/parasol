import { makeStyles, tokens } from '@fluentui/react-components';
import { h } from '../../app/hearth';

/*
 * The "person cell" of the record lists (organizations, contracts, deals, quotes, projects, products, contacts): a
 * colourful avatar with the initials, the record's name as a link and one muted line under it. The avatar is
 * decoration: the name next to it already says who it is.
 */
export const useRecordStyles = makeStyles({
  cell: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, paddingTop: '6px', paddingBottom: '6px' },
  text: { display: 'grid', minWidth: 0 },
  chip: { display: 'grid', placeItems: 'center', flexShrink: 0, borderRadius: '10px', '& svg': { width: '16px', height: '16px' } },
  // The name reads as the row's title (dark, bold) like the reference; the link shows itself on hover and focus. It is
  // the record's target, at least 24 px tall, also in phone cards that pass under the tab bar (WCAG 2.5.8).
  name: {
    fontWeight: 700,
    fontSize: '14px',
    lineHeight: '20px',
    overflowWrap: 'break-word',
    '& a': { color: 'inherit', textDecorationLine: 'none', display: 'inline-flex', alignItems: 'center', minHeight: '24px' },
    '& a:hover': { color: h.emberT, textDecorationLine: 'underline' },
  },
  sub: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: '6px',
    color: h.muted,
    fontSize: '12px',
    lineHeight: '16px',
    overflowWrap: 'break-word',
    fontVariantNumeric: 'tabular-nums',
  },
  // Phone card lists: the same cell, the status pill on the right.
  cards: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '10px' },
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    minWidth: 0,
    paddingTop: '12px',
    paddingBottom: '12px',
    paddingLeft: '14px',
    paddingRight: '14px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${h.line}`,
    borderRadius: '16px',
    boxShadow: tokens.shadow4,
  },
  cardMain: { flex: '1 1 auto', minWidth: 0 },
  cardEnd: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: '6px', flexShrink: 0, maxWidth: '50%' },
  // Secondary cells: a company link that does not shout, a person named in plain weight.
  quietLink: { color: 'inherit', fontWeight: 600 },
  person: { fontWeight: 500, fontSize: '13px' },
  // A list table inside a Panel: the panel is the card, so the table's own card goes away.
  flatTable: { border: 'none', borderRadius: 0, boxShadow: 'none', backgroundColor: 'transparent', paddingLeft: 0, paddingRight: 0 },
});
