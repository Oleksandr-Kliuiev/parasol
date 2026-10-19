import { makeStyles, tokens } from '@fluentui/react-components';

export const useCustomerFinanceStyles = makeStyles({
  stack: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '24px', minWidth: 0 },
  cards: { listStyleType: 'none', padding: 0, margin: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '16px' },
  card: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1, padding: '16px', minWidth: 0, overflowWrap: 'anywhere', '& > dl': { marginBlock: '16px' } },
  row: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', justifyContent: 'space-between', minWidth: 0 },
  actions: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', minWidth: 0, '& button': { whiteSpace: 'normal', maxWidth: '100%', minHeight: '32px' }, '& a': { display: 'inline-flex', alignItems: 'center', minHeight: '32px', maxWidth: '100%' } },
  muted: { color: tokens.colorNeutralForeground2, margin: 0, overflowWrap: 'anywhere' },
  heading: { margin: 0, fontSize: '16px', lineHeight: '24px', overflowWrap: 'anywhere' },
  text: { margin: 0, overflowWrap: 'anywhere' },
  facts: { margin: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: '16px',
    '& dt': { color: tokens.colorNeutralForeground2 }, '& dd': { margin: '4px 0 0', fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' } },
  tabs: { marginBottom: '16px', flexWrap: 'wrap', maxWidth: '100%', '& button': { whiteSpace: 'normal', minHeight: '40px', minWidth: 0, maxWidth: '100%' }, '& .fui-Tab__content': { whiteSpace: 'normal', overflowWrap: 'anywhere' } },
  scroll: { maxHeight: '440px', overflowY: 'auto', padding: '4px', minWidth: 0 },
  detail: { paddingBlock: '16px', borderTop: `1px solid ${tokens.colorNeutralStroke2}`, marginTop: '16px' },
  error: { color: tokens.colorPaletteRedForeground1, margin: '8px 0 0' },
});
