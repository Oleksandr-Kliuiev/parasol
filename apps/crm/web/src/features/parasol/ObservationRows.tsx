import { Badge, Text } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../shared/utils/format';
import type { AtlasDevice, AtlasObservation } from './technicalContract';
import { useTechnicalStyles } from './technicalStyles';

export function ObservationRows({ items, devices }: { items: AtlasObservation[]; devices: AtlasDevice[] }) {
  const { t } = useTranslation();
  const styles = useTechnicalStyles();
  const registry = new Map(devices.map(d => [d.id, d.hostname]));
  return <ul className={styles.list}>
    {items.map(o => <li key={o.id} className={styles.row}>
      <div className={styles.badges}>
        <Badge appearance="tint" color={o.priority === 'URGENT' ? 'danger' : 'informative'}>{t(`parasolDetails.severity.${o.severity}`)}</Badge>
        {o.priority === 'URGENT' && <Text weight="semibold">{t('parasolDetails.urgent')}</Text>}
        <Text>{t(`parasolDetails.status.${o.status}`)}</Text>
      </div>
      <Text weight="semibold">{o.summary || t('parasolDetails.noSummary')}</Text>
      <Text>{t(`parasol.sources.${o.source}`)} · {t(`parasolDetails.kind.${o.kind}`)}</Text>
      <Text>{o.deviceId ? t('parasolDetails.confirmedDevice', { name: registry.get(o.deviceId), id: o.deviceId })
        : t(`parasolDetails.deviceStatus.${o.deviceStatus}`)}</Text>
      <Text>{t('parasolDetails.route')}: {t(`parasolDetails.routes.${o.route}`)}</Text>
      <Text>{t('parasolDetails.occurredAt', { time: formatDateTime(o.occurredAt) })}</Text>
      <Text>{t('parasolDetails.updatedAt', { time: formatDateTime(o.updatedAt) })}</Text>
    </li>)}
  </ul>;
}
