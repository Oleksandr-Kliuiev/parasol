import { useState } from 'react';
import { Badge, Button, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, makeStyles, tokens, useRestoreFocusTarget } from '@fluentui/react-components';
import { Add20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ListFooter } from '../../shared/components/ListFooter';
import { ErrorState } from '../../shared/components/ErrorState';
import { Panel } from '../../shared/components/Panel';
import { formatDate, formatMoney } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { QuotesPanel } from '../quotes/QuotesPanel';
import { useOpportunities } from './api';
import { OpportunityDialog } from './OpportunityDialog';

const useStyles = makeStyles({ stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL } });

/** Deals of one customer, open ones first (docs/02 §4.2, tab "Deals"). */
export function OrganizationDealsTab({ organizationId, organizationName }: { organizationId: string; organizationName: string }) {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const canWrite = useCan(Permissions.salesWrite);
  const canSeeMoney = useCan(Permissions.financeRead);
  const deals = useOpportunities({ organizationId });
  const { items: data, error, isPending, refetch } = deals;
  const [creating, setCreating] = useState(false);
  const restoreFocusTarget = useRestoreFocusTarget();

  return (
    <div className={styles.stack}>
      <Panel
        title={t('opportunities.title')}
        actions={
          canWrite && (
            <Button {...restoreFocusTarget} size="small" icon={<Add20Regular />} onClick={() => setCreating(true)}>
              {t('opportunities.new')}
            </Button>
          )
        }
      >
        {error ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <Table aria-label={t('opportunities.title')} style={{ minWidth: 560 }}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{t('opportunities.fields.name')}</TableHeaderCell>
                  <TableHeaderCell>{t('opportunities.fields.stage')}</TableHeaderCell>
                  <TableHeaderCell>{t('opportunities.fields.expectedCloseDate')}</TableHeaderCell>
                  {canSeeMoney && <TableHeaderCell className={catalog.number}>{t('opportunities.fields.forecast')}</TableHeaderCell>}
                  <TableHeaderCell>{t('opportunities.fields.owner')}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((opportunity) => (
                  <TableRow key={opportunity.id}>
                    <TableCell>
                      <AppLink to={`/sales/opportunities/${opportunity.id}`} className={catalog.name}>
                        {opportunity.name}
                      </AppLink>
                      {opportunity.isStale && (
                        <div>
                          <Badge appearance="tint" color="warning">
                            {t('opportunities.stale')}
                          </Badge>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {opportunity.status === 'Open' ? `${opportunity.stageName} · ${opportunity.probability} %` : t(`opportunities.statuses.${opportunity.status}`)}
                    </TableCell>
                    <TableCell className="tabular">{formatDate(opportunity.expectedCloseDate)}</TableCell>
                    {canSeeMoney && <TableCell className={catalog.number}>{formatMoney(opportunity.forecastAmount ?? 0)}</TableCell>}
                    <TableCell>{opportunity.owner?.name}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {!isPending && data.length === 0 && <EmptyState message={t('opportunities.emptyForOrganization')} />}
        <ListFooter shown={data.length} total={deals.total} hasMore={deals.hasNextPage} loading={deals.isFetchingNextPage} onMore={() => void deals.fetchNextPage()} />
      </Panel>

      <QuotesPanel organizationId={organizationId} organizationName={organizationName} />

      <OpportunityDialog open={creating} onClose={() => setCreating(false)} organization={{ id: organizationId, name: organizationName }} />
    </div>
  );
}
