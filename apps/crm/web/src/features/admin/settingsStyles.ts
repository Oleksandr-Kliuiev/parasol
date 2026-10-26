import { makeStyles, tokens } from '@fluentui/react-components';
import { h } from '../../app/hearth';

/*
 * Small building blocks of the settings and integrations look, shared by the admin, audit, privacy, operations and
 * technical pages: a tinted icon chip for cards, the person cell of tables and quiet notes (filter rows use the shared
 * Toolbar).
 */
export const useSettingsStyles = makeStyles({
  // Cards of the integrations reference: two or three per row, each a Panel.
  cards: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(min(340px, 100%), 1fr))',
    gap: '16px',
    alignItems: 'start',
    minWidth: 0,
  },
  stack: { display: 'grid', gap: '16px', minWidth: 0 },
  body: { display: 'grid', gap: '12px', minWidth: 0, overflowWrap: 'anywhere' },
  note: { color: h.muted, fontSize: '13px', lineHeight: '20px', margin: 0 },
  pills: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 8px' },
  person: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 },
  personText: { display: 'grid', minWidth: 0 },
  personName: { fontWeight: tokens.fontWeightSemibold, fontSize: '14px', lineHeight: '20px', overflowWrap: 'anywhere' },
  personMail: { color: h.muted, fontSize: '12.5px', lineHeight: '18px', overflowWrap: 'anywhere' },
});
