import { Badge, Button, Text, makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { useCapabilities, useEntityLinks, useIntegrationActions } from './api';
import { systemName, typeName } from './labels';

const useStyles = makeStyles({
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  item: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: tokens.spacingHorizontalS },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  buttons: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalM },
});

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
    <Panel title={t('linkedSystems.title')}>
      {links.data?.length === 0 && <Text className={styles.muted}>{emptyHint ?? t('linkedSystems.empty')}</Text>}
      <ul className={styles.list}>
        {links.data?.map((l) => (
          <li key={l.id} className={styles.item}>
            <Badge appearance="tint" color="brand">
              {systemName(t, l.system)}
            </Badge>
            <Text>{l.displayName ?? typeName(t, l.externalType)}</Text>
            <Text className={styles.muted}>
              #{l.externalId} · {t(`mappings.methods.${l.method}`)}
            </Text>
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
