import { Text, makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';

const useStyles = makeStyles({
  Created: { color: tokens.colorPaletteGreenForeground1, fontWeight: tokens.fontWeightSemibold },
  Updated: { color: tokens.colorNeutralForeground1, fontWeight: tokens.fontWeightSemibold },
  Unchanged: { color: tokens.colorNeutralForeground3 },
  Conflict: { color: tokens.colorPaletteDarkOrangeForeground1, fontWeight: tokens.fontWeightSemibold },
  Rejected: { color: tokens.colorPaletteRedForeground1, fontWeight: tokens.fontWeightSemibold },
  Failed: { color: tokens.colorPaletteRedForeground1, fontWeight: tokens.fontWeightSemibold },
  Running: { color: tokens.colorNeutralForeground1 },
  Completed: { color: tokens.colorPaletteGreenForeground1, fontWeight: tokens.fontWeightSemibold },
  Partial: { color: tokens.colorPaletteDarkOrangeForeground1, fontWeight: tokens.fontWeightSemibold },
  Matched: { color: tokens.colorPaletteGreenForeground1, fontWeight: tokens.fontWeightSemibold },
  Different: { color: tokens.colorPaletteDarkOrangeForeground1, fontWeight: tokens.fontWeightSemibold },
  Compared: { color: tokens.colorNeutralForeground1 },
  MissingInCrm: { color: tokens.colorPaletteRedForeground1, fontWeight: tokens.fontWeightSemibold },
  MissingCustomer: { color: tokens.colorPaletteRedForeground1, fontWeight: tokens.fontWeightSemibold },
  MissingInFile: { color: tokens.colorPaletteDarkOrangeForeground1, fontWeight: tokens.fontWeightSemibold },
});

type Known = keyof ReturnType<typeof useStyles>;

/** An outcome, run status or reconciliation status as plain text with a palette foreground (badges fail the dark-theme contrast check). */
export function StatusText({ kind, value }: { kind: 'actions' | 'status' | 'recon'; value: string }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const style = (styles as Record<string, string>)[value as Known];
  return <Text className={style}>{t(`migration.${kind}.${value}`, { defaultValue: value })}</Text>;
}
