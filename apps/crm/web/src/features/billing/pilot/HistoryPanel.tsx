import { Badge, Spinner, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@fluentui/react-components';
import { History16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { ErrorState } from '../../../shared/components/ErrorState';
import { Panel } from '../../../shared/components/Panel';
import { formatDateTime } from '../../../shared/utils/format';
import { useOverview, type PilotOverview } from './api';
import { ScrollRegion } from './parts';
import { usePilotStyles } from './styles';

const short = (sha: string) => sha.slice(0, 12);

/** Current or out of date, as a pill: the run changed after the comparison was made. */
function Freshness({ stale }: { stale: boolean }) {
  const { t } = useTranslation();
  return (
    <Badge appearance="tint" color={stale ? 'warning' : 'success'}>
      {stale ? t('pilot.history.stale') : t('pilot.history.current')}
    </Badge>
  );
}

/** Metadata only: who, when, hashes and counts. The explanations and amounts stay in the stored documents. */
export function HistoryView({ overview }: { overview: PilotOverview }) {
  const styles = usePilotStyles();
  const { t } = useTranslation();
  return (
    <>
      <p className={styles.lead}>{t('pilot.history.staleHint')}</p>
      <h3 className={styles.heading} style={{ marginTop: 0 }}>
        {t('pilot.history.comparisons')}
      </h3>
      {overview.comparisons.length === 0 ? (
        <p className={styles.muted}>{t('pilot.history.noComparisons')}</p>
      ) : (
        <ScrollRegion label={t('pilot.history.comparisons')}>
          <Table className={styles.table} aria-label={t('pilot.history.comparisons')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('pilot.history.when')}</TableHeaderCell>
                <TableHeaderCell>{t('pilot.history.by')}</TableHeaderCell>
                <TableHeaderCell>{t('pilot.history.fileSha')}</TableHeaderCell>
                <TableHeaderCell className={styles.number}>{t('pilot.history.rows')}</TableHeaderCell>
                <TableHeaderCell className={styles.number}>{t('pilot.history.exceptions')}</TableHeaderCell>
                <TableHeaderCell className={styles.number}>{t('pilot.history.signoffs')}</TableHeaderCell>
                <TableHeaderCell>{t('common.status')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.comparisons.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="tabular">{formatDateTime(c.at)}</TableCell>
                  <TableCell>{c.createdBy.name}</TableCell>
                  <TableCell className={styles.key} title={c.fileSha256}>
                    {short(c.fileSha256)}
                  </TableCell>
                  <TableCell className={styles.number}>{c.fileRows}</TableCell>
                  <TableCell className={styles.number}>{c.exceptionCount}</TableCell>
                  <TableCell className={styles.number}>{c.signoffs}</TableCell>
                  <TableCell>
                    <Freshness stale={c.stale} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollRegion>
      )}
      <h3 className={styles.heading}>{t('pilot.history.signoffsTitle')}</h3>
      {overview.signoffs.length === 0 ? (
        <p className={styles.muted}>{t('pilot.history.noSignoffs')}</p>
      ) : (
        <ScrollRegion label={t('pilot.history.signoffsTitle')}>
          <Table className={styles.table} aria-label={t('pilot.history.signoffsTitle')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('pilot.history.signedAt')}</TableHeaderCell>
                <TableHeaderCell>{t('pilot.history.signedBy')}</TableHeaderCell>
                <TableHeaderCell>{t('pilot.history.comparison')}</TableHeaderCell>
                <TableHeaderCell className={styles.number}>{t('pilot.history.exceptions')}</TableHeaderCell>
                <TableHeaderCell>{t('pilot.history.documentSha')}</TableHeaderCell>
                <TableHeaderCell>{t('common.status')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.signoffs.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="tabular">{formatDateTime(s.signedAt)}</TableCell>
                  <TableCell>{s.signedBy.name}</TableCell>
                  <TableCell className={styles.key} title={s.comparisonId}>
                    {short(s.comparisonSha256)}
                  </TableCell>
                  <TableCell className={styles.number}>{s.exceptionCount}</TableCell>
                  <TableCell className={styles.key} title={s.documentSha256}>
                    {short(s.documentSha256)}
                  </TableCell>
                  <TableCell>
                    <Freshness stale={s.stale} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollRegion>
      )}
    </>
  );
}

export function HistoryPanel({ runId }: { runId: string }) {
  const { t } = useTranslation();
  const overview = useOverview(runId);
  return (
    <Panel title={t('pilot.history.title')} icon={<History16Regular />}>
      {overview.isPending ? (
        <Spinner size="small" label={t('common.loading')} />
      ) : overview.error ? (
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
      ) : (
        <HistoryView overview={overview.data} />
      )}
    </Panel>
  );
}
