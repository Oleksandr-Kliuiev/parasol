import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Button,
  Dropdown,
  Option,
  SearchBox,
  Skeleton,
  SkeletonItem,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
} from '@fluentui/react-components';
import { Add20Regular, DocumentBulletList16Regular, DocumentBulletList24Regular } from '@fluentui/react-icons';
import { h } from '../../app/hearth';
import { RecordCell } from '../organizations/RecordCell';
import { useRecordStyles } from '../organizations/recordStyles';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan, useCurrentUser } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ListFooter } from '../../shared/components/ListFooter';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { FilterField, Toolbar } from '../../shared/components/Toolbar';
import { formatDate, formatMoney } from '../../shared/utils/format';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import { useMediaQuery } from '../../shared/utils/useMediaQuery';
import { useCatalogStyles } from '../catalog/styles';
import { useQuotes } from './api';
import { QuoteStatusBadge } from './shared';
import { quoteStatuses, type QuoteStatus } from './types';
import { ScrollTable } from '../../shared/components/ScrollTable';

const useStyles = makeStyles({
  muted: { color: h.muted, fontSize: '12px' },
  status: { minWidth: '190px' },
});

/** Every quote, newest number first; the approval queue is one switch away (FR-SAL-03..05). */
export function QuotesPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const record = useRecordStyles();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canWrite = useCan(Permissions.salesWrite);
  const canSeeMoney = useCan(Permissions.financeRead);
  // DEV-09: a user limited to their own quotes is told so, and "only mine" is what they always get.
  const allQuotes = useCurrentUser().recordScope.allQuotes;
  const isPhone = useMediaQuery('(max-width: 700px)');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<QuoteStatus | ''>('');
  const [mine, setMine] = useState(false);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const filters = {
    search: useDebouncedValue(search),
    status: status === '' ? null : status,
    mine: mine || undefined,
    awaitingApproval: awaitingApproval || undefined,
  };
  const quotes = useQuotes(filters);
  const { items: data, error, isPending, refetch } = quotes;
  const empty = !isPending && data.length === 0 && (
    <EmptyState icon={<DocumentBulletList24Regular />} message={t('quotes.empty')} />
  );
  const footer = <ListFooter shown={data.length} total={quotes.total} hasMore={quotes.hasNextPage} loading={quotes.isFetchingNextPage} onMore={() => void quotes.fetchNextPage()} />;
  const loading = isPending && <Skeleton aria-label={t('common.loading')}><SkeletonItem size={48} /></Skeleton>;

  return (
    <>
      <PageHeader
        title={t('quotes.title')}
        subtitle={allQuotes ? t('quotes.subtitle') : t('quotes.scopeOwn')}
        actions={
          canWrite && (
            <Button appearance="primary" icon={<Add20Regular />} onClick={() => navigate('/quotes/new')}>
              {t('quotes.new')}
            </Button>
          )
        }
      />

      <Toolbar label={t('quotes.filterLabel')}>
        <FilterField kind="search" label={t('quotes.search')}>
          <SearchBox id="quotes-search" value={search} onChange={(_, d) => setSearch(d.value)} placeholder={t('quotes.searchPlaceholder')} />
        </FilterField>
        <FilterField label={t('common.status')}>
          <Dropdown
            className={styles.status}
            selectedOptions={[status]}
            value={status === '' ? t('quotes.allStatuses') : t(`quotes.status.${status}`)}
            onOptionSelect={(_, d) => setStatus((d.optionValue ?? '') as QuoteStatus | '')}
          >
            <Option value="">{t('quotes.allStatuses')}</Option>
            {quoteStatuses.map((value) => (
              <Option key={value} value={value}>
                {t(`quotes.status.${value}`)}
              </Option>
            ))}
          </Dropdown>
        </FilterField>
        {allQuotes && <Switch className={catalog.toggle} label={t('quotes.mine')} checked={mine} onChange={(_, d) => setMine(d.checked)} />}
        <Switch className={catalog.toggle} label={t('quotes.awaitingApproval')} checked={awaitingApproval} onChange={(_, d) => setAwaitingApproval(d.checked)} />
      </Toolbar>

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isPhone ? (
        <>
          {data.length > 0 && (
            <ul className={record.cards} aria-label={t('quotes.title')}>
              {data.map((quote) => (
                <li key={quote.id} className={record.card}>
                  <span className={record.cardMain}>
                    <RecordCell
                      icon={<DocumentBulletList16Regular />}
                      tone="saffron"
                      size={36}
                      name={
                        <AppLink to={`/quotes/${quote.id}`} className={catalog.name}>
                          {quote.number}
                          {quote.versionNo > 1 ? ` · v${quote.versionNo}` : ''} — {quote.title}
                        </AppLink>
                      }
                      meta={[quote.organization.name, canSeeMoney && formatMoney(quote.contractValue)]}
                    />
                  </span>
                  <span className={record.cardEnd}>
                    <QuoteStatusBadge status={quote.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          {loading}
          {empty && <div className={catalog.emptyCard}>{empty}</div>}
          {footer}
        </>
      ) : (
        <ScrollTable className={catalog.tableWrap}>
          <Table className={catalog.table} style={{ minWidth: 1060 }} aria-label={t('quotes.title')}>
            <TableHeader>
              <TableRow>
                {/* Content widths: every cell adds 12 px of padding on each side; number and customer share the rest. */}
                <TableHeaderCell>{t('quotes.fields.number')}</TableHeaderCell>
                <TableHeaderCell>{t('quotes.fields.organization')}</TableHeaderCell>
                <TableHeaderCell style={{ width: 136 }}>{t('common.status')}</TableHeaderCell>
                <TableHeaderCell style={{ width: 86 }}>{t('quotes.fields.validUntil')}</TableHeaderCell>
                {canSeeMoney && <TableHeaderCell className={catalog.number} style={{ width: 106 }}>{t('quotes.fields.perMonth')}</TableHeaderCell>}
                {canSeeMoney && <TableHeaderCell className={catalog.number} style={{ width: 116 }}>{t('quotes.fields.contractValue')}</TableHeaderCell>}
                <TableHeaderCell style={{ width: 136 }}>{t('quotes.fields.owner')}</TableHeaderCell>
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
                    <RecordCell
                      avatarName={quote.organization.name}
                      size={28}
                      name={<AppLink to={`/organizations/${quote.organization.id}`} className={record.quietLink}>{quote.organization.name}</AppLink>}
                    />
                  </TableCell>
                  <TableCell>
                    <QuoteStatusBadge status={quote.status} />
                    {quote.maxDiscountPct > 0 && <div className={styles.muted}>{t('quotes.discountOf', { pct: quote.maxDiscountPct })}</div>}
                  </TableCell>
                  <TableCell className="tabular">
                    {formatDate(quote.validUntil)}
                    {!quote.isLatestVersion && <div className={styles.muted}>{t('quotes.olderVersion')}</div>}
                  </TableCell>
                  {canSeeMoney && <TableCell className={catalog.number}>{formatMoney(quote.monthlyExVat)}</TableCell>}
                  {canSeeMoney && <TableCell className={catalog.number}>{formatMoney(quote.contractValue)}</TableCell>}
                  <TableCell>
                    {quote.owner ? (
                      <RecordCell avatarName={quote.owner.name} size={28} name={<span className={record.person}>{quote.owner.name}</span>} />
                    ) : (
                      <Text className={styles.muted}>—</Text>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {loading}
          {empty}
          {footer}
        </ScrollTable>
      )}
    </>
  );
}
