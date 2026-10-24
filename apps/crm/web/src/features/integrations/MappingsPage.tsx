import { useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Badge,
  Button,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
  SearchBox,
  Spinner,
  Tab,
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
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { useTableCardStyles } from '../admin/tableCard';
import type { BulkResult, ExternalRecordItem } from '../../api/types';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { useKeptWhileClosing } from '../../shared/components/useKeptWhileClosing';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDateTime } from '../../shared/utils/format';
import { formatOrgNumber } from '../../shared/utils/orgNumber';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import { ForbiddenPage } from '../errors/ForbiddenPage';
import { useIntegrationActions, useIntegrationStatus, useRecords, type RecordFilters } from './api';
import { entityRoute, entityTypeOf, systemName, typeName } from './labels';
import { OrganizationPickerDialog } from './OrganizationPickerDialog';
import { ScrollTable } from '../../shared/components/ScrollTable';
import { ScrollTabList } from '../../shared/components/ScrollTabList';
import { FilterChips, FilterField, Toolbar } from '../../shared/components/Toolbar';
import { PlugDisconnected24Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  // Which system on the left, which kind of record on the right: two switches of their own, never read as one row of tabs.
  tabs: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '10px 16px', marginBottom: '16px', minWidth: 0 },
  // On a phone a tab row longer than the screen scrolls sideways (ScrollTabList fades the hidden edge).
  tabList: { overflowX: 'auto', overflowY: 'hidden', scrollPaddingInline: '16px', maxWidth: '100%' },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '18px' },
  name: { display: 'block', fontWeight: tokens.fontWeightSemibold, overflowWrap: 'anywhere' },
  meta: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', marginTop: '2px' },
  suggestions: { display: 'grid', gap: '6px', minWidth: 0 },
  suggestion: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
    minWidth: 0,
    paddingTop: '6px',
    paddingBottom: '6px',
    paddingLeft: '12px',
    paddingRight: '6px',
    borderRadius: '12px',
    backgroundColor: h.well,
  },
  suggestionText: { display: 'grid', minWidth: 0 },
  // The row's own action keeps its width; a long name wraps instead of squeezing "Link" under its padding.
  suggestionAction: { flexShrink: 0 },
  suggestionName: { fontWeight: tokens.fontWeightSemibold, fontSize: '13px', lineHeight: '18px', overflowWrap: 'anywhere' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: '4px' },
  info: { marginBottom: '16px' },
  more: { display: 'flex', justifyContent: 'center', paddingTop: '12px', paddingBottom: '12px' },
});

type State = RecordFilters['state'];

export function MappingsPage() {
  const styles = useStyles();
  const table = useTableCardStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const allowed = useCan(Permissions.integrationsManage);
  const [params, setParams] = useSearchParams();
  const status = useIntegrationStatus(allowed);
  const actions = useIntegrationActions();
  const [searchText, setSearchText] = useState(params.get('search') ?? '');
  const search = useDebouncedValue(searchText.trim());
  const [picking, setPicking] = useState<ExternalRecordItem | null>(null);
  const [bulk, setBulk] = useState<{ preview: BulkResult | null } | null>(null);
  const shownBulk = useKeptWhileClosing(bulk);
  const restoreFocusTarget = useRestoreFocusTarget();

  // Connected systems first, so the default tab is one that has data.
  const systems = (status.data ?? []).filter((s) => s.recordTypes.length > 0).sort((a, b) => Number(b.enabled) - Number(a.enabled));
  const system = params.get('system') ?? systems[0]?.system ?? 'poweroffice';
  const types = systems.find((s) => s.system === system)?.recordTypes ?? [];
  const type = params.get('type') ?? types[0] ?? 'Customer';
  const state = (params.get('state') as State | null) ?? 'Unlinked';
  const filters: RecordFilters = { system, type, state, search };
  const records = useRecords(filters);

  if (!allowed) return <ForbiddenPage />;

  const set = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next, { replace: true });
  };

  const run = async <T,>(action: () => Promise<T>, success: (result: T) => string) => {
    try {
      notify(success(await action()));
    } catch (error) {
      notify(t('errors.generic'), 'error', errorMessage(error, t));
    }
  };

  const entityType = entityTypeOf(type);
  const rows = records.data?.pages.flatMap((p) => p.items) ?? [];
  const first = records.data?.pages[0];
  // While another search or state of the same records is read, the previous rows stay where they are, so a click on one still lands.
  // They are not its answer: the counts on the states keep their room unseen, and no empty answer is claimed for them.
  const stale = records.isPlaceholderData;
  const loading = records.isPending || (stale && rows.length === 0);

  const openBulk = async () => {
    setBulk({ preview: null });
    try {
      const preview = await actions.importUnlinked.mutateAsync({ system, type, dryRun: true });
      setBulk({ preview });
    } catch (error) {
      setBulk(null);
      notify(t('errors.generic'), 'error', errorMessage(error, t));
    }
  };

  return (
    <>
      <PageHeader title={t('mappings.title')} subtitle={t('mappings.subtitle')} />
      {status.error && <ErrorState error={status.error} onRetry={() => void status.refetch()} />}

      <div className={styles.tabs}>
        <ScrollTabList className={styles.tabList} selectedValue={system} onTabSelect={(_, d) => set({ system: String(d.value), type: null })}>
          {systems.map((s) => (
            <Tab key={s.system} value={s.system}>
              {systemName(t, s.system)}
            </Tab>
          ))}
        </ScrollTabList>
        <ScrollTabList className={styles.tabList} size="small" selectedValue={type} onTabSelect={(_, d) => set({ type: String(d.value) })}>
          {types.map((ty) => (
            <Tab key={ty} value={ty}>
              {typeName(t, ty)}
            </Tab>
          ))}
        </ScrollTabList>
      </div>

      <Toolbar
        label={t('mappings.filtersLabel')}
        end={
          entityType && (
            <>
              <Button
                onClick={() => void run(() => actions.autoLink.mutateAsync({ system, type }), (r) => t('mappings.autoLinkDone', { ...r }))}
                disabled={actions.autoLink.isPending}
              >
                {t('mappings.autoLink')}
              </Button>
              <Button {...restoreFocusTarget} appearance="primary" onClick={() => void openBulk()}>
                {t('mappings.importAll')}
              </Button>
            </>
          )
        }
      >
        <FilterChips
          label={t('mappings.stateLabel')}
          value={state}
          onChange={(value) => set({ state: value })}
          countsPending={stale}
          options={(['Unlinked', 'Linked', 'All'] as const).map((value) => ({
            value,
            label: t(`mappings.state.${value}`),
            count: first ? (value === 'Unlinked' ? first.unlinked : value === 'Linked' ? first.total - first.unlinked : first.total) : undefined,
          }))}
        />
        <FilterField label={t('mappings.search')} kind="search">
          <SearchBox value={searchText} onChange={(_, d) => setSearchText(d.value)} placeholder={t('mappings.search')} aria-label={t('mappings.search')} />
        </FilterField>
      </Toolbar>

      {!entityType && (
        <MessageBar intent="info" className={styles.info}>
          <MessageBarBody>{t('mappings.readOnlyType')}</MessageBarBody>
        </MessageBar>
      )}

      {records.error ? (
        <ErrorState error={records.error} onRetry={() => void records.refetch()} />
      ) : (
        <ScrollTable>
          <Table className={mergeClasses(table.min880, table.roomy)} aria-label={t('mappings.title')} aria-busy={stale || undefined}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('mappings.columns.external', { system: systemName(t, system) })}</TableHeaderCell>
                <TableHeaderCell>{t('mappings.columns.keys')}</TableHeaderCell>
                <TableHeaderCell>{t('mappings.columns.crm')}</TableHeaderCell>
                {entityType && <TableHeaderCell>{t('mappings.columns.actions')}</TableHeaderCell>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const route = r.link ? entityRoute(r.externalType, r.link.entityId) : null;
                return (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Text className={styles.name}>{r.displayName}</Text>
                      <span className={styles.meta}>
                        <span className={styles.muted}>
                          #{r.externalId} · {formatDateTime(r.externalChangedAt ?? r.lastSeenAt)}
                        </span>{' '}
                        {r.isGone && (
                          <Badge size="small" appearance="outline">
                            {t('mappings.gone')}
                          </Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell>
                      {r.orgNumber && <Text block className="tabular">{formatOrgNumber(r.orgNumber)}</Text>}
                      {r.email && <Text block className={styles.muted}>{r.email}</Text>}
                      {r.domain && <Text block className={styles.muted}>{r.domain}</Text>}
                    </TableCell>
                    <TableCell>
                      {r.link ? (
                        <span>
                          {route ? <AppLink to={route}>{r.link.entityName ?? r.link.entityId}</AppLink> : r.link.entityName}{' '}
                          <Text className={styles.muted}>({t(`mappings.methods.${r.link.method}`)})</Text>
                        </span>
                      ) : r.suggestions.length > 0 ? (
                        <span className={styles.suggestions}>
                          {r.suggestions.map((s) => {
                            const reasons = s.reasons.map((x) => t(`mappings.reasons.${x}`, { defaultValue: x })).join(', ');
                            return (
                              // A suggested CRM record: its name and why it matches, the link button at the end of the row.
                              <span key={s.entityId} className={styles.suggestion}>
                                <span className={styles.suggestionText}>
                                  <span className={styles.suggestionName}>{s.name}</span>
                                  <span className={styles.muted}>{reasons}</span>
                                </span>
                                <Button
                                  size="small"
                                  className={styles.suggestionAction}
                                  aria-label={`${t('mappings.linkTo', { name: s.name })} · ${reasons}`}
                                  onClick={() =>
                                    void run(
                                      () => actions.link.mutateAsync({ system, externalType: type, externalId: r.externalId, entityId: s.entityId }),
                                      () => t('mappings.linked'),
                                    )
                                  }
                                >
                                  {t('mappings.link')}
                                </Button>
                              </span>
                            );
                          })}
                        </span>
                      ) : (
                        <Text className={styles.muted}>{entityType ? t('mappings.noSuggestion') : ''}</Text>
                      )}
                    </TableCell>
                    {entityType && (
                      <TableCell>
                        <span className={styles.actions}>
                          {r.link ? (
                            <Button size="small" appearance="subtle" onClick={() => void run(() => actions.unlink.mutateAsync(r.link!.linkId), () => t('mappings.unlinked'))}>
                              {t('mappings.unlink')}
                            </Button>
                          ) : (
                            <>
                              {(entityType === 'Organization' || entityType === 'Product') && (
                                <Button {...restoreFocusTarget} size="small" onClick={() => setPicking(r)}>
                                  {t('mappings.pick')}
                                </Button>
                              )}
                              <Button
                                size="small"
                                onClick={() =>
                                  void run(() => actions.importOne.mutateAsync({ system, type, externalId: r.externalId }), () => t('mappings.imported'))
                                }
                                disabled={actions.importOne.isPending}
                              >
                                {t('mappings.import')}
                              </Button>
                            </>
                          )}
                        </span>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {loading && <Spinner className={styles.more} />}
          {!loading && rows.length === 0 && <EmptyState message={t('mappings.empty')} icon={<PlugDisconnected24Regular />} />}
          {records.hasNextPage && (
            <div className={styles.more}>
              <Button onClick={() => void records.fetchNextPage()} disabled={records.isFetchingNextPage}>
                {t('common.loadMore')}
              </Button>
            </div>
          )}
        </ScrollTable>
      )}

      <OrganizationPickerDialog
        open={picking !== null}
        group={entityType === 'Product' ? 'products' : 'organizations'}
        initialSearch={picking?.displayName ?? ''}
        onClose={() => setPicking(null)}
        onPick={(entity) => {
          const record = picking!;
          setPicking(null);
          void run(
            () => actions.link.mutateAsync({ system, externalType: type, externalId: record.externalId, entityId: entity.id }),
            () => t('mappings.linked'),
          );
        }}
      />

      <Dialog open={bulk !== null} onOpenChange={(_, d) => !d.open && setBulk(null)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('mappings.bulkTitle', { type: typeName(t, type).toLowerCase() })}</DialogTitle>
            <DialogContent>{shownBulk?.preview ? t('mappings.bulkDryRun', { ...shownBulk.preview }) : <Spinner />}</DialogContent>
            <DialogActions>
              <Button onClick={() => setBulk(null)}>{t('common.cancel')}</Button>
              <Button
                appearance="primary"
                disabled={!bulk?.preview || actions.importUnlinked.isPending}
                onClick={() =>
                  void run(
                    async () => {
                      const result = await actions.importUnlinked.mutateAsync({ system, type, dryRun: false });
                      setBulk(null);
                      return result;
                    },
                    (r) => t('mappings.bulkDone', { ...r }),
                  )
                }
              >
                {t('mappings.bulkConfirm')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
