import { useState } from 'react';
import { mergeClasses } from '@fluentui/react-components';
import type { ObservationTaskLink } from './observationTaskContract';
import type { AtlasDevice, AtlasObservation } from './technicalContract';
import { useTechnicalStyles } from './technicalStyles';
import { ObservationWorkButton } from './ObservationWorkButton';
import { ObservationContext } from './ObservationContext';
import { TechnicalList } from './TechnicalList';
import { useObservationTaskLinks } from './useObservationTaskLinks';

/**
 * `raised` puts the rows on the card colour, for a list that already sits in a well (a customer on My day). `links` are the
 * tasks the rows already have when the read that produced them carried them (My day); otherwise the page reads them once.
 */
export function ObservationRows({ items, devices, customerId, links: given, onSourceInvalidated, scrollLabel, scrollHint, raised = false }: {
  items: AtlasObservation[]; devices: AtlasDevice[]; customerId?: string; links?: ReadonlyMap<string, ObservationTaskLink>;
  onSourceInvalidated?: () => void; scrollLabel?: string; scrollHint?: string; raised?: boolean;
}) {
  const styles = useTechnicalStyles();
  // The work the shown rows already have, read once for the page (no row reads on its own).
  const looked = useObservationTaskLinks(customerId, customerId && !given ? items.map(o => o.id) : []);
  // A task made from a row shows in it at once; a later read of the list wins, since it also sees later changes.
  const [made, setMade] = useState<ReadonlyMap<string, ObservationTaskLink>>(() => new Map());
  const linkOf = (id: string) => (given ?? looked).get(id) ?? made.get(id);
  const rows = items.map(o => <li key={o.id} className={mergeClasses(styles.row, raised && styles.raisedRow)}>
      <ObservationContext observation={o} devices={devices} task={linkOf(o.id)}
        action={customerId && <ObservationWorkButton customerId={customerId} observationId={o.id} status={o.status} linked={Boolean(linkOf(o.id))}
          onSourceInvalidated={onSourceInvalidated} onTask={link => setMade(known => new Map(known).set(o.id, link))} />} />
    </li>);
  return scrollLabel ? <TechnicalList label={scrollLabel} scrollHint={scrollHint}>{rows}</TechnicalList> : <ul className={mergeClasses(styles.list, 'h-stagger')}>{rows}</ul>;
}
