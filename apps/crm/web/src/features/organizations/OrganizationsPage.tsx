import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
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
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { Add20Regular, ArrowDownload20Regular, Building24Regular, DocumentCopy20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { ApiError, download, query } from '../../api/client';
import { organizationStatuses, type OrganizationStatus } from '../../api/types';
import { Permissions, useCan, useCurrentUser } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { NoValue } from '../../shared/components/NoValue';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { FilterChips, Toolbar } from '../../shared/components/Toolbar';
import { OrganizationStatusBadge, RegistryStatusBadge } from '../../shared/components/StatusBadges';
import { formatOrgNumber } from '../../shared/utils/orgNumber';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import { NARROW_SCREEN, useMediaQuery } from '../../shared/utils/useMediaQuery';
import { useOrganizationCounts, useOrganizations } from './api';
import { SavedViews } from '../../shared/views/SavedViews';
import { useScrollEdges } from '../../shared/utils/useScrollEdges';
import { h } from '../../app/hearth';
import { RecordCell } from './RecordCell';
import { AgreementFact, HourBankFact, InvoiceFact, WorkFact } from './CustomerFactCells';
import { attentionPhrases } from './customerFactsText';
import { NeedsAttentionPanel } from './NeedsAttentionPanel';
import { useCustomerFacts } from './useCustomerFacts';
import { useRecordStyles } from './recordStyles';

// The colour of each status, as its badge shows it.
const statusDot: Record<string, string> = { Lead: h.iris, Prospect: h.ember, Customer: h.spruce, Former: h.faint, Partner: h.ink };

const useStyles = makeStyles({
  filters: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '12px', marginBottom: '16px', '@media (max-width: 560px)': { '& > .fui-SearchBox, & > .fui-Field, & > .fui-Input': { flex: '1 1 100%', maxWidth: '100%' }, '& .fui-Dropdown, & .fui-Field .fui-Input': { width: '100%', minWidth: 0, maxWidth: '100%' } } },
  search: { flex: '1 1 320px', maxWidth: '480px' },
  tableWrap: {
    overflowX: 'auto',
    scrollPaddingInline: '16px',
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px' },
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: '20px',
    border: `1px solid ${h.line}`,
    boxShadow: tokens.shadow4,
    paddingLeft: '8px',
    paddingRight: '8px',
  },
  table: { minWidth: '720px' },
  // With the facts of each customer the table needs room; it scrolls inside its card below that.
  wideTable: { minWidth: '1080px' },
  phrases: { color: h.emberT, fontSize: '12.5px', lineHeight: '18px', fontWeight: 600 },
  factsNote: { color: h.muted, fontSize: '12.5px', lineHeight: '18px', paddingLeft: '8px', paddingTop: '6px' },
  row: { cursor: 'pointer' },
  name: { fontWeight: 700, color: 'inherit' },
  muted: { color: h.muted, fontWeight: 500 },
  more: { display: 'flex', justifyContent: 'center', paddingTop: '12px', paddingBottom: '12px' },
});

function scrollTableOnKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
  if (!direction) return;
  event.preventDefault();
  event.currentTarget.scrollBy({ left: direction * event.currentTarget.clientWidth * 0.75, behavior: 'instant' });
}

export function OrganizationsPage() {
  const styles = useStyles();
  const record = useRecordStyles();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const notify = useNotify();
  const canCreate = useCan(Permissions.customersWrite);
  const user = useCurrentUser();
  // The facts that say whom to attend to (UX 2026, В6), each shown only to a role that may read its records.
  const canWork = useCan(Permissions.activitiesRead);
  const canAgreements = useCan(Permissions.contractsRead);
  const canInvoices = useCan(Permissions.billingRead);
  const withFacts = canWork || canAgreements || canInvoices;
  const [exporting, setExporting] = useState(false);
  const narrow = useMediaQuery(NARROW_SCREEN);
  const [params, setParams] = useSearchParams();
  const urlSearch = params.get('search') ?? '';
  const [search, setSearch] = useState(urlSearch);
  const [previousUrlSearch, setPreviousUrlSearch] = useState(urlSearch);
  const status = (params.get('status') as OrganizationStatus | null) ?? null;
  const mine = params.get('mine') === '1';
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
    accountManagerId: mine ? user.id : null,
  });
  const rows = data?.pages.flatMap((page) => page.items) ?? [];
  // One read of facts per loaded page of the list (at most 50 ids), never one per row.
  const facts = useCustomerFacts(withFacts ? (data?.pages ?? []).map((page) => page.items.map((row) => row.id)) : []);
  const counts = useOrganizationCounts(debouncedSearch);
  const table = useRef<HTMLDivElement>(null);
  const tableEdges = useScrollEdges(table, 'x', `${narrow}:${rows.length}:${i18n.resolvedLanguage}:${Boolean(error)}`);

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

  const setMine = (value: boolean) => {
    const next = new URLSearchParams(params);
    if (value) next.set('mine', '1');
    else next.delete('mine');
    setParams(next, { replace: true });
  };
  const factOf = (id: string) => facts.facts.get(id);

  return (
    <>
      <PageHeader
        title={t('organizations.title')}
        subtitle={t('organizations.subtitle')}
        actions={
          <>
            <Button icon={<DocumentCopy20Regular />} appearance="subtle" onClick={() => navigate('/organizations/duplicates')}>
              {t('duplicates.link')}
            </Button>
            <SavedViews scope="organizations" keys={['search', 'status', 'mine']} />
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
      {/* The list filters of the reference: the search, then the statuses as chips (one tap, all visible at once). */}
      <Toolbar>
        <SearchBox
          id="organizations-search"
          className={styles.search}
          value={search}
          onChange={(_, d) => setSearch(d.value)}
          placeholder={t('organizations.searchPlaceholder')}
          aria-label={t('organizations.searchPlaceholder')}
        />
        <FilterChips
          label={t('organizations.scopeFilter')}
          value={mine ? 'mine' : 'all'}
          onChange={(value) => setMine(value === 'mine')}
          options={[{ value: 'all', label: t('organizations.scopeAll') }, { value: 'mine', label: t('organizations.scopeMine') }]}
        />
        <FilterChips
          label={t('organizations.statusFilter')}
          value={status ?? ''}
          onChange={(value) => setStatus(value || undefined)}
          options={[
            { value: '', label: t('common.all'), count: counts ? organizationStatuses.reduce((sum, s) => sum + counts[s], 0) : undefined },
            ...organizationStatuses.map((s) => ({ value: s, label: t(`status.${s}`), dot: statusDot[s], count: counts?.[s] })),
          ]}
        />
      </Toolbar>

      {withFacts && <NeedsAttentionPanel mine={mine} />}

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : narrow ? (
        <>
          <ul className={record.cards} aria-label={t('organizations.title')}>
            {rows.map((row) => (
              <li key={row.id} className={record.card}>
                <span className={record.cardMain}>
                  <RecordCell
                    avatarName={row.name}
                    size={36}
                    name={<AppLink to={`/organizations/${row.id}`} className={styles.name}>{row.name}</AppLink>}
                    meta={[row.orgNumber && <span className="tabular">{formatOrgNumber(row.orgNumber)}</span>, row.city && <span>{row.city}</span>]}
                  />
                  {/* On a phone only the facts that ask for a look, in one line under the name. */}
                  {facts.asOf && factOf(row.id) && attentionPhrases(factOf(row.id)!, facts.asOf, t).length > 0 && (
                    <span className={styles.phrases}>{attentionPhrases(factOf(row.id)!, facts.asOf, t).join(' · ')}</span>
                  )}
                </span>
                <span className={record.cardEnd}>
                  <OrganizationStatusBadge status={row.status} />
                  <RegistryStatusBadge status={row.registryStatus} />
                </span>
              </li>
            ))}
          </ul>
          {isPending && <Skeleton aria-label={t('common.loading')}><SkeletonItem size={48} /></Skeleton>}
          {!isPending && rows.length === 0 && (
            <EmptyState icon={<Building24Regular />} message={debouncedSearch || status ? t('organizations.empty') : t('organizations.emptyAll')} />
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
        <div ref={table} className={styles.tableWrap} style={tableEdges.style} role="region"
          aria-label={t(tableEdges.overflow ? 'organizations.scrollableTable' : 'organizations.title')} tabIndex={tableEdges.overflow ? 0 : undefined}
          onKeyDown={scrollTableOnKeyDown}>
          <Table className={mergeClasses(styles.table, withFacts && styles.wideTable)} aria-label={t('organizations.title')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell style={{ width: 300 }}>{t('organizations.columns.name')}</TableHeaderCell>
                <TableHeaderCell style={{ width: 120 }}>{t('organizations.columns.status')}</TableHeaderCell>
                {canWork && <TableHeaderCell>{t('customerFacts.columns.work')}</TableHeaderCell>}
                {canAgreements && <TableHeaderCell>{t('customerFacts.columns.agreement')}</TableHeaderCell>}
                {canAgreements && <TableHeaderCell>{t('customerFacts.columns.hourBank')}</TableHeaderCell>}
                {canInvoices && <TableHeaderCell>{t('customerFacts.columns.invoices')}</TableHeaderCell>}
                <TableHeaderCell>{t('organizations.columns.accountManager')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending &&
                Array.from({ length: 5 }, (_, i) => (
                  <TableRow key={`skeleton-${i}`}>
                    {Array.from({ length: 3 + Number(canWork) + 2 * Number(canAgreements) + Number(canInvoices) }, (_, j) => (
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
                    <RecordCell
                      avatarName={row.name}
                      name={
                        <AppLink to={`/organizations/${row.id}`} className={styles.name} onClick={(e) => e.stopPropagation()}>
                          {row.name}
                        </AppLink>
                      }
                      // The registry mark sits with the name: it matters only when the register says something.
                      meta={[row.orgNumber && <span className="tabular">{formatOrgNumber(row.orgNumber)}</span>, row.city && <span>{row.city}</span>,
                        row.registryStatus !== 'Unknown' && row.registryStatus !== 'Active' && <RegistryStatusBadge status={row.registryStatus} />]}
                    />
                  </TableCell>
                  <TableCell>
                    <OrganizationStatusBadge status={row.status} />
                  </TableCell>
                  {canWork && <TableCell>{factOf(row.id)?.work ? <WorkFact work={factOf(row.id)!.work!} /> : <NoValue label={t('customerFacts.unread')} />}</TableCell>}
                  {canAgreements && <TableCell>{factOf(row.id)?.agreements && facts.asOf
                    ? <AgreementFact agreements={factOf(row.id)!.agreements!} asOf={facts.asOf} /> : <NoValue label={t('customerFacts.unread')} />}</TableCell>}
                  {canAgreements && <TableCell>{factOf(row.id)?.hourBanks ? <HourBankFact hourBanks={factOf(row.id)!.hourBanks!} /> : <NoValue label={t('customerFacts.unread')} />}</TableCell>}
                  {canInvoices && <TableCell>{factOf(row.id)?.invoices ? <InvoiceFact invoices={factOf(row.id)!.invoices!} /> : <NoValue label={t('customerFacts.unread')} />}</TableCell>}
                  <TableCell>
                    {row.accountManager ? (
                      <RecordCell avatarName={row.accountManager.displayName} size={28} name={<span className={styles.muted}>{row.accountManager.displayName}</span>} />
                    ) : (
                      <NoValue label={t('organizations.noAccountManager')} />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {facts.failed && <Text block className={styles.factsNote}>{t('customerFacts.someUnread')}</Text>}
          {!isPending && rows.length === 0 && (
            <EmptyState icon={<Building24Regular />} message={debouncedSearch || status ? t('organizations.empty') : t('organizations.emptyAll')} />
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
