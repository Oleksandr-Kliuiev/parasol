import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  Button,
  Dropdown,
  Field,
  Option,
  SearchBox,
  Skeleton,
  SkeletonItem,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@fluentui/react-components';
import { Add20Regular, ShieldTask20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { formatDate } from '../../shared/utils/format';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import { NARROW_SCREEN, useMediaQuery } from '../../shared/utils/useMediaQuery';
import { useCatalogStyles } from '../catalog/styles';
import { useContracts } from './api';
import { ContractStatusBadge } from './ContractBadges';
import { contractStatuses, type ContractListItem, type ContractStatus } from './types';

export function ContractsPage() {
  const styles = useCatalogStyles();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canWrite = useCan(Permissions.contractsWrite);
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search.trim());
  const status = (params.get('status') as ContractStatus | null) ?? null;
  const ending = params.get('ending') === '60';
  const contracts = useContracts({ search: debounced, status, endingWithinDays: ending ? 60 : null });
  const rows = contracts.data?.pages.flatMap((p) => p.items) ?? [];
  const filterValue = ending ? 'ending' : (status ?? '');

  return (
    <>
      <PageHeader
        title={t('contracts.title')}
        subtitle={t('contracts.subtitle')}
        actions={
          <>
            <Button icon={<ShieldTask20Regular />} appearance="subtle" onClick={() => navigate('/contracts/sla-policies')}>
              {t('contracts.sla.title')}
            </Button>
            {canWrite && (
              <Button appearance="subtle" onClick={() => navigate('/contracts/indexation')}>
                {t('contracts.indexation.title')}
              </Button>
            )}
            {canWrite && (
              <Button appearance="primary" icon={<Add20Regular />} onClick={() => navigate('/contracts/new')}>
                {t('contracts.new')}
              </Button>
            )}
          </>
        }
      />
      <div className={styles.filters}>
        <SearchBox id="contracts-search" className={styles.search} value={search} onChange={(_, d) => setSearch(d.value)} placeholder={t('contracts.search')} aria-label={t('contracts.search')} />
        <Field label={t('contracts.fields.status')}>
          <Dropdown
            value={ending ? t('contracts.endingSoon') : status ? t(`contracts.statuses.${status}`) : t('common.all')}
            selectedOptions={[filterValue]}
            onOptionSelect={(_, d) => {
              const next = new URLSearchParams(params);
              next.delete('status');
              next.delete('ending');
              if (d.optionValue === 'ending') next.set('ending', '60');
              else if (d.optionValue) next.set('status', d.optionValue);
              setParams(next, { replace: true });
            }}
          >
            <Option value="">{t('common.all')}</Option>
            <Option value="ending">{t('contracts.endingSoon')}</Option>
            {contractStatuses.map((s) => (
              <Option key={s} value={s}>
                {t(`contracts.statuses.${s}`)}
              </Option>
            ))}
          </Dropdown>
        </Field>
      </div>
      {contracts.error ? (
        <ErrorState error={contracts.error} onRetry={() => void contracts.refetch()} />
      ) : (
        <ContractList rows={rows} loading={contracts.isPending} empty={debounced || filterValue ? t('contracts.empty') : t('contracts.emptyAll')} showOrganization />
      )}
      {contracts.hasNextPage && (
        <div className={styles.more}>
          <Button onClick={() => void contracts.fetchNextPage()} disabled={contracts.isFetchingNextPage}>
            {t('common.loadMore')}
          </Button>
        </div>
      )}
    </>
  );
}

export function ContractList({ rows, loading, empty, showOrganization }: { rows: ContractListItem[]; loading: boolean; empty: string; showOrganization: boolean }) {
  const styles = useCatalogStyles();
  const { t } = useTranslation();
  const narrow = useMediaQuery(NARROW_SCREEN);

  const period = (c: ContractListItem) => `${formatDate(c.startDate)} – ${c.endDate ? formatDate(c.endDate) : t('contracts.untilFurtherNotice')}`;

  if (narrow) {
    return (
      <>
        <ul className={styles.cards} aria-label={t('contracts.title')}>
          {rows.map((c) => (
            <li key={c.id} className={styles.card}>
              <AppLink to={`/contracts/${c.id}`} className={styles.name}>
                {c.number} · {c.title}
              </AppLink>
              <span className={styles.cardMeta}>
                <ContractStatusBadge status={c.status} />
                {showOrganization && <span>{c.organization.name}</span>}
                <span className="tabular">{period(c)}</span>
              </span>
            </li>
          ))}
        </ul>
        {loading && <Skeleton aria-label={t('common.loading')}><SkeletonItem size={48} /></Skeleton>}
        {!loading && rows.length === 0 && <EmptyState message={empty} />}
      </>
    );
  }

  return (
    <div className={styles.tableWrap}>
      <Table className={styles.table} aria-label={t('contracts.title')}>
        <TableHeader>
          <TableRow>
            <TableHeaderCell>{t('contracts.fields.contract')}</TableHeaderCell>
            {showOrganization && <TableHeaderCell>{t('contracts.fields.organization')}</TableHeaderCell>}
            <TableHeaderCell>{t('contracts.fields.status')}</TableHeaderCell>
            <TableHeaderCell>{t('contracts.fields.period')}</TableHeaderCell>
            <TableHeaderCell>{t('contracts.fields.sla')}</TableHeaderCell>
            <TableHeaderCell>{t('contracts.fields.owner')}</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((c) => (
            <TableRow key={c.id}>
              <TableCell>
                <AppLink to={`/contracts/${c.id}`} className={styles.name}>
                  {c.title}
                </AppLink>
                <div className={styles.sku}>
                  {c.number} · {t(`contracts.types.${c.type}`)}
                </div>
              </TableCell>
              {showOrganization && (
                <TableCell>
                  <AppLink to={`/organizations/${c.organization.id}`}>{c.organization.name}</AppLink>
                </TableCell>
              )}
              <TableCell>
                <ContractStatusBadge status={c.status} />
              </TableCell>
              <TableCell className="tabular">
                {period(c)}
                {c.autoRenew && <div className={styles.muted}>{t('contracts.autoRenews')}</div>}
              </TableCell>
              <TableCell>{c.slaName}</TableCell>
              <TableCell>{c.owner?.name}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {loading && <Skeleton aria-label={t('common.loading')}><SkeletonItem size={48} /></Skeleton>}
      {!loading && rows.length === 0 && <EmptyState message={empty} />}
    </div>
  );
}
