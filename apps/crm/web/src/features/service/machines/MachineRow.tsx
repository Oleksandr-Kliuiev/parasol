import { Badge, Link, Text, makeStyles, useRestoreFocusTarget } from '@fluentui/react-components';
import { Desktop16Regular, Open16Regular, Server16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../../app/hearth';
import { formatDateTime, formatRelative } from '../../../shared/utils/format';
import { safeHttpUrl } from '../../../shared/utils/safeUrl';
import { RecordRow, RowMeta } from '../../billing/RecordRow';
import { sourceName } from '../alerts/alertText';
import type { Machine } from '../types';

const useStyles = makeStyles({
  // The name is the way into the machine's card: it wraps like text and keeps a 24 px hit box (WCAG 2.5.8).
  open: { textAlign: 'left', minHeight: '24px', fontWeight: 600, overflowWrap: 'anywhere' },
  title: { display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '6px', minWidth: 0 },
  external: { display: 'inline-flex', alignItems: 'center', gap: '4px', minHeight: '24px', minWidth: '24px', justifyContent: 'center', '& svg': { flexShrink: 0 } },
  seen: { color: h.muted, fontSize: '12.5px', lineHeight: '18px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
});

/**
 * One computer of the customer (M40), whichever sources watch it: its kind and system, the sources that report it, when it was
 * last in touch at the last read (nightly), its open alerts and a hint when it may be another machine of the customer. The name
 * opens its card; the mark beside it opens the computer in its first source.
 */
export function MachineRow({ machine, onOpen }: { machine: Machine; onOpen: (machine: Machine) => void }) {
  const styles = useStyles(); const { t } = useTranslation(); const restore = useRestoreFocusTarget();
  const first = machine.sources[0];
  const href = first?.url ? safeHttpUrl(first.url) : undefined;
  const sources = machine.sources.map((s) => sourceName(t, s.system)).filter((name, index, all) => all.indexOf(name) === index).join(', ');
  return <RecordRow icon={machine.type === 'Server' ? <Server16Regular /> : <Desktop16Regular />} tone={machine.online ? 'spruce' : 'neutral'}
    title={<span className={styles.title}>
      <Link {...restore} as="button" type="button" className={styles.open} onClick={() => onOpen(machine)}>{machine.name}</Link>
      {/* The visible name starts the accessible name (WCAG 2.5.3); the rest says where the link leads. */}
      {href && first && <Link href={href} target="_blank" rel="noopener noreferrer" className={styles.external}
        aria-label={t('service.deviceOpen', { name: machine.name, source: sourceName(t, first.system) })}><Open16Regular aria-hidden /></Link>}
    </span>}
    meta={<RowMeta>{[t(`service.deviceType.${machine.type}`), machine.os, sources && t('machines.from', { sources })].filter(Boolean).join(' · ')}</RowMeta>}
    end={<>
      {machine.proposals > 0 && <Badge appearance="tint" color="warning">{t('machines.proposalBadge', { count: machine.proposals })}</Badge>}
      {/* Only a machine with something open says so: a column of zeros would hide the ones that matter. */}
      {machine.openAlerts > 0 && <Badge appearance="tint" color="danger">{t('service.deviceOpenAlerts', { count: machine.openAlerts })}</Badge>}
      <Text className={styles.seen}>{machine.lastSeenAt
        ? <>{t('service.lastSeen')} <time dateTime={machine.lastSeenAt} title={formatDateTime(machine.lastSeenAt)}>{formatRelative(machine.lastSeenAt)}</time></>
        : t(machine.online ? 'service.onlineAtRead' : 'service.offlineAtRead')}</Text>
    </>} />;
}
