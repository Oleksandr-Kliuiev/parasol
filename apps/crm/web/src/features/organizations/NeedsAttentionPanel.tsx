import { useState } from 'react';
import { Button, Text, makeStyles } from '@fluentui/react-components';
import { AlertUrgent16Regular, CheckmarkCircle24Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { Panel } from '../../shared/components/Panel';
import { attentionPhrases } from './customerFactsText';
import { useCustomerAttention } from './useCustomerFacts';

const useStyles = makeStyles({
  // The list follows the card directly: the same 16 px the toolbar leaves above it.
  panel: { marginBottom: '16px' },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '2px' },
  row: {
    display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'baseline', gap: '2px 12px',
    paddingTop: '8px', paddingBottom: '8px', borderBottom: `1px solid ${h.line}`, ':last-child': { borderBottom: 'none' },
    '@media (max-width: 560px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  name: { fontWeight: 700, display: 'inline-flex', alignItems: 'center', minHeight: '24px' },
  why: { color: h.emberT, fontSize: '13px', lineHeight: '18px', fontWeight: 600 },
  who: { color: h.muted, fontSize: '12.5px', lineHeight: '18px' },
  foot: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 16px', paddingTop: '8px' },
});

const FIRST = 5;

/**
 * "Whom to attend to" above the customer list (UX 2026, В6): customers with something overdue, an agreement ending within
 * 60 days or an hour bank running low, the most urgent first, each with why. It reads once per scope (everyone or the
 * person's own customers); more than 50 are said as "50 of N", never cut silently.
 */
export function NeedsAttentionPanel({ mine }: { mine: boolean }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const attention = useCustomerAttention(mine);
  const [all, setAll] = useState(false);
  const data = attention.data;
  return (
    <Panel title={data ? t('customerFacts.attentionTitle', { count: data.total }) : t('customerFacts.attentionTitleBare')} icon={<AlertUrgent16Regular />} className={styles.panel}>
      {attention.isPending ? <Text className={styles.who}>{t('common.loading')}</Text>
        : attention.isError || data == null ? <Text className={styles.who}>{t('customerFacts.attentionUnread')}</Text>
        : data.items.length === 0 ? <EmptyState compact icon={<CheckmarkCircle24Regular />} message={t(mine ? 'customerFacts.attentionNoneMine' : 'customerFacts.attentionNone')} />
        : <>
          <ul className={styles.list}>
            {(all ? data.items : data.items.slice(0, FIRST)).map(({ organization, facts }) => (
              <li key={organization.id} className={styles.row}>
                <span>
                  <AppLink className={styles.name} to={`/organizations/${organization.id}`}>{organization.name}</AppLink>
                  {organization.accountManager && !mine && <Text block className={styles.who}>{organization.accountManager.displayName}</Text>}
                </span>
                <Text className={styles.why}>{attentionPhrases(facts, data.asOf, t).join(' · ')}</Text>
              </li>
            ))}
          </ul>
          <div className={styles.foot}>
            {data.items.length > FIRST && <Button size="small" appearance="subtle" onClick={() => setAll((open) => !open)}>
              {all ? t('customerFacts.showFewer') : t('customerFacts.showAll', { count: data.items.length })}</Button>}
            {data.total > data.items.length && <Text className={styles.who}>{t('customerFacts.firstOf', { shown: data.items.length, total: data.total })}</Text>}
          </div>
        </>}
    </Panel>
  );
}
