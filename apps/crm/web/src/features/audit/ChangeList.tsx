import type { ReactNode } from 'react';
import { makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import type { AuditEntry } from '../../api/types';
import { h } from '../../app/hearth';
import { formatDate, formatDateTime } from '../../shared/utils/format';

const useStyles = makeStyles({
  // The changes of one entry as term/value rows (the DetailList of the visual system): the field on the left, the old
  // value struck through, then the new one. A long value wraps inside its column, never under the field.
  list: {
    display: 'grid',
    gridTemplateColumns: 'minmax(96px, max-content) minmax(0, 1fr)',
    columnGap: '16px',
    rowGap: '6px',
    margin: 0,
    minWidth: 0,
    // On a phone the field goes above its values, with a little more air before the next field.
    '@media (max-width: 560px)': { gridTemplateColumns: 'minmax(0, 1fr)', rowGap: '2px', '& > div:not(:first-child) > dt': { marginTop: '8px' } },
  },
  field: {
    margin: 0,
    color: h.muted,
    fontSize: '12.5px',
    lineHeight: '18px',
    fontWeight: 600,
    overflowWrap: 'anywhere',
  },
  values: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: '8px', margin: 0, fontSize: '13px', lineHeight: '18px', overflowWrap: 'anywhere', minWidth: 0 },
  old: { textDecorationLine: 'line-through', color: h.muted, minWidth: 0 },
  arrow: { color: h.faint },
  value: { minWidth: 0 },
  empty: { color: h.muted },
  // A hash or an id: the start of it in quiet monospace, the whole value in the tooltip for the admin who needs it.
  code: { fontFamily: tokens.fontFamilyMonospace, fontSize: '12px', color: h.muted },
  // A nested value (a plan, a list of findings) is one quiet line; the formatted value is one step away for the admin.
  structured: { minWidth: 0, '& > summary': { cursor: 'pointer', color: h.muted, fontWeight: 600 } },
  json: {
    margin: 0,
    marginTop: '6px',
    maxHeight: '240px',
    overflow: 'auto',
    paddingTop: '8px',
    paddingBottom: '8px',
    paddingLeft: '10px',
    paddingRight: '10px',
    borderRadius: '10px',
    backgroundColor: tokens.colorNeutralBackground3,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: '12px',
    lineHeight: '18px',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  hidden: { position: 'absolute', width: '1px', height: '1px', margin: '-1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0, padding: 0 },
});

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Hashes (hex, 32+ characters) and GUID-shaped ids, including the synthetic ones of the development tenant.
const LONG_ID = /^(?:[0-9a-f]{32,}|[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12})$/i;

/** Field labels: the audit's own names first, then the organization and contact forms. */
const labelNamespaces = ['audit.fields', 'organizations.fields', 'contacts.fields'];

/** Values of an organization's enum fields, in the words its card uses. */
const organizationValues: Record<string, string> = { status: 'status', registryStatus: 'registry' };

const lowerFirst = (part: string) => part.charAt(0).toLowerCase() + part.slice(1);

const isDiff = (value: unknown): value is { old?: unknown; new?: unknown } =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && ('new' in value || 'old' in value);

/** Field changes ("old → new") for edits; plain details (export filters, job ids…) for other audited actions. */
export function ChangeList({ changes, entityType }: { changes: AuditEntry['changes']; entityType?: string }) {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  if (!changes || typeof changes !== 'object') return null;
  const entries = Object.entries(changes as Record<string, unknown>);
  if (entries.length === 0) return null;

  /** "VisitAddress.City" → "Visiting address · City" when translations exist; otherwise the raw property path. */
  const label = (path: string) =>
    path
      .split('.')
      .map((part) => {
        const key = lowerFirst(part);
        const namespace = labelNamespaces.find((ns) => i18n.exists(`${ns}.${key}`));
        return namespace ? t(`${namespace}.${key}`) : part;
      })
      .join(' · ');

  /**
   * An object or a list of objects in words: a small flat object reads as "field: value" pairs in the form's names; anything
   * nested or long is a disclosure with the formatted value, so an entry never shows raw JSON as its text.
   */
  const structured = (value: object): ReactNode => {
    const fields = Object.entries(value);
    const flat = !Array.isArray(value) && fields.length <= 6 && fields.every(([, item]) => item === null || typeof item !== 'object');
    if (flat) return fields.map(([key, item]) => `${label(key)}: ${item === null || item === '' ? '—' : typeof item === 'boolean' ? t(item ? 'common.yes' : 'common.no') : String(item)}`).join(' · ');
    return (
      <details className={styles.structured}>
        <summary>{t('audit.structured', { count: fields.length })}</summary>
        <pre className={styles.json}>{JSON.stringify(value, null, 2)}</pre>
      </details>
    );
  };

  const text = (field: string, value: unknown): ReactNode => {
    if (value === null || value === undefined || value === '') return <span className={styles.empty}>—</span>;
    if (typeof value === 'boolean') return value ? t('common.yes') : t('common.no');
    if (Array.isArray(value)) {
      if (value.length === 0) return <span className={styles.empty}>—</span>;
      // An erasure names the fields it cleared: in the words of the form, not as property names.
      if (lowerFirst(field) === 'fields') return value.map((item) => (typeof item === 'string' ? label(item) : String(item))).join(', ');
      if (value.some((item) => typeof item === 'object' && item !== null)) return structured(value);
      return value.map(String).join(', ');
    }
    if (typeof value === 'object') return structured(value);
    const raw = String(value);
    if (typeof value === 'string') {
      // Some fields store their value as JSON text (a privacy plan, billing anomalies): read it as the value it holds.
      if (/^\s*[[{]/.test(raw)) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (parsed !== null && typeof parsed === 'object') return structured(parsed);
        } catch { /* not JSON after all: shown as text below */ }
      }
      if (ISO_DATE_TIME.test(raw) && !Number.isNaN(Date.parse(raw))) return formatDateTime(raw);
      if (ISO_DATE.test(raw)) return formatDate(raw);
      if (LONG_ID.test(raw)) return <span className={styles.code} title={raw}>{`${raw.slice(0, 8)}…`}</span>;
      if (lowerFirst(field) === 'roles') {
        return raw
          .split(',')
          .map((role) => role.trim())
          .map((role) => (/^Crm\.\w+$/.test(role) && i18n.exists(`appRoles.${role.slice(4)}`) ? t(`appRoles.${role.slice(4)}`) : role))
          .join(', ');
      }
      const namespace = entityType === 'Organization' ? organizationValues[lowerFirst(field)] : undefined;
      if (namespace && i18n.exists(`${namespace}.${raw}`)) return t(`${namespace}.${raw}`);
    }
    return raw;
  };

  return (
    <dl className={styles.list}>
      {entries.map(([field, change]) => (
        <div key={field} style={{ display: 'contents' }}>
          <dt className={styles.field} title={field}>{label(field)}</dt>
          <dd className={styles.values}>
            {isDiff(change) ? (
              <>
                {'old' in change && change.old !== null && change.old !== undefined && change.old !== '' && (
                  <>
                    <span className={styles.old}>{text(field, change.old)}</span>
                    <span className={styles.arrow} aria-hidden>
                      →
                    </span>
                    <span className={styles.hidden}>{t('audit.changedTo')}</span>
                  </>
                )}
                <span className={styles.value}>{text(field, change.new)}</span>
              </>
            ) : (
              <span className={styles.value}>{text(field, change)}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
