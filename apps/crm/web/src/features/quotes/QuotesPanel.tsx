import { Button, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@fluentui/react-components';
import { Add20Regular, DocumentBulletList16Regular, DocumentBulletList24Regular } from '@fluentui/react-icons';
import { RecordCell } from '../organizations/RecordCell';
import { useRecordStyles } from '../organizations/recordStyles';
import { useNavigate } from 'react-router';
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
import { useQuotes } from './api';
import { QuoteStatusBadge } from './shared';

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
  const catalog = useCatalogStyles();
  const record = useRecordStyles();
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
      icon={<DocumentBulletList16Regular />}
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
        <EmptyState icon={<DocumentBulletList24Regular />} message={t('quotes.emptyHere')} />
      ) : (
        <ScrollTable className={record.flatTable}>
          <Table aria-label={t('quotes.title')} style={{ minWidth: 680 }}>
            <TableHeader>
              <TableRow>
                {/* Content widths: every cell adds 12 px of padding on each side; the quote takes the rest. */}
                <TableHeaderCell>{t('quotes.fields.number')}</TableHeaderCell>
                <TableHeaderCell style={{ width: 136 }}>{t('common.status')}</TableHeaderCell>
                <TableHeaderCell style={{ width: 106 }}>{t('quotes.fields.validUntil')}</TableHeaderCell>
                {canSeeMoney && <TableHeaderCell className={catalog.number} style={{ width: 146 }}>{t('quotes.fields.contractValue')}</TableHeaderCell>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((quote) => (
                <TableRow key={quote.id}>
                  <TableCell>
                    <RecordCell
                      icon={<DocumentBulletList16Regular />}
                      tone="saffron"
                      name={
                        <AppLink to={`/quotes/${quote.id}`} className={catalog.name}>
                          {quote.number}
                          {quote.versionNo > 1 ? ` · v${quote.versionNo}` : ''}
                        </AppLink>
                      }
                      meta={[quote.title]}
                    />
                  </TableCell>
                  <TableCell>
                    <QuoteStatusBadge status={quote.status} />
                  </TableCell>
                  <TableCell className="tabular">{formatDate(quote.validUntil)}</TableCell>
                  {canSeeMoney && <TableCell className={catalog.number}>{formatMoney(quote.contractValue)}</TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <ListFooter shown={data.length} total={quotes.total} hasMore={quotes.hasNextPage} loading={quotes.isFetchingNextPage} onMore={() => void quotes.fetchNextPage()} />
        </ScrollTable>
      )}
    </Panel>
  );
}
