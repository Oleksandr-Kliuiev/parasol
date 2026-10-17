import type { AtlasDevice, AtlasObservation } from './technicalContract';
import { useTechnicalStyles } from './technicalStyles';
import { ObservationWorkButton } from './ObservationWorkButton';
import { ObservationContext } from './ObservationContext';
import { TechnicalList } from './TechnicalList';

export function ObservationRows({ items, devices, customerId, onSourceInvalidated, scrollLabel, scrollHint }: {
  items: AtlasObservation[]; devices: AtlasDevice[]; customerId?: string; onSourceInvalidated?: () => void; scrollLabel?: string; scrollHint?: string;
}) {
  const styles = useTechnicalStyles();
  const rows = items.map(o => <li key={o.id} className={styles.row}>
      <ObservationContext observation={o} devices={devices} />
      {customerId && <ObservationWorkButton customerId={customerId} observationId={o.id} status={o.status} onSourceInvalidated={onSourceInvalidated} />}
    </li>);
  return scrollLabel ? <TechnicalList label={scrollLabel} scrollHint={scrollHint}>{rows}</TechnicalList> : <ul className={styles.list}>{rows}</ul>;
}
