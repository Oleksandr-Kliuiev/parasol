import { makeStyles, tokens } from '@fluentui/react-components';
import { formatMoney } from '../../../shared/utils/format';

export const usePilotStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  scroll: {
    overflowX: 'auto',
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  table: { minWidth: '720px' },
  number: { textAlign: 'end', fontVariantNumeric: 'tabular-nums' },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere' },
  filters: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalM },
  actions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, alignItems: 'center' },
  facts: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: tokens.spacingHorizontalM, margin: 0 },
  fact: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  list: { margin: 0, paddingInlineStart: tokens.spacingHorizontalL, display: 'grid', rowGap: tokens.spacingVerticalXS },
  heading: { margin: `${tokens.spacingVerticalM} 0 ${tokens.spacingVerticalXS}`, fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold },
  good: { color: tokens.colorPaletteGreenForeground1, fontWeight: tokens.fontWeightSemibold },
  warn: { color: tokens.colorPaletteDarkOrangeForeground1, fontWeight: tokens.fontWeightSemibold },
  bad: { color: tokens.colorPaletteRedForeground1, fontWeight: tokens.fontWeightSemibold },
  group: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingHorizontalM, margin: 0, minWidth: 0 },
  neutral: { color: tokens.colorNeutralForeground1, fontWeight: tokens.fontWeightSemibold },
});

/** Money that the API removed (no finance.read) shows as a dash, never as zero. */
export const money = (value: number | null | undefined, currency = 'NOK') => (value === null || value === undefined ? '—' : formatMoney(value, currency));
