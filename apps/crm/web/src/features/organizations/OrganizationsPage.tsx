import { useEffect, useState } from 'react';
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
  TableCellLayout,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Add20Regular, ArrowDownload20Regular, DocumentCopy20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { ApiError, download, query } from '../../api/client';
import { organizationStatuses, type OrganizationStatus } from '../../api/types';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { OrganizationStatusBadge, RegistryStatusBadge } from '../../shared/components/StatusBadges';
import { formatOrgNumber } from '../../shared/utils/orgNumber';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import { NARROW_SCREEN, useMediaQuery } from '../../shared/utils/useMediaQuery';
import { useOrganizations } from './api';
import { SavedViews } from '../../shared/views/SavedViews';

const useStyles = makeStyles({
  filters: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalM },
  search: { flex: '1 1 320px', maxWidth: '480px' },
  tableWrap: {
    overflowX: 'auto',
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  table: { minWidth: '760px' },
  row: { cursor: 'pointer' },
  name: { fontWeight: tokens.fontWeightSemibold },
  more: { display: 'flex', justifyContent: 'center', paddingBlock: tokens.spacingVerticalM },
  cards: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  cardMeta: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
});

export function OrganizationsPage() {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const notify = useNotify();
  const canCreate = useCan(Permissions.customersWrite);
  const [exporting, setExporting] = useState(false);
  const narrow = useMediaQuery(NARROW_SCREEN);
  const [params, setParams] = useSearchParams();
  const urlSearch = params.get('search') ?? '';
  const [search, setSearch] = useState(urlSearch);
  const [previousUrlSearch, setPreviousUrlSearch] = useState(urlSearch);
  const status = (params.get('status') as OrganizationStatus | null) ?? null;
  const debouncedSearch = useDebouncedValue(search.trim());

  // The global header search changes the URL while this page is open: adopt it (React "adjust state on prop change").
  if (urlSearch !== previousUrlSearch) {
    setPreviousUrlSearch(urlSearch);
    if (urlSearch !== search.trim()) setSearch(urlSearch);
  }

  useEffect(() => {
    if ((params.get('search') ?? '') === debouncedSearch) return;
    const next = new URLSearchParams(params);
    if (debouncedSearch) next.set('search', debouncedSearch);
    else next.delete('search');
    setParams(next, { replace: true });
  }, [debouncedSearch, params, setParams]);

  const { data, error, isPending, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useOrganizations({
    search: debouncedSearch,
    status,
  });
  const rows = data?.pages.flatMap((page) => page.items) ?? [];

  const exportToExcel = async () => {
    setExporting(true);
    try {
      await download(`/api/v1/customers/organizations/export${query({ search: debouncedSearch, status, lang: i18n.language })}`);
    } catch (error) {
      const message = error instanceof ApiError && error.status === 429 ? t('organizations.export.rateLimited') : errorMessage(error, t);
      notify(t('organizations.export.failed'), 'error', message);
    } finally {
      setExporting(false);
    }
  };

  const setStatus = (value: string | undefined) => {
    const next = new URLSearchParams(params);
    if (value) next.set('status', value);
    else next.delete('status');
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title={t('organizations.title')}
        actions={
          <>
            <Button icon={<DocumentCopy20Regular />} appearance="subtle" onClick={() => navigate('/organizations/duplicates')}>
              {t('duplicates.link')}
            </Button>
            <Button icon={<ArrowDownload20Regular />} onClick={() => void exportToExcel()} disabled={exporting || rows.length === 0}>
              {exporting ? t('common.loading') : t('organizations.export.button')}
            </Button>
            {canCreate && (
              <Button appearance="primary" icon={<Add20Regular />} onClick={() => navigate('/organizations/new')}>
                {t('organizations.new')}
              </Button>
            )}
          </>
        }
      />
      <div className={styles.filters}>
        <SearchBox
          id="organizations-search"
          className={styles.search}
          value={search}
          onChange={(_, d) => setSearch(d.value)}
          placeholder={t('organizations.searchPlaceholder')}
          aria-label={t('organizations.searchPlaceholder')}
        />
        <Field label={t('organizations.statusFilter')}>
          <Dropdown
            value={status ? t(`status.${status}`) : t('common.all')}
            selectedOptions={[status ?? '']}
            onOptionSelect={(_, d) => setStatus(d.optionValue || undefined)}
          >
            <Option value="">{t('common.all')}</Option>
            {organizationStatuses.map((s) => (
              <Option key={s} value={s}>
                {t(`status.${s}`)}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <SavedViews scope="organizations" keys={['search', 'status']} />
      </div>

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : narrow ? (
        <>
          <ul className={styles.cards} aria-label={t('organizations.title')}>
            {rows.map((row) => (
              <li key={row.id} className={styles.card}>
                <AppLink to={`/organizations/${row.id}`} className={styles.name}>
                  {row.name}
                </AppLink>
                <span className={styles.cardMeta}>
                  <OrganizationStatusBadge status={row.status} />
                  <RegistryStatusBadge status={row.registryStatus} />
                  {row.orgNumber && <span className="tabular">{formatOrgNumber(row.orgNumber)}</span>}
                  {row.city && <span>{row.city}</span>}
                </span>
              </li>
            ))}
          </ul>
          {isPending && <Skeleton aria-label={t('common.loading')}><SkeletonItem size={48} /></Skeleton>}
          {!isPending && rows.length === 0 && (
            <EmptyState message={debouncedSearch || status ? t('organizations.empty') : t('organizations.emptyAll')} />
          )}
          {hasNextPage && (
            <div className={styles.more}>
              <Button onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
                {isFetchingNextPage ? t('common.loading') : t('common.loadMore')}
              </Button>
            </div>
          )}
        </>
      ) : (
        <div className={styles.tableWrap}>
          <Table className={styles.table} aria-label={t('organizations.title')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('organizations.columns.name')}</TableHeaderCell>
                <TableHeaderCell>{t('organizations.columns.orgNumber')}</TableHeaderCell>
                <TableHeaderCell>{t('organizations.columns.status')}</TableHeaderCell>
                <TableHeaderCell>{t('organizations.columns.city')}</TableHeaderCell>
                <TableHeaderCell>{t('organizations.columns.accountManager')}</TableHeaderCell>
                <TableHeaderCell>{t('organizations.columns.registry')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending &&
                Array.from({ length: 5 }, (_, i) => (
                  <TableRow key={`skeleton-${i}`}>
                    {Array.from({ length: 6 }, (_, j) => (
                      <TableCell key={j}>
                        <Skeleton aria-label={t('common.loading')}>
                          <SkeletonItem />
                        </Skeleton>
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              {rows.map((row) => (
                <TableRow key={row.id} className={styles.row} onClick={() => navigate(`/organizations/${row.id}`)}>
                  <TableCell>
                    <TableCellLayout>
                      <AppLink to={`/organizations/${row.id}`} className={styles.name} onClick={(e) => e.stopPropagation()}>
                        {row.name}
                      </AppLink>
                    </TableCellLayout>
                  </TableCell>
                  <TableCell className="tabular">{formatOrgNumber(row.orgNumber)}</TableCell>
                  <TableCell>
                    <OrganizationStatusBadge status={row.status} />
                  </TableCell>
                  <TableCell>{row.city}</TableCell>
                  <TableCell>{row.accountManager?.displayName}</TableCell>
                  <TableCell>
                    <RegistryStatusBadge status={row.registryStatus} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!isPending && rows.length === 0 && (
            <EmptyState message={debouncedSearch || status ? t('organizations.empty') : t('organizations.emptyAll')} />
          )}
          {hasNextPage && (
            <div className={styles.more}>
              <Button onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
                {isFetchingNextPage ? t('common.loading') : t('common.loadMore')}
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
