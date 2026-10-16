import { useId } from 'react';
import { Checkbox, Label, makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { contactRoles, type ContactRole } from '../../api/types';

const useStyles = makeStyles({
  group: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, border: 'none', margin: 0, padding: 0, minWidth: 0 },
  options: { display: 'flex', flexWrap: 'wrap', columnGap: tokens.spacingHorizontalL },
});

/**
 * Role checkboxes as a labelled group. Not wrapped in Fluent's Field: Field labels its control, which would give every
 * checkbox the group label ("Roles") as its accessible name instead of its own.
 */
export function RolePicker({ label, value, onChange, className }: { label: string; value: ContactRole[]; onChange: (roles: ContactRole[]) => void; className?: string }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className={`${styles.group} ${className ?? ''}`}>
      <Label id={labelId}>{label}</Label>
      <div className={styles.options}>
        {contactRoles.map((role) => (
          <Checkbox
            key={role}
            label={t(`roles.${role}`)}
            checked={value.includes(role)}
            onChange={(_, d) => onChange(d.checked ? [...value, role] : value.filter((r) => r !== role))}
          />
        ))}
      </div>
    </div>
  );
}
