import { makeStyles, tokens } from '@fluentui/react-components';

export const useDialogStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}` },
  wide: { gridColumn: '1 / -1' },
  error: { marginBottom: tokens.spacingVerticalM },
});
