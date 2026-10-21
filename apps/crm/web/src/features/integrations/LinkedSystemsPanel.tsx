import { Badge, Button, Skeleton, SkeletonItem, Text, makeStyles } from '@fluentui/react-components';
import { Link16Regular, LinkDismiss24Regular } from '@fluentui/react-icons';
import { h } from '../../app/hearth';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { EmptyState } from '../../shared/components/EmptyState';
import { Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { useCapabilities, useEntityLinks, useIntegrationActions } from './api';
import { systemName, typeName } from './labels';

const useStyles = makeStyles({
  // One line per linked record: system pill, the record and its number, separated by hairlines. The rows share their
  // columns (subgrid), so every record starts at the same edge whichever system pill is the widest.
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)' },
  item: {
    display: 'grid',
    gridColumn: '1 / -1',
    gridTemplateColumns: 'subgrid',
    alignItems: 'center',
    columnGap: '12px',
    rowGap: '2px',
    paddingTop: '10px',
    paddingBottom: '10px',
    borderBottom: `1px solid ${h.line}`,
    ':first-child': { paddingTop: 0 },
    ':last-child': { borderBottom: 'none', paddingBottom: 0 },
  },
  system: { justifySelf: 'start' },
  record: { display: 'grid', minWidth: 0 },
  name: { fontWeight: 600, overflowWrap: 'anywhere' },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '18px', overflowWrap: 'anywhere' },
  key: { fontVariantNumeric: 'tabular-nums' },
  buttons: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '16px', paddingTop: '16px', borderTop: `1px solid ${h.line}` },
});

/** Numbers and short codes as they are; a hash or a GUID by its first characters. */
const shortKey = (key: string) => (key.length > 16 ? `${key.slice(0, 8)}…` : key);

interface LinkedSystemsPanelProps {
  entityId: string;
  entityType?: 'Organization' | 'Product';
  /** Shown when the record has no link yet, e.g. why a product needs a PowerOffice product. */
  emptyHint?: string;
}

/** Which records in PowerOffice, Atera… belong to this organization or product, and creating an organization there when allowed. */
export function LinkedSystemsPanel({ entityId, entityType = 'Organization', emptyHint }: LinkedSystemsPanelProps) {
  const organizationId = entityId;
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const canWrite = useCan(Permissions.customersWrite);
  const links = useEntityLinks(entityType, entityId);
  const capabilities = useCapabilities();
  const actions = useIntegrationActions();

  const linkedSystems = new Set((links.data ?? []).map((l) => l.system));
  const creatable = entityType !== 'Organization' ? [] : (capabilities.data ?? []).filter((c) => c.canCreateOrganization && !linkedSystems.has(c.system));

  const create = async (system: string) => {
    try {
      await actions.exportOrganization.mutateAsync({ system, organizationId });
      notify(t('linkedSystems.queued', { system: systemName(t, system) }), 'info');
    } catch (error) {
      notify(t('errors.generic'), 'error', errorMessage(error, t));
    }
  };

  return (
    <Panel title={t('linkedSystems.title')} icon={<Link16Regular />}>
      {links.isPending && (
        <Skeleton aria-label={t('common.loading')}>
          <SkeletonItem />
          <SkeletonItem />
        </Skeleton>
      )}
      {links.data?.length === 0 && <EmptyState message={emptyHint ?? t('linkedSystems.empty')} icon={<LinkDismiss24Regular />} />}
      <ul className={styles.list}>
        {links.data?.map((l) => (
          <li key={l.id} className={styles.item}>
            <Badge appearance="tint" color="informative" className={styles.system}>
              {systemName(t, l.system)}
            </Badge>
            <span className={styles.record}>
              <Text className={styles.name}>{l.displayName ?? typeName(t, l.externalType)}</Text>
              <Text className={styles.muted}>
                {/* A long key (an Atlas hash, a GUID) is shortened for people; the whole value stays in the tooltip. */}
                <span className={styles.key} title={l.externalId}>#{shortKey(l.externalId)}</span> · {t(`mappings.methods.${l.method}`)}
              </Text>
            </span>
          </li>
        ))}
      </ul>
      {canWrite && creatable.length > 0 && (
        <div className={styles.buttons}>
          {creatable.map((c) => (
            <Button key={c.system} size="small" onClick={() => void create(c.system)} disabled={actions.exportOrganization.isPending}>
              {t('linkedSystems.create', { system: systemName(t, c.system) })}
            </Button>
          ))}
        </div>
      )}
    </Panel>
  );
}
