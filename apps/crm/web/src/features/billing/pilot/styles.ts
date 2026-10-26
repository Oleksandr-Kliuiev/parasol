import { makeStyles, tokens } from '@fluentui/react-components';
import { h } from '../../../app/hearth';
import { formatMoney } from '../../../shared/utils/format';

/** The pilot page in the visual system: quiet framed tables inside the cards, wells for evidence and caveats. */
export const usePilotStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: '16px' },
  // A table inside a card: a hairline frame without a second shadow, scrolling sideways on its own.
  scroll: {
    overflowX: 'auto',
    backgroundColor: h.surface,
    borderRadius: '14px',
    border: `1px solid ${h.line}`,
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px' },
    '& th': { boxSizing: 'border-box' },
  },
  table: { minWidth: '720px' },
  number: { textAlign: 'end', fontVariantNumeric: 'tabular-nums', '& .fui-TableHeaderCell__button': { justifyContent: 'flex-end' } },
  muted: { color: h.muted, fontSize: '12.5px', lineHeight: '18px' },
  // The one explanation line of a card: muted, and never wider than a comfortable line.
  lead: { marginTop: 0, marginBottom: '14px', maxWidth: '75ch', color: h.muted, fontSize: '13px', lineHeight: '20px' },
  // What a form asks of the reader, above its quieter lead line.
  intro: { marginTop: 0, marginBottom: '4px', maxWidth: '75ch', fontSize: '14px', lineHeight: '20px' },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: '12px', overflowWrap: 'anywhere' },
  key: { fontFamily: tokens.fontFamilyMonospace, fontSize: '12px', color: h.muted, overflowWrap: 'anywhere' },
  // A comparison key breaks only after its separators (see KeyText).
  keyText: { fontFamily: tokens.fontFamilyMonospace, fontSize: '12px', overflowWrap: 'normal', wordBreak: 'normal' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', justifyContent: 'flex-end' },
  // Ids and hashes a sign-off names: kept whole, set small in a well.
  evidence: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))',
    gap: '10px 16px',
    margin: 0,
    marginBottom: '16px',
    paddingTop: '12px',
    paddingBottom: '12px',
    paddingLeft: '14px',
    paddingRight: '14px',
    borderRadius: '12px',
    backgroundColor: h.well,
  },
  fact: { display: 'grid', gap: '2px', minWidth: 0, '& dd': { margin: 0 } },
  term: { color: h.muted, fontSize: '12px', fontWeight: 600, lineHeight: '16px' },
  // A plain list of reasons or caveats, set quietly in a well.
  well: { display: 'grid', gap: '8px', marginTop: '16px', paddingTop: '12px', paddingBottom: '12px', paddingLeft: '14px', paddingRight: '14px', borderRadius: '12px', backgroundColor: h.well },
  list: { margin: 0, paddingLeft: '18px', display: 'grid', rowGap: '6px', color: h.muted, fontSize: '13px', lineHeight: '20px' },
  plainList: { listStyleType: 'none', margin: 0, padding: 0, display: 'grid', gap: '10px' },
  heading: { margin: 0, marginTop: '20px', marginBottom: '10px', fontFamily: h.display, fontSize: '14px', lineHeight: '20px', fontWeight: 600, letterSpacing: '-0.01em' },
  wellHeading: { margin: 0, fontSize: '12.5px', lineHeight: '18px', fontWeight: 700, color: h.text },
  good: { color: h.spruceT, fontWeight: 600 },
  warn: { color: h.saffronT, fontWeight: 600 },
  bad: { color: h.emberT, fontWeight: 600 },
  neutral: { color: h.text, fontWeight: 600 },
  // The verdict of a probe: a tinted box with its icon, the sentence in the tone of the answer.
  verdict: { display: 'flex', alignItems: 'flex-start', gap: '10px', margin: 0, marginBottom: '10px', paddingTop: '10px', paddingBottom: '10px', paddingLeft: '12px', paddingRight: '14px', borderRadius: '12px', fontWeight: 600, '& svg': { flexShrink: 0, marginTop: '1px' } },
  verdictGood: { backgroundColor: h.spruceSoft, color: h.spruceT },
  verdictBad: { backgroundColor: h.emberSoft, color: h.emberT },
  group: { border: `1px solid ${h.line}`, borderRadius: '14px', paddingTop: '12px', paddingBottom: '14px', paddingLeft: '14px', paddingRight: '14px', margin: 0, minWidth: 0 },
  legend: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', paddingLeft: '4px', paddingRight: '4px', maxWidth: '100%' },
  footer: { display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center', justifyContent: 'center', paddingTop: '12px', paddingBottom: '4px' },
});

/** Money that the API removed (no finance.read) shows as a dash, never as zero. */
export const money = (value: number | null | undefined, currency = 'NOK') => (value === null || value === undefined ? '—' : formatMoney(value, currency));
