import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Button,
  Checkbox,
  Dropdown,
  Field,
  Input,
  Option,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Add20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { formatDate, formatMoney } from '../../shared/utils/format';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import { useMediaQuery } from '../../shared/utils/useMediaQuery';
import { useCatalogStyles } from '../catalog/styles';
import { useQuotes } from './api';
import { QuoteStatusBadge } from './shared';
import { quoteStatuses, type QuoteStatus } from './types';

const useStyles = makeStyles({
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  discount: { color: tokens.colorPaletteDarkOrangeForeground1 },
});

/** Every quote, newest number first; the approval queue is one checkbox away (FR-SAL-03..05). */
export function QuotesPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canWrite = useCan(Permissions.salesWrite);
  const canSeeMoney = useCan(Permissions.financeRead);
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
  const { data = [], error, isPending, refetch } = useQuotes(filters);

  return (
    <>
      <PageHeader
        title={t('quotes.title')}
        subtitle={t('quotes.subtitle')}
        actions={
          canWrite && (
            <Button appearance="primary" icon={<Add20Regular />} onClick={() => navigate('/quotes/new')}>
              {t('quotes.new')}
            </Button>
          )
        }
      />

      <div className={catalog.filters}>
        <Field label={t('quotes.search')}>
          <Input className={catalog.search} value={search} onChange={(_, d) => setSearch(d.value)} />
        </Field>
        <Field label={t('common.status')}>
          <Dropdown
            selectedOptions={[status]}
            value={status === '' ? t('common.all') : t(`quotes.status.${status}`)}
            onOptionSelect={(_, d) => setStatus((d.optionValue ?? '') as QuoteStatus | '')}
          >
            <Option value="">{t('common.all')}</Option>
            {quoteStatuses.map((value) => (
              <Option key={value} value={value}>
                {t(`quotes.status.${value}`)}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Checkbox label={t('quotes.mine')} checked={mine} onChange={(_, d) => setMine(Boolean(d.checked))} />
        <Checkbox
          label={t('quotes.awaitingApproval')}
          checked={awaitingApproval}
          onChange={(_, d) => setAwaitingApproval(Boolean(d.checked))}
        />
      </div>

      {isPending ? (
        <Spinner label={t('common.loading')} />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data.length === 0 ? (
        <EmptyState message={t('quotes.empty')} />
      ) : isPhone ? (
        <ul className={catalog.cards}>
          {data.map((quote) => (
            <li key={quote.id} className={catalog.card}>
              <AppLink to={`/quotes/${quote.id}`} className={catalog.name}>
                {quote.number}
                {quote.versionNo > 1 ? ` · v${quote.versionNo}` : ''} — {quote.title}
              </AppLink>
              <span className={catalog.cardMeta}>
                <QuoteStatusBadge status={quote.status} />
                <span>{quote.organization.name}</span>
                {canSeeMoney && <span>{formatMoney(quote.contractValue)}</span>}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className={catalog.tableWrap}>
          <Table className={catalog.table} aria-label={t('quotes.title')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('quotes.fields.number')}</TableHeaderCell>
                <TableHeaderCell>{t('quotes.fields.organization')}</TableHeaderCell>
                <TableHeaderCell>{t('common.status')}</TableHeaderCell>
                <TableHeaderCell>{t('quotes.fields.validUntil')}</TableHeaderCell>
                {canSeeMoney && <TableHeaderCell className={catalog.number}>{t('quotes.fields.perMonth')}</TableHeaderCell>}
                {canSeeMoney && <TableHeaderCell className={catalog.number}>{t('quotes.fields.contractValue')}</TableHeaderCell>}
                <TableHeaderCell>{t('quotes.fields.owner')}</TableHeaderCell>
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
                    <AppLink to={`/organizations/${quote.organization.id}`}>{quote.organization.name}</AppLink>
                  </TableCell>
                  <TableCell>
                    <QuoteStatusBadge status={quote.status} />
                    {quote.maxDiscountPct > 0 && (
                      <div className={styles.muted}>{t('quotes.discountOf', { pct: quote.maxDiscountPct })}</div>
                    )}
                  </TableCell>
                  <TableCell>
                    {formatDate(quote.validUntil)}
                    {!quote.isLatestVersion && <div className={styles.muted}>{t('quotes.olderVersion')}</div>}
                  </TableCell>
                  {canSeeMoney && <TableCell className={catalog.number}>{formatMoney(quote.monthlyExVat)}</TableCell>}
                  {canSeeMoney && <TableCell className={catalog.number}>{formatMoney(quote.contractValue)}</TableCell>}
                  <TableCell>
                    <Text>{quote.owner?.name ?? '—'}</Text>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
