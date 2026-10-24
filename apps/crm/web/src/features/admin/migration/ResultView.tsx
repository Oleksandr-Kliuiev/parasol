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
  mergeClasses,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { FactGrid } from '../../../shared/components/Panel';
import { AppLink } from '../../../shared/components/AppLink';
import { ScrollRegion } from '../ScrollRegion';
import { useTableCardStyles } from '../tableCard';
import type { MigrationResult } from './api';
import { StatusText } from './parts';
import { useMigrationStyles } from './styles';
import { columnText, fieldText, reasonText } from './text';

const useStyles = makeStyles({
  // Seven counts: a tile row that keeps two or more tiles per line on a phone.
  tiles: { gridTemplateColumns: 'repeat(auto-fit, minmax(min(120px, 100%), 1fr))' },
  kind: { fontWeight: 700, color: 'inherit' },
  footnote: { display: 'block', marginTop: '8px', maxWidth: '75ch' },
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

/** A small breakdown: what each row says on the left, how many rows on the right. */
function Breakdown({ label, hint, rows }: { label: string; hint?: string; rows: Array<[string, number]> }) {
  const m = useMigrationStyles();
  return (
    <section className={m.well} aria-label={label}>
      <h3 className={m.wellTitle}>{label}</h3>
      {hint && <p className={m.wellHint}>{hint}</p>}
      <ul className={m.counts}>
        {rows.map(([text, count], index) => (
          <li key={`${index}-${text}`} className={m.countRow}>
            <span>{text}</span>
            <span className={m.countValue}>{count}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What a preview, an import or a stored run says: counts, why rows were refused, owner coverage and the sample. */
export function ResultView({ result, showSample = true, onContinue, continuing }: Props) {
  const styles = useStyles();
  const m = useMigrationStyles();
  const table = useTableCardStyles();
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
    <div className={m.stack}>
      <div className={m.meta}>
        <span className={styles.kind}>{isReal ? t('migration.runKindReal') : t('migration.runKindPreview')}</span>
        {' · '}
        <StatusText kind="status" value={result.status} />
        {' · '}
        <span title={result.sourceSha256}>{t('migration.fileHash', { hash: result.sourceSha256.slice(0, 12) })}</span>
        {' · '}
        <span>{t('migration.mapping', { version: result.mappingVersion })}</span>
      </div>

      {isReal && result.repeated && (
        <MessageBar intent="info">
          <MessageBarBody>{t('migration.repeated')}</MessageBarBody>
        </MessageBar>
      )}

      {isReal && result.status === 'Partial' && (
        <MessageBar intent="warning" layout="multiline">
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
        <MessageBar intent="error" layout="multiline">
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

      <div role="group" aria-label={t('migration.counts.title')}>
        <FactGrid className={styles.tiles} items={tiles.map(([label, value]) => ({ label, value: String(value) }))} />
      </div>

      {fileNotes.length > 0 && (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>{fileNotes.join(' ')}</MessageBarBody>
        </MessageBar>
      )}

      <div className={m.sections}>
        {reasons.length > 0 && <Breakdown label={t('migration.reasonsTitle')} rows={reasons.map(([code, count]) => [reasonText(t, code), count])} />}
        {warningCounts.length > 0 && <Breakdown label={t('migration.warningsTitle')} rows={warningCounts.map(([code, count]) => [reasonText(t, code), count])} />}
        {owners?.columnPresent ? (
          <Breakdown
            label={t('migration.ownersTitle')}
            rows={[
              [t('migration.ownerCounts.resolved'), owners.resolved],
              [t('migration.ownerCounts.empty'), owners.empty],
              [t('migration.ownerCounts.unknown'), owners.unknown],
            ]}
          />
        ) : (
          <section className={m.well} aria-label={t('migration.ownersTitle')}>
            <h3 className={m.wellTitle}>{t('migration.ownersTitle')}</h3>
            <p className={m.wellHint}>{t('migration.ownersNone')}</p>
          </section>
        )}
        {validated.length > 0 && (
          <Breakdown label={t('migration.validatedTitle')} hint={t('migration.validatedHint')} rows={validated.map(([column, count]) => [columnText(t, column), count])} />
        )}
      </div>

      {showSample && listed > 0 && (
        <div>
          <ScrollRegion className={table.inset} label={t('migration.sampleTitle')}>
            <Table className={table.min720} aria-label={t('migration.sampleTitle')}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell className={mergeClasses(table.numberHead, table.lineCol)}>{t('migration.fields.line')}</TableHeaderCell>
                  <TableHeaderCell>{t('migration.fields.customer')}</TableHeaderCell>
                  <TableHeaderCell>{t('migration.fields.action')}</TableHeaderCell>
                  <TableHeaderCell>{t('migration.fields.reason')}</TableHeaderCell>
                  <TableHeaderCell>{t('migration.fields.fields')}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.map((row) => (
                  <TableRow key={`${row.line}-${row.action}`}>
                    <TableCell className={table.number}>{row.line}</TableCell>
                    <TableCell>
                      {row.organizationId && isReal ? (
                        <AppLink to={`/organizations/${row.organizationId}`}>{row.name ?? t('migration.openCustomer')}</AppLink>
                      ) : (
                        <span className={table.name}>{row.name ?? '—'}</span>
                      )}
                      {row.orgNumber && <div className={table.code}>{row.orgNumber}</div>}
                    </TableCell>
                    <TableCell>
                      <StatusText kind="actions" value={row.action} />
                    </TableCell>
                    <TableCell className={table.muted}>
                      {(row.reasonCode ?? row.detail) ? reasonText(t, (row.reasonCode ?? row.detail)!) : !row.warnings?.length && '—'}
                      {(row.warnings ?? []).map((code) => (
                        <div key={code}>{reasonText(t, code)}</div>
                      ))}
                    </TableCell>
                    <TableCell className={table.muted}>
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
          </ScrollRegion>
          <Text className={mergeClasses(m.note, styles.footnote)} aria-live="polite">
            {t('migration.rowsShown', { shown: listed, total: Math.max(listable, listed) })}
          </Text>
        </div>
      )}
    </div>
  );
}
