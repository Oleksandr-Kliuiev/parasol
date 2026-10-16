import type { AtlasDevice, AtlasObservation } from './technicalContract';
import { useTechnicalStyles } from './technicalStyles';
import { ObservationWorkButton } from './ObservationWorkButton';
import { ObservationContext } from './ObservationContext';

export function ObservationRows({ items, devices, customerId, onSourceInvalidated }: {
  items: AtlasObservation[]; devices: AtlasDevice[]; customerId?: string; onSourceInvalidated?: () => void;
}) {
  const styles = useTechnicalStyles();
  return <ul className={styles.list}>
    {items.map(o => <li key={o.id} className={styles.row}>
      <ObservationContext observation={o} devices={devices} />
      {customerId && <ObservationWorkButton customerId={customerId} observationId={o.id} status={o.status} onSourceInvalidated={onSourceInvalidated} />}
    </li>)}
  </ul>;
}
