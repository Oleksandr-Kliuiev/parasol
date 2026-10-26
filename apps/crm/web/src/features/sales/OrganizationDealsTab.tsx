import { useState } from 'react';
import { Badge, Button, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, makeStyles, useRestoreFocusTarget } from '@fluentui/react-components';
import { Add20Regular, Target16Regular, Target24Regular } from '@fluentui/react-icons';
import { RecordCell } from '../organizations/RecordCell';
import { useRecordStyles } from '../organizations/recordStyles';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ListFooter } from '../../shared/components/ListFooter';
import { ErrorState } from '../../shared/components/ErrorState';
import { ScrollTable } from '../../shared/components/ScrollTable';
import { Panel } from '../../shared/components/Panel';
import { formatDate, formatMoney } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { QuotesPanel } from '../quotes/QuotesPanel';
import { useOpportunities } from './api';
import { OpportunityDialog } from './OpportunityDialog';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: '16px' },
  person: { fontWeight: 500, fontSize: '13px' },
});

/** Deals of one customer, open ones first (docs/02 §4.2, tab "Deals"). */
export function OrganizationDealsTab({ organizationId, organizationName }: { organizationId: string; organizationName: string }) {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const record = useRecordStyles();
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
        title={t('organizations.tabs.deals')}
        icon={<Target16Regular />}
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
        ) : isPending ? null : data.length === 0 ? (
          <EmptyState icon={<Target24Regular />} message={t('opportunities.emptyForOrganization')} />
        ) : (
          <ScrollTable className={record.flatTable}>
            <Table aria-label={t('opportunities.title')} style={{ minWidth: 860 }}>
              <TableHeader>
                <TableRow>
                  {/* Content widths: every cell adds 12 px of padding on each side; the deal takes the rest. */}
                  <TableHeaderCell>{t('opportunities.fields.name')}</TableHeaderCell>
                  <TableHeaderCell style={{ width: 156 }}>{t('opportunities.fields.stage')}</TableHeaderCell>
                  <TableHeaderCell style={{ width: 106 }}>{t('opportunities.fields.expectedCloseDate')}</TableHeaderCell>
                  {canSeeMoney && <TableHeaderCell className={catalog.number} style={{ width: 126 }}>{t('opportunities.fields.forecast')}</TableHeaderCell>}
                  <TableHeaderCell style={{ width: 156 }}>{t('opportunities.fields.owner')}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((opportunity) => (
                  <TableRow key={opportunity.id}>
                    <TableCell>
                      <RecordCell
                        icon={<Target16Regular />}
                        tone="ember"
                        name={
                          <>
                            <AppLink to={`/sales/opportunities/${opportunity.id}`} className={catalog.name}>
                              {opportunity.name}
                            </AppLink>
                            {opportunity.isStale && (
                              <>
                                {' '}
                                <Badge appearance="tint" color="warning">
                                  {t('opportunities.stale')}
                                </Badge>
                              </>
                            )}
                          </>
                        }
                      />
                    </TableCell>
                    <TableCell>
                      {opportunity.status === 'Open' ? (
                        <>
                          {opportunity.stageName}
                          <div className={catalog.muted}>{opportunity.probability} %</div>
                        </>
                      ) : (
                        <Badge appearance="tint" color={opportunity.status === 'Won' ? 'success' : 'subtle'}>
                          {t(`opportunities.statuses.${opportunity.status}`)}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="tabular">{formatDate(opportunity.expectedCloseDate)}</TableCell>
                    {canSeeMoney && <TableCell className={catalog.number}>{formatMoney(opportunity.forecastAmount ?? 0)}</TableCell>}
                    <TableCell>
                      {opportunity.owner && <RecordCell avatarName={opportunity.owner.name} size={28} name={<span className={styles.person}>{opportunity.owner.name}</span>} />}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollTable>
        )}
        <ListFooter shown={data.length} total={deals.total} hasMore={deals.hasNextPage} loading={deals.isFetchingNextPage} onMore={() => void deals.fetchNextPage()} />
      </Panel>

      <QuotesPanel organizationId={organizationId} organizationName={organizationName} />

      <OpportunityDialog open={creating} onClose={() => setCreating(false)} organization={{ id: organizationId, name: organizationName }} />
    </div>
  );
}
