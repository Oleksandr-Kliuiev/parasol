import { makeStyles, tokens } from '@fluentui/react-components';

export const useTechnicalStyles = makeStyles({
  tabs: { flexWrap: 'wrap', marginTop: tokens.spacingVerticalL },
  section: { marginTop: tokens.spacingVerticalXXL, minWidth: 0, overflowWrap: 'anywhere' },
  identifier: { fontFamily: 'inherit', fontSize: 'inherit' },
  heading: { fontSize: tokens.fontSizeBase400, marginBlock: tokens.spacingVerticalM, scrollMarginBlockStart: '64px',
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '4px' } },
  tools: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: tokens.spacingHorizontalM,
    marginBlock: tokens.spacingVerticalM, minWidth: 0 },
  list: { listStyle: 'none', padding: 0, marginBlock: tokens.spacingVerticalM, display: 'grid', gap: tokens.spacingVerticalM },
  scrollList: { maxHeight: 'min(60vh, 480px)', overflowY: 'auto', scrollPaddingBlock: '16px',
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '-2px' } },
  row: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalM,
    display: 'grid', gap: tokens.spacingVerticalS, minWidth: 0, overflowWrap: 'anywhere' },
  deviceAction: { justifySelf: 'start', maxWidth: '100%', whiteSpace: 'normal', textAlign: 'start', scrollMarginBlockStart: '64px' },
  badges: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  footer: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalM, marginBlock: tokens.spacingVerticalM },
});
