import { Text } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { FactGrid } from '../../shared/components/Panel';
import { formatDateTime } from '../../shared/utils/format';
import type { ObservationQueue } from './observationQueueContract';
import { SourceFreshnessList } from './SourceFreshness';
import { severities } from './technicalContract';
import { useTechnicalStyles } from './technicalStyles';

/** Keep the read's scope and uncertainty visible; detailed evidence remains available without another request. */
export function ObservationQueueInfo({ queue }: { queue: NonNullable<ObservationQueue['queue']> }) {
  const { t } = useTranslation(); const styles = useTechnicalStyles();
  const needsReview = queue.resources.filter(r => r.status !== 'OK' || r.truncated || r.asOf === null || r.lastSuccessAt === null).length;
  return <div className={styles.queueFacts}>
    <Text block weight="semibold">{t('parasolQueue.total', { total: queue.total })}</Text>
    <Text block className={styles.status}>{t('parasolQueue.retrievedAt', { time: formatDateTime(queue.retrievedAt) })}</Text>
    <details className={styles.details}>
      <summary tabIndex={0} className={styles.detailsSummary}>
        <span>{t('parasolQueue.readDetails')}</span>
        {queue.resources.length === 0 ? <Text weight="semibold" role="status"> · {t('parasol.noSources')}</Text>
          : needsReview > 0 && <Text weight="semibold" role="status"> · {t('parasolQueue.reviewNeeded', { count: needsReview })}</Text>}
      </summary>
      <Text block className={styles.status}>{t('parasol.snapshot', { time: formatDateTime(queue.generatedAt) })}</Text>
      <Text block className={styles.note}>{t('parasolQueue.countNote')}</Text>
      <FactGrid className={styles.facts} items={[...severities].reverse().map(s => ({ label: t(`parasolDetails.severity.${s}`), value: String(queue.severityCounts[s]) }))} />
      <Text block weight="semibold">{t('parasolQueue.sources')}</Text>
      <Text block className={styles.note}>{t('parasol.coverage')}</Text>
      <SourceFreshnessList resources={queue.resources} missingNote />
    </details>
  </div>;
}

export function ObservationQueueHelp({ deviceSelected }: { deviceSelected: boolean }) {
  const { t } = useTranslation(); const styles = useTechnicalStyles();
  return <details className={styles.details}>
    <summary tabIndex={0} className={styles.detailsSummary}>{t('parasolQueue.about')}</summary>
    <Text block className={styles.note}>{t('parasolQueue.note')}</Text>
    {deviceSelected && <Text block className={styles.note}>{t('parasolQueue.deviceHistoryNote')}</Text>}
    <Text block className={styles.note}>{t('parasolQueue.searchNote')}</Text>
  </details>;
}
