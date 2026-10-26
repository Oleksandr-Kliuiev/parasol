import { Badge, type BadgeProps } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';

/** The tone of an outcome, run status or reconciliation status: green done, amber needs a look, red refused or missing. */
const colors: Record<string, BadgeProps['color']> = {
  Created: 'success',
  Updated: 'informative',
  Unchanged: 'subtle',
  Conflict: 'warning',
  Rejected: 'danger',
  Failed: 'danger',
  Running: 'informative',
  Completed: 'success',
  Partial: 'warning',
  Matched: 'success',
  Different: 'warning',
  Compared: 'informative',
  MissingInCrm: 'danger',
  MissingCustomer: 'danger',
  MissingInFile: 'warning',
};

/** An outcome, run status or reconciliation status as a status pill; a value the interface does not know is neutral. */
export function StatusText({ kind, value }: { kind: 'actions' | 'status' | 'recon'; value: string }) {
  const { t } = useTranslation();
  return (
    <Badge appearance="tint" color={colors[value] ?? 'subtle'}>
      {t(`migration.${kind}.${value}`, { defaultValue: value })}
    </Badge>
  );
}
