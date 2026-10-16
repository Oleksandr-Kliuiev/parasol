import { makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import type { AuditEntry } from '../../api/types';

const useStyles = makeStyles({
  list: { margin: 0, paddingLeft: tokens.spacingHorizontalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  field: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  old: { textDecorationLine: 'line-through', color: tokens.colorNeutralForeground3 },
  arrow: { color: tokens.colorNeutralForeground3, paddingInline: tokens.spacingHorizontalXS },
});

function show(value: unknown): string {
  if (value === null || value === undefined || value === '') return '∅';
  if (Array.isArray(value)) return value.join(', ') || '∅';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const labelNamespaces = ['organizations.fields', 'contacts.fields'];

/** "VisitAddress.City" → "Visiting address · City" when translations exist; otherwise the raw property path. */
function useFieldLabel() {
  const { t, i18n } = useTranslation();
  return (path: string) =>
    path
      .split('.')
      .map((part) => {
        const key = part.charAt(0).toLowerCase() + part.slice(1);
        const namespace = labelNamespaces.find((ns) => i18n.exists(`${ns}.${key}`));
        return namespace ? t(`${namespace}.${key}`) : part;
      })
      .join(' · ');
}

const isDiff = (value: unknown): value is { old?: unknown; new?: unknown } =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && ('new' in value || 'old' in value);

/** Field changes ("old → new") for edits; plain details (export filters, job ids…) for other audited actions. */
export function ChangeList({ changes }: { changes: AuditEntry['changes'] }) {
  const styles = useStyles();
  const label = useFieldLabel();
  if (!changes || typeof changes !== 'object') return null;
  return (
    <ul className={styles.list}>
      {Object.entries(changes as Record<string, unknown>).map(([field, change]) => (
        <li key={field}>
          <span className={styles.field} title={field}>{label(field)}</span>:{' '}
          {isDiff(change) ? (
            <>
              {'old' in change && (
                <>
                  <span className={styles.old}>{show(change.old)}</span>
                  <span className={styles.arrow} aria-hidden>
                    →
                  </span>
                </>
              )}
              <span>{show(change.new)}</span>
            </>
          ) : (
            <span>{show(change)}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
