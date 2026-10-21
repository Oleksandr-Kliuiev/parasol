import { useState } from 'react';
import { Badge, Button, Text, makeStyles, mergeClasses, tokens, useRestoreFocusTarget, type BadgeProps } from '@fluentui/react-components';
import { BuildingMultiple20Regular } from '@fluentui/react-icons';
import { h } from '../../app/hearth';
import { useTranslation } from 'react-i18next';
import { AppLink } from '../../shared/components/AppLink';
import { OrganizationPickerDialog } from '../integrations/OrganizationPickerDialog';
import type { AtlasIdentitySnapshot, IdentityPlan, SelectedCustomer } from './identityImport';

const useStyles = makeStyles({
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '8px' },
  // An Atlas client and its CRM customer as an attention row: icon, names, outcome and the choice on the right.
  row: {
    display: 'grid',
    gridTemplateColumns: '32px minmax(0, 1fr) auto',
    alignItems: 'start',
    columnGap: '12px',
    rowGap: '8px',
    paddingTop: '12px',
    paddingBottom: '12px',
    paddingLeft: '14px',
    paddingRight: '14px',
    borderRadius: '14px',
    backgroundColor: h.well,
    overflowWrap: 'anywhere',
    minWidth: 0,
    '@media (max-width: 560px)': { gridTemplateColumns: '32px minmax(0, 1fr)' },
  },
  icon: { display: 'grid', placeItems: 'center', width: '32px', height: '32px', borderRadius: '10px', backgroundColor: h.irisSoft, color: h.irisT },
  body: { display: 'grid', gap: '2px', minWidth: 0 },
  aside: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px', '@media (max-width: 560px)': { gridColumn: '2', alignItems: 'flex-start' } },
  actions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, justifyContent: 'flex-end',
    '@media (max-width: 560px)': { justifyContent: 'flex-start' } },
  muted: { color: h.muted, fontSize: '12.5px', lineHeight: '18px' },
  customer: { marginTop: '4px', fontSize: '13px' },
  footer: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalM, marginBlock: tokens.spacingVerticalM, color: h.muted },
});
const tones: Record<string, BadgeProps['color']> = { READY: 'informative', ALREADY_LINKED: 'subtle', APPLIED: 'success', ATLAS_ALREADY_LINKED: 'warning',
  CUSTOMER_ALREADY_LINKED: 'warning', CUSTOMER_UNAVAILABLE: 'danger', IDENTITY_INCONSISTENT: 'danger' };
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
          <span className={styles.icon} aria-hidden><BuildingMultiple20Regular /></span>
          <div className={styles.body}>
            <Text weight="semibold">{c.name}</Text>
            <Text className={styles.muted}>{t('parasolIdentity.atlasClient')}: {c.clientId}</Text>
            {customer ? <div className={styles.customer}>
              <Text>{t('parasolIdentity.crmCustomer')}: </Text>
              <AppLink to={`/organizations/${customer.id}`}>{customer.name}</AppLink>
              {/* A short reference tells two customers of the same name apart; the full id is in the tooltip. */}
              <Text block className={styles.muted} title={customer.id}>#{customer.id.slice(0, 8)}</Text>
            </div> : <Text className={mergeClasses(styles.muted, styles.customer)}>{t('parasolIdentity.notSelected')}</Text>}
          </div>
          <div className={styles.aside}>
            {outcome && <Badge appearance="tint" color={outcomes.has(outcome) ? tones[outcome] : 'subtle'}>{t(`parasolIdentity.outcomes.${outcomes.has(outcome) ? outcome : 'UNKNOWN'}`)}</Badge>}
            {!plan && <div className={styles.actions}>
              <Button {...focusTarget} size="small" disabled={locked} onClick={() => setPicking(c)}>{t(customer ? 'parasolIdentity.change' : 'parasolIdentity.choose')}</Button>
              {customer && <Button size="small" disabled={locked} onClick={() => onSelect(c.clientId, null)}>{t('parasolIdentity.clearSelection')}</Button>}
            </div>}
          </div>
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
