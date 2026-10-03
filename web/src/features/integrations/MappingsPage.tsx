import { useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  MessageBar,
  MessageBarBody,
  Option,
  SearchBox,
  Spinner,
  Tab,
  TabList,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import type { BulkResult, ExternalRecordItem } from '../../api/types';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDateTime } from '../../shared/utils/format';
import { formatOrgNumber } from '../../shared/utils/orgNumber';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import { NotFoundPage } from '../errors/NotFoundPage';
import { useIntegrationActions, useIntegrationStatus, useRecords, type RecordFilters } from './api';
import { entityRoute, entityTypeOf, systemName, typeName } from './labels';
import { OrganizationPickerDialog } from './OrganizationPickerDialog';

const useStyles = makeStyles({
  toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalM, marginBlock: tokens.spacingVerticalM },
  // Fixed width: SearchBox shows its clear button only while focused, and a growing box would re-wrap the toolbar and
  // move the table under the pointer when focus leaves it.
  search: { width: '280px', maxWidth: '100%', flexShrink: 0 },
  spacer: { flex: 1 },
  tableWrap: { overflowX: 'auto', backgroundColor: tokens.colorNeutralBackground1, borderRadius: tokens.borderRadiusLarge, border: `1px solid ${tokens.colorNeutralStroke2}` },
  table: { minWidth: '900px' },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  suggestions: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, alignItems: 'flex-start' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
  more: { display: 'flex', justifyContent: 'center', paddingBlock: tokens.spacingVerticalM },
});

type State = RecordFilters['state'];

export function MappingsPage() {
  const styles = useStyles();
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
  const restoreFocusTarget = useRestoreFocusTarget();

  // Connected systems first, so the default tab is one that has data.
  const systems = (status.data ?? []).filter((s) => s.recordTypes.length > 0).sort((a, b) => Number(b.enabled) - Number(a.enabled));
  const system = params.get('system') ?? systems[0]?.system ?? 'poweroffice';
  const types = systems.find((s) => s.system === system)?.recordTypes ?? [];
  const type = params.get('type') ?? types[0] ?? 'Customer';
  const state = (params.get('state') as State | null) ?? 'Unlinked';
  const filters: RecordFilters = { system, type, state, search };
  const records = useRecords(filters);

  if (!allowed) return <NotFoundPage />;

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

      <TabList selectedValue={system} onTabSelect={(_, d) => set({ system: String(d.value), type: null })}>
        {systems.map((s) => (
          <Tab key={s.system} value={s.system}>
            {systemName(t, s.system)}
          </Tab>
        ))}
      </TabList>
      <TabList size="small" selectedValue={type} onTabSelect={(_, d) => set({ type: String(d.value) })}>
        {types.map((ty) => (
          <Tab key={ty} value={ty}>
            {typeName(t, ty)}
          </Tab>
        ))}
      </TabList>

      <div className={styles.toolbar}>
        <Dropdown
          aria-label={t('mappings.state.All')}
          value={t(`mappings.state.${state}`)}
          selectedOptions={[state]}
          onOptionSelect={(_, d) => set({ state: d.optionValue ?? null })}
        >
          {(['Unlinked', 'Linked', 'All'] as State[]).map((s) => (
            <Option key={s} value={s}>
              {t(`mappings.state.${s}`)}
            </Option>
          ))}
        </Dropdown>
        <SearchBox className={styles.search} value={searchText} onChange={(_, d) => setSearchText(d.value)} placeholder={t('mappings.search')} aria-label={t('mappings.search')} />
        {first && <Text className={styles.muted}>{t('mappings.total', { unlinked: first.unlinked, total: first.total })}</Text>}
        <span className={styles.spacer} />
        {entityType && (
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
        )}
      </div>

      {!entityType && (
        <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>{t('mappings.readOnlyType')}</MessageBarBody>
        </MessageBar>
      )}

      {records.error ? (
        <ErrorState error={records.error} onRetry={() => void records.refetch()} />
      ) : (
        <div className={styles.tableWrap}>
          <Table className={styles.table} aria-label={t('mappings.title')}>
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
                      <Text weight="semibold" block>
                        {r.displayName}
                      </Text>
                      <span className={styles.muted}>
                        #{r.externalId} · {formatDateTime(r.externalChangedAt ?? r.lastSeenAt)}
                      </span>{' '}
                      {r.isGone && (
                        <Badge size="small" appearance="outline" color="subtle">
                          {t('mappings.gone')}
                        </Badge>
                      )}
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
                          {r.suggestions.map((s) => (
                            <Button
                              key={s.entityId}
                              size="small"
                              appearance="outline"
                              onClick={() =>
                                void run(
                                  () => actions.link.mutateAsync({ system, externalType: type, externalId: r.externalId, entityId: s.entityId }),
                                  () => t('mappings.linked'),
                                )
                              }
                            >
                              {t('mappings.linkTo', { name: s.name })} · {s.reasons.map((x) => t(`mappings.reasons.${x}`, { defaultValue: x })).join(', ')}
                            </Button>
                          ))}
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
          {records.isPending && <Spinner style={{ padding: 16 }} />}
          {!records.isPending && rows.length === 0 && <EmptyState message={t('mappings.empty')} />}
          {records.hasNextPage && (
            <div className={styles.more}>
              <Button onClick={() => void records.fetchNextPage()} disabled={records.isFetchingNextPage}>
                {t('common.loadMore')}
              </Button>
            </div>
          )}
        </div>
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
            <DialogContent>{bulk?.preview ? t('mappings.bulkDryRun', { ...bulk.preview }) : <Spinner />}</DialogContent>
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
