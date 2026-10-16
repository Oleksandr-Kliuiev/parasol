import { useState } from 'react';
import { Button, Text, makeStyles, tokens, useRestoreFocusTarget } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { AppLink } from '../../shared/components/AppLink';
import { OrganizationPickerDialog } from '../integrations/OrganizationPickerDialog';
import type { AtlasIdentitySnapshot, IdentityPlan, SelectedCustomer } from './identityImport';

const useStyles = makeStyles({
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: tokens.spacingVerticalM },
  row: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalM,
    display: 'grid', gap: tokens.spacingVerticalS, backgroundColor: tokens.colorNeutralBackground1, overflowWrap: 'anywhere' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  muted: { color: tokens.colorNeutralForeground3 },
  footer: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalM, marginBlock: tokens.spacingVerticalM },
});
const outcomes = new Set(['READY', 'ALREADY_LINKED', 'APPLIED', 'ATLAS_ALREADY_LINKED', 'CUSTOMER_ALREADY_LINKED', 'CUSTOMER_UNAVAILABLE', 'IDENTITY_INCONSISTENT']);

export function IdentityMappingRows({ snapshot, selected, plan, locked, onSelect }: {
  snapshot: AtlasIdentitySnapshot; selected: ReadonlyMap<string, SelectedCustomer>; plan: IdentityPlan | null; locked: boolean;
  onSelect: (clientId: string, customer: SelectedCustomer | null) => void;
}) {
  const { t } = useTranslation();
  const styles = useStyles();
  const focusTarget = useRestoreFocusTarget();
  const [picking, setPicking] = useState<AtlasIdentitySnapshot['clients'][number] | null>(null);
  const [limit, setLimit] = useState(50);
  const clients = plan ? snapshot.clients.filter(c => plan.rows.some(r => r.atlasClientId === c.clientId)) : snapshot.clients;
  return <>
    <ul className={styles.list} aria-label={t('parasolIdentity.rows')}>
      {clients.slice(0, limit).map(c => {
        const customer = selected.get(c.clientId);
        const outcome = plan?.rows.find(r => r.atlasClientId === c.clientId)?.outcome;
        return <li key={c.clientId} className={styles.row}>
          <Text weight="semibold">{c.name}</Text>
          <Text className={styles.muted}>{t('parasolIdentity.atlasClient')}: {c.clientId}</Text>
          {customer ? <div>
            <Text>{t('parasolIdentity.crmCustomer')}: </Text>
            <AppLink to={`/organizations/${customer.id}`}>{customer.name}</AppLink>
            <Text block className={styles.muted}>{customer.id}</Text>
          </div> : <Text>{t('parasolIdentity.notSelected')}</Text>}
          {outcome && <Text weight="semibold">{t(`parasolIdentity.outcomes.${outcomes.has(outcome) ? outcome : 'UNKNOWN'}`)}</Text>}
          {!plan && <div className={styles.actions}>
            <Button {...focusTarget} disabled={locked} onClick={() => setPicking(c)}>{t(customer ? 'parasolIdentity.change' : 'parasolIdentity.choose')}</Button>
            {customer && <Button disabled={locked} onClick={() => onSelect(c.clientId, null)}>{t('parasolIdentity.clearSelection')}</Button>}
          </div>}
        </li>;
      })}
    </ul>
    {clients.length > 0 && <div className={styles.footer}>
      <Text>{t('parasolIdentity.visibleRows', { shown: Math.min(limit, clients.length), total: clients.length })}</Text>
      {clients.length > limit && <Button onClick={() => setLimit(n => n + 50)}>{t('common.loadMore')}</Button>}
    </div>}
    <OrganizationPickerDialog open={picking !== null} initialSearch={picking?.name ?? ''} onClose={() => setPicking(null)} onPick={customer => {
      if (picking && !locked) onSelect(picking.clientId, customer);
      setPicking(null);
    }} />
  </>;
}
