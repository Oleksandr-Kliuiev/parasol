import { Button, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, makeStyles, tokens } from '@fluentui/react-components';
import { Add20Regular } from '@fluentui/react-icons';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ListFooter } from '../../shared/components/ListFooter';
import { ErrorState } from '../../shared/components/ErrorState';
import { Panel } from '../../shared/components/Panel';
import { formatDate, formatMoney } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { useQuotes } from './api';
import { QuoteStatusBadge } from './shared';

const useStyles = makeStyles({ muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 } });

/** Quotes of one customer or one deal, newest first (FR-SAL-03). */
export function QuotesPanel({
  organizationId,
  organizationName,
  opportunityId,
}: {
  organizationId: string;
  organizationName: string;
  opportunityId?: string;
}) {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canWrite = useCan(Permissions.salesWrite);
  const canSeeMoney = useCan(Permissions.financeRead);
  const quotes = useQuotes(opportunityId ? { opportunityId } : { organizationId });
  const { items: data, error, isPending, refetch } = quotes;

  const create = () => {
    const params = new URLSearchParams({ organizationId, organizationName });
    if (opportunityId) params.set('opportunityId', opportunityId);
    navigate(`/quotes/new?${params.toString()}`);
  };

  return (
    <Panel
      title={t('quotes.title')}
      actions={
        canWrite && (
          <Button size="small" icon={<Add20Regular />} onClick={create}>
            {t('quotes.new')}
          </Button>
        )
      }
    >
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isPending ? null : data.length === 0 ? (
        <EmptyState message={t('quotes.emptyHere')} />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <Table aria-label={t('quotes.title')} style={{ minWidth: 520 }}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('quotes.fields.number')}</TableHeaderCell>
                <TableHeaderCell>{t('common.status')}</TableHeaderCell>
                <TableHeaderCell>{t('quotes.fields.validUntil')}</TableHeaderCell>
                {canSeeMoney && <TableHeaderCell className={catalog.number}>{t('quotes.fields.contractValue')}</TableHeaderCell>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((quote) => (
                <TableRow key={quote.id}>
                  <TableCell>
                    <AppLink to={`/quotes/${quote.id}`} className={catalog.name}>
                      {quote.number}
                      {quote.versionNo > 1 ? ` · v${quote.versionNo}` : ''}
                    </AppLink>
                    <div className={styles.muted}>{quote.title}</div>
                  </TableCell>
                  <TableCell>
                    <QuoteStatusBadge status={quote.status} />
                  </TableCell>
                  <TableCell>{formatDate(quote.validUntil)}</TableCell>
                  {canSeeMoney && <TableCell className={catalog.number}>{formatMoney(quote.contractValue)}</TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <ListFooter shown={data.length} total={quotes.total} hasMore={quotes.hasNextPage} loading={quotes.isFetchingNextPage} onMore={() => void quotes.fetchNextPage()} />
        </div>
      )}
    </Panel>
  );
}
