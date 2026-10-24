import { useState, type ReactElement, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  Button,
  SearchBox,
  Skeleton,
  SkeletonItem,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  mergeClasses,
} from '@fluentui/react-components';
import { Add20Regular, ArrowTrending20Regular, DocumentText16Regular, DocumentText24Regular, ShieldTask20Regular } from '@fluentui/react-icons';
import { RecordCell } from '../organizations/RecordCell';
import { useRecordStyles } from '../organizations/recordStyles';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { ListFooter } from '../../shared/components/ListFooter';
import { PageHeader } from '../../shared/components/PageHeader';
import { FilterChips, FilterField, Toolbar } from '../../shared/components/Toolbar';
import { formatDate } from '../../shared/utils/format';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import { NARROW_SCREEN, useMediaQuery } from '../../shared/utils/useMediaQuery';
import { badgeDot, useCatalogStyles } from '../catalog/styles';
import { useContracts } from './api';
import { ContractStatusBadge } from './ContractBadges';
import { contractStatusColor, contractStatuses, type ContractListItem, type ContractStatus } from './types';
import { SavedViews } from '../../shared/views/SavedViews';
import { ScrollTable } from '../../shared/components/ScrollTable';

type StatusFilter = '' | 'ending' | ContractStatus;

export function ContractsPage() {
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
  const filterValue: StatusFilter = ending ? 'ending' : (status ?? '');
  const filtered = Boolean(debounced || filterValue);

  const setFilter = (value: StatusFilter) => {
    const next = new URLSearchParams(params);
    next.delete('status');
    next.delete('ending');
    if (value === 'ending') next.set('ending', '60');
    else if (value) next.set('status', value);
    setParams(next, { replace: true });
  };

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
              <Button icon={<ArrowTrending20Regular />} appearance="subtle" onClick={() => navigate('/contracts/indexation')}>
                {t('contracts.indexation.title')}
              </Button>
            )}
            <SavedViews scope="contracts" keys={['status', 'ending']} />
            {canWrite && (
              <Button appearance="primary" icon={<Add20Regular />} onClick={() => navigate('/contracts/new')}>
                {t('contracts.new')}
              </Button>
            )}
          </>
        }
      />
      <Toolbar label={t('contracts.filterLabel')}>
        <FilterField kind="search" label={t('contracts.search')}>
          <SearchBox id="contracts-search" value={search} onChange={(_, d) => setSearch(d.value)} placeholder={t('contracts.search')} />
        </FilterField>
        <FilterChips<StatusFilter>
          label={t('contracts.fields.status')}
          value={filterValue}
          onChange={setFilter}
          options={[
            { value: '', label: t('common.all') },
            { value: 'ending', label: t('contracts.endingSoon'), dot: h.ember },
            ...contractStatuses.map((s) => ({ value: s, label: t(`contracts.statuses.${s}`), dot: badgeDot[contractStatusColor[s]] })),
          ]}
        />
      </Toolbar>
      {contracts.error ? (
        <ErrorState error={contracts.error} onRetry={() => void contracts.refetch()} />
      ) : (
        <ContractList
          rows={rows}
          loading={contracts.isPending}
          empty={filtered ? t('contracts.empty') : t('contracts.emptyAll')}
          showOrganization
          footer={
            <ListFooter
              shown={rows.length}
              total={contracts.data?.pages.at(-1)?.totalCount ?? null}
              hasMore={Boolean(contracts.hasNextPage)}
              loading={contracts.isFetchingNextPage}
              onMore={() => void contracts.fetchNextPage()}
            />
          }
        />
      )}
    </>
  );
}

/** `inPanel`: the list sits in a Panel (an organization's tab), which is already the card. */
export function ContractList({
  rows,
  loading,
  empty,
  emptyIcon = <DocumentText24Regular />,
  showOrganization,
  inPanel,
  footer,
}: {
  rows: ContractListItem[];
  loading: boolean;
  empty: string;
  emptyIcon?: ReactElement;
  /** The end of a paged list, inside the card. */
  footer?: ReactNode;
  showOrganization: boolean;
  inPanel?: boolean;
}) {
  const styles = useCatalogStyles();
  const record = useRecordStyles();
  const { t } = useTranslation();
  const narrow = useMediaQuery(NARROW_SCREEN);

  const period = (c: ContractListItem) => `${formatDate(c.startDate)} – ${c.endDate ? formatDate(c.endDate) : t('contracts.untilFurtherNotice')}`;
  const skeleton = loading && <Skeleton aria-label={t('common.loading')}><SkeletonItem size={48} /></Skeleton>;
  const emptyState = !loading && rows.length === 0 && <EmptyState icon={emptyIcon} message={empty} />;

  // In a panel an empty list is the empty state alone: no column headers over nothing.
  if (inPanel && !loading && rows.length === 0) return emptyState;

  if (narrow) {
    return (
      <>
        {rows.length > 0 && (
          <ul className={record.cards} aria-label={t('contracts.title')}>
            {rows.map((c) => (
              <li key={c.id} className={record.card}>
                <span className={record.cardMain}>
                  <RecordCell
                    icon={<DocumentText16Regular />}
                    tone="iris"
                    size={36}
                    name={<AppLink to={`/contracts/${c.id}`} className={styles.name}>{c.number} · {c.title}</AppLink>}
                    meta={[showOrganization && <span>{c.organization.name}</span>, <span className="tabular">{period(c)}</span>]}
                  />
                </span>
                <span className={record.cardEnd}>
                  <ContractStatusBadge status={c.status} />
                </span>
              </li>
            ))}
          </ul>
        )}
        {skeleton}
        {emptyState && (inPanel ? emptyState : <div className={styles.emptyCard}>{emptyState}</div>)}
        {footer}
      </>
    );
  }

  return (
    <ScrollTable className={mergeClasses(styles.tableWrap, inPanel && record.flatTable)}>
      <Table className={styles.table} style={{ minWidth: showOrganization ? 1060 : 880 }} aria-label={t('contracts.title')}>
        <TableHeader>
          <TableRow>
            {/* Content widths: every cell adds 12 px of padding on each side; the organization takes the rest. */}
            <TableHeaderCell style={{ width: 222 }}>{t('contracts.fields.contract')}</TableHeaderCell>
            {showOrganization && <TableHeaderCell>{t('contracts.fields.organization')}</TableHeaderCell>}
            <TableHeaderCell style={{ width: 106 }}>{t('contracts.fields.status')}</TableHeaderCell>
            <TableHeaderCell style={{ width: 178 }}>{t('contracts.fields.period')}</TableHeaderCell>
            <TableHeaderCell style={showOrganization ? { width: 126 } : undefined}>{t('contracts.fields.sla')}</TableHeaderCell>
            <TableHeaderCell style={showOrganization ? { width: 136 } : undefined}>{t('contracts.fields.owner')}</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((c) => (
            <TableRow key={c.id}>
              <TableCell>
                <RecordCell
                  icon={<DocumentText16Regular />}
                  tone="iris"
                  name={<AppLink to={`/contracts/${c.id}`} className={styles.name}>{c.title}</AppLink>}
                  meta={[<span>{c.number}</span>, <span>{t(`contracts.types.${c.type}`)}</span>]}
                />
              </TableCell>
              {showOrganization && (
                <TableCell>
                  <RecordCell
                    avatarName={c.organization.name}
                    size={28}
                    name={<AppLink to={`/organizations/${c.organization.id}`} className={record.quietLink}>{c.organization.name}</AppLink>}
                  />
                </TableCell>
              )}
              <TableCell>
                <ContractStatusBadge status={c.status} />
              </TableCell>
              <TableCell className="tabular">
                {period(c)}
                {c.autoRenew && <div className={styles.muted}>{t('contracts.autoRenews')}</div>}
              </TableCell>
              <TableCell>{c.slaName ?? <span className={styles.muted}>{t('contracts.form.noSla')}</span>}</TableCell>
              <TableCell>{c.owner && <RecordCell avatarName={c.owner.name} size={28} name={<span className={record.person}>{c.owner.name}</span>} />}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {skeleton}
      {emptyState}
      {footer}
    </ScrollTable>
  );
}
