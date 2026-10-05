import {
  Button,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { AppLink } from '../../../shared/components/AppLink';
import { useCatalogStyles } from '../../catalog/styles';
import type { MigrationResult } from './api';
import { StatusText } from './parts';
import { columnText, fieldText, reasonText } from './text';

const useStyles = makeStyles({
  tiles: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalL, marginBottom: tokens.spacingVerticalM },
  tile: { display: 'flex', flexDirection: 'column', minWidth: '88px' },
  tileValue: { fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold, lineHeight: tokens.lineHeightHero700, fontVariantNumeric: 'tabular-nums' },
  section: { marginBlock: tokens.spacingVerticalM },
  heading: { margin: `0 0 ${tokens.spacingVerticalXS}`, fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold },
  list: { margin: 0, paddingInlineStart: tokens.spacingHorizontalXL },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, marginBottom: tokens.spacingVerticalM },
});

const WARNING_PREFIXES = /^(Row \d+: |Column '.*': |File: )/;

interface Props {
  result: MigrationResult;
  /** Shown for a fresh answer: the 200-row sample. A stored run lists its rows page by page instead. */
  showSample?: boolean;
  /** Re-POSTs the same file for a run that stopped. */
  onContinue?: () => void;
  continuing?: boolean;
}

/** What a preview, an import or a stored run says: counts, why rows were refused, owner coverage and the sample. */
export function ResultView({ result, showSample = true, onContinue, continuing }: Props) {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const isReal = result.mode === 'Real';
  const rejected = result.rejected ?? result.failed;
  const tiles: Array<[string, number]> = [
    [t('migration.counts.rows'), result.rowsTotal],
    [t('migration.counts.created'), result.created],
    [t('migration.counts.updated'), result.updated],
    [t('migration.counts.unchanged'), result.unchanged],
    [t('migration.counts.conflicts'), result.conflicts],
    [t('migration.counts.rejected'), rejected],
    [t('migration.counts.contacts'), result.contacts],
  ];
  const reasons = Object.entries(result.reasonCounts ?? {});
  const warningCounts = Object.entries(result.warningCounts ?? {});
  const validated = Object.entries(result.validatedNotImported ?? {});
  const fileNotes = (result.warnings ?? []).flatMap((warning) => {
    const ignored = /^Column '(.*)': COLUMN_IGNORED$/.exec(warning);
    if (ignored) return [t('migration.columnIgnored', { column: ignored[1] })];
    const file = /^File: (.*)$/.exec(warning);
    if (file) return [reasonText(t, file[1]!)];
    // Row warnings are counted in the breakdown above; anything else is shown as the server wrote it.
    return WARNING_PREFIXES.test(warning) ? [] : [warning];
  });
  const owners = result.owners;
  const listed = result.rows.length;
  const listable = result.created + result.updated + result.conflicts + rejected;

  return (
    <div>
      <p className={styles.muted} style={{ margin: '0 0 8px' }}>
        {isReal ? t('migration.runKindReal') : t('migration.runKindPreview')} · <StatusText kind="status" value={result.status} /> ·{' '}
        <span title={result.sourceSha256}>{t('migration.fileHash', { hash: result.sourceSha256.slice(0, 12) })}</span> ·{' '}
        {t('migration.mapping', { version: result.mappingVersion })}
      </p>

      {isReal && result.repeated && (
        <MessageBar intent="info" className={styles.section}>
          <MessageBarBody>{t('migration.repeated')}</MessageBarBody>
        </MessageBar>
      )}

      {isReal && result.status === 'Partial' && (
        <MessageBar intent="warning" className={styles.section}>
          <MessageBarBody>
            {t('migration.partial', { line: result.lastCommittedLine })}{' '}
            {result.failedFromLine != null && result.failedToLine != null && t('migration.partialRange', { from: result.failedFromLine, to: result.failedToLine })}{' '}
            {result.failureCode && reasonText(t, result.failureCode)}
          </MessageBarBody>
          {onContinue && (
            <MessageBarActions>
              <Button onClick={onContinue} disabled={continuing}>
                {t('migration.continue')}
              </Button>
            </MessageBarActions>
          )}
        </MessageBar>
      )}

      {isReal && result.status === 'Failed' && (
        <MessageBar intent="error" className={styles.section}>
          <MessageBarBody>
            {t('migration.runFailed', { line: result.lastCommittedLine })} {result.failureCode && reasonText(t, result.failureCode)}
          </MessageBarBody>
          {onContinue && (
            <MessageBarActions>
              <Button onClick={onContinue} disabled={continuing}>
                {t('migration.continue')}
              </Button>
            </MessageBarActions>
          )}
        </MessageBar>
      )}

      <dl className={styles.tiles} aria-label={t('migration.counts.title')} style={{ margin: 0 }}>
        {tiles.map(([label, value]) => (
          <div key={label} className={styles.tile}>
            <dt className={styles.muted}>{label}</dt>
            <dd className={styles.tileValue} style={{ margin: 0 }}>
              {value}
            </dd>
          </div>
        ))}
      </dl>

      {reasons.length > 0 && (
        <section className={styles.section} aria-label={t('migration.reasonsTitle')}>
          <h3 className={styles.heading}>{t('migration.reasonsTitle')}</h3>
          <ul className={styles.list}>
            {reasons.map(([code, count]) => (
              <li key={code}>
                {reasonText(t, code)}: <strong>{count}</strong>
              </li>
            ))}
          </ul>
        </section>
      )}

      {warningCounts.length > 0 && (
        <section className={styles.section} aria-label={t('migration.warningsTitle')}>
          <h3 className={styles.heading}>{t('migration.warningsTitle')}</h3>
          <ul className={styles.list}>
            {warningCounts.map(([code, count]) => (
              <li key={code}>
                {reasonText(t, code)}: <strong>{count}</strong>
              </li>
            ))}
          </ul>
        </section>
      )}

      {fileNotes.length > 0 && (
        <MessageBar intent="warning" className={styles.section}>
          <MessageBarBody>{fileNotes.join(' ')}</MessageBarBody>
        </MessageBar>
      )}

      <section className={styles.section} aria-label={t('migration.ownersTitle')}>
        <h3 className={styles.heading}>{t('migration.ownersTitle')}</h3>
        {owners?.columnPresent ? (
          <Text>{t('migration.owners', { resolved: owners.resolved, empty: owners.empty, unknown: owners.unknown })}</Text>
        ) : (
          <Text>{t('migration.ownersNone')}</Text>
        )}
      </section>

      {validated.length > 0 && (
        <section className={styles.section} aria-label={t('migration.validatedTitle')}>
          <h3 className={styles.heading}>{t('migration.validatedTitle')}</h3>
          <p className={styles.muted} style={{ margin: '0 0 4px' }}>
            {t('migration.validatedHint')}
          </p>
          <ul className={styles.list}>
            {validated.map(([column, count]) => (
              <li key={column}>
                {columnText(t, column)}: <strong>{count}</strong>
              </li>
            ))}
          </ul>
        </section>
      )}

      {showSample && listed > 0 && (
        <>
          <div className={catalog.tableWrap} tabIndex={0} role="region" aria-label={t('migration.sampleTitle')}>
            <Table className={catalog.table} aria-label={t('migration.sampleTitle')}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell className={catalog.number}>{t('migration.fields.line')}</TableHeaderCell>
                  <TableHeaderCell>{t('migration.fields.customer')}</TableHeaderCell>
                  <TableHeaderCell>{t('migration.fields.action')}</TableHeaderCell>
                  <TableHeaderCell>{t('migration.fields.reason')}</TableHeaderCell>
                  <TableHeaderCell>{t('migration.fields.fields')}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.map((row) => (
                  <TableRow key={`${row.line}-${row.action}`}>
                    <TableCell className={catalog.number}>{row.line}</TableCell>
                    <TableCell>
                      {row.organizationId && isReal ? (
                        <AppLink to={`/organizations/${row.organizationId}`}>{row.name ?? t('migration.openCustomer')}</AppLink>
                      ) : (
                        <span className={catalog.name}>{row.name ?? '—'}</span>
                      )}
                      {row.orgNumber && <div className={catalog.sku}>{row.orgNumber}</div>}
                    </TableCell>
                    <TableCell>
                      <StatusText kind="actions" value={row.action} />
                    </TableCell>
                    <TableCell className={catalog.muted}>
                      {(row.reasonCode ?? row.detail) ? reasonText(t, (row.reasonCode ?? row.detail)!) : '—'}
                      {(row.warnings ?? []).map((code) => (
                        <div key={code}>{reasonText(t, code)}</div>
                      ))}
                    </TableCell>
                    <TableCell className={catalog.muted}>
                      {row.conflictFields && row.conflictFields.length > 0 && (
                        <div>{t('migration.conflictFields', { fields: row.conflictFields.map((f) => fieldText(t, f)).join(', ') })}</div>
                      )}
                      {row.fieldsChanged && row.fieldsChanged.length > 0 && (
                        <div>{t('migration.filledFields', { fields: row.fieldsChanged.map((f) => fieldText(t, f)).join(', ') })}</div>
                      )}
                      {!row.conflictFields?.length && !row.fieldsChanged?.length && '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Text className={styles.muted} aria-live="polite">
            {t('migration.rowsShown', { shown: listed, total: Math.max(listable, listed) })}
          </Text>
        </>
      )}
    </div>
  );
}
