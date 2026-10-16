import { makeStyles, tokens } from '@fluentui/react-components';

/** Shared by catalog and contract list pages, so both look the same. */
export const useCatalogStyles = makeStyles({
  tabs: { marginBottom: tokens.spacingVerticalL, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  filters: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalM },
  search: { width: '100%', maxWidth: '320px' },
  tableWrap: {
    overflowX: 'auto',
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  table: { minWidth: '720px' },
  number: { textAlign: 'end', fontVariantNumeric: 'tabular-nums' },
  sku: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  name: { fontWeight: tokens.fontWeightSemibold },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  more: { display: 'flex', justifyContent: 'center', paddingBlock: tokens.spacingVerticalM },
  cards: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  cardMeta: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))', gap: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}` },
  wide: { gridColumn: '1 / -1' },
});
