import { Text } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { DetailList } from '../../shared/components/Panel';
import { formatDateTime } from '../../shared/utils/format';
import type { ObservationQueue } from './observationQueueContract';
import { severities } from './technicalContract';
import { useTechnicalStyles } from './technicalStyles';

/** Keep the read's scope and uncertainty visible; detailed evidence remains available without another request. */
export function ObservationQueueInfo({ queue }: { queue: NonNullable<ObservationQueue['queue']> }) {
  const { t } = useTranslation(); const styles = useTechnicalStyles();
  const needsReview = queue.resources.filter(r => r.status !== 'OK' || r.truncated || r.asOf === null || r.lastSuccessAt === null).length;
  return <div className={styles.queueFacts}>
    <Text block weight="semibold">{t('parasolQueue.total', { total: queue.total })}</Text>
    <Text block>{t('parasolQueue.retrievedAt', { time: formatDateTime(queue.retrievedAt) })}</Text>
    <details>
      <summary tabIndex={0} className={styles.detailsSummary}>
        <span>{t('parasolQueue.readDetails')}</span>
        {queue.resources.length === 0 ? <Text weight="semibold" role="status"> · {t('parasol.noSources')}</Text>
          : needsReview > 0 && <Text weight="semibold" role="status"> · {t('parasolQueue.reviewNeeded', { count: needsReview })}</Text>}
      </summary>
      <Text block>{t('parasol.snapshot', { time: formatDateTime(queue.generatedAt) })}</Text>
      <Text block>{t('parasolQueue.countNote')}</Text>
      <DetailList items={[...severities].reverse().map(s => ({ label: t(`parasolDetails.severity.${s}`), value: String(queue.severityCounts[s]) }))} />
      <Text block weight="semibold">{t('parasolQueue.sources')}</Text>
      <Text block>{t('parasol.coverage')}</Text>
      <ul className={styles.list}>{queue.resources.map((r, i) => <li key={`${r.source}-${r.resourceType}-${i}`} className={styles.row}>
        <Text weight="semibold">{t(`parasol.sources.${r.source}`)} · {t(`parasol.resources.${r.resourceType}`)}</Text>
        <Text block>{t(`parasol.resourceStatus.${r.status}`)}</Text>
        {(r.asOf === null || r.lastSuccessAt === null) && <Text block>{t('parasolQueue.missingFreshness')}</Text>}
        {r.asOf && <Text block>{t('parasol.asOf', { time: formatDateTime(r.asOf) })}</Text>}
        {r.lastSuccessAt && <Text block>{t('parasol.lastSuccess', { time: formatDateTime(r.lastSuccessAt) })}</Text>}
        {r.returnedItems !== null && <Text block>{t(r.truncated ? 'parasol.truncated' : 'parasol.returned', { count: r.returnedItems })}</Text>}
      </li>)}</ul>
    </details>
  </div>;
}

export function ObservationQueueHelp({ deviceSelected }: { deviceSelected: boolean }) {
  const { t } = useTranslation(); const styles = useTechnicalStyles();
  return <details>
    <summary tabIndex={0} className={styles.detailsSummary}>{t('parasolQueue.about')}</summary>
    <Text block>{t('parasolQueue.note')}</Text>
    {deviceSelected && <Text block>{t('parasolQueue.deviceHistoryNote')}</Text>}
    <Text block>{t('parasolQueue.searchNote')}</Text>
  </details>;
}
