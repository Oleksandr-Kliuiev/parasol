import { Badge, makeStyles, mergeClasses } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { formatDateTime } from '../../shared/utils/format';
import type { AtlasResource } from './technicalContract';
import { resourceTone, useTechnicalStyles } from './technicalStyles';

type Resource = AtlasResource;


const useStyles = makeStyles({
  list: { gap: '6px' },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'center',
    columnGap: '12px',
    rowGap: '2px',
    paddingTop: '10px',
    paddingBottom: '10px',
    paddingLeft: '12px',
    paddingRight: '12px',
    borderRadius: '12px',
    backgroundColor: h.well,
    minWidth: 0,
  },
  name: { fontWeight: 600, fontSize: '14px', lineHeight: '20px', overflowWrap: 'anywhere' },
  pill: { justifySelf: 'end' },
  meta: {
    gridColumn: '1 / -1',
    display: 'flex',
    flexWrap: 'wrap',
    rowGap: '2px',
    color: h.muted,
    fontSize: '12.5px',
    lineHeight: '18px',
    '&:empty': { display: 'none' },
    // Facts side by side with a gap, no separators: a wrapped line never starts with a dot.
    columnGap: '14px',
  },
});

/** Source coverage and freshness as compact rows: the source, its state as a pill, then the times and counts. */
export function SourceFreshnessList({ resources, missingNote }: { resources: Resource[]; missingNote?: boolean }) {
  const { t } = useTranslation(); const technical = useTechnicalStyles(); const styles = useStyles();
  return <ul className={mergeClasses(technical.list, styles.list, 'h-stagger')}>
    {resources.map((r, i) => <li key={`${r.source}-${r.resourceType}-${i}`} className={styles.row}>
      <span className={styles.name}>{t(`parasol.sources.${r.source}`)} · {t(`parasol.resources.${r.resourceType}`)}</span>
      <Badge className={styles.pill} appearance="tint" color={resourceTone[r.status]}>{t(`parasol.resourceStatus.${r.status}`)}</Badge>
      <span className={styles.meta}>
        {missingNote && (r.asOf === null || r.lastSuccessAt === null) && <span>{t('parasolQueue.missingFreshness')}</span>}
        {r.asOf && <span>{t('parasol.asOf', { time: formatDateTime(r.asOf) })}</span>}
        {r.lastSuccessAt && <span>{t('parasol.lastSuccess', { time: formatDateTime(r.lastSuccessAt) })}</span>}
        {r.returnedItems !== null && <span>{t(r.truncated ? 'parasol.truncated' : 'parasol.returned', { count: r.returnedItems })}</span>}
      </span>
    </li>)}
  </ul>;
}
