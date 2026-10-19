import { makeStyles, tokens } from '@fluentui/react-components';

/** Row styles shared by the My day panels. */
export const useMyDayStyles = makeStyles({
  list: { listStyle: 'none', margin: 0, padding: 0 },
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
    paddingBlock: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    ':last-child': { borderBottom: 'none' },
  },
  rowText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  muted: { color: tokens.colorNeutralForeground3, fontVariantNumeric: 'tabular-nums' },
  warning: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-start', color: tokens.colorPaletteDarkOrangeForeground1 },
});
