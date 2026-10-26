import { useState } from 'react';
import {
  Button,
  Select,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  mergeClasses,
} from '@fluentui/react-components';
import { DocumentSearch16Regular, Filter24Regular, History24Regular, ListBar16Regular, TaskListSquareLtr16Regular, TaskListSquareLtr24Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { usePagedList } from '../../../api/paging';
import { AppLink } from '../../../shared/components/AppLink';
import { EmptyState } from '../../../shared/components/EmptyState';
import { ErrorState } from '../../../shared/components/ErrorState';
import { ListFooter } from '../../../shared/components/ListFooter';
import { Panel } from '../../../shared/components/Panel';
import { ScrollTable } from '../../../shared/components/ScrollTable';
import { FilterField, Toolbar } from '../../../shared/components/Toolbar';
import { formatDateTime } from '../../../shared/utils/format';
import { ScrollRegion } from '../ScrollRegion';
import { useTableCardStyles } from '../tableCard';
import {
  entitiesUrl,
  migrationKeys,
  rowsUrl,
  runsUrl,
  useMigrationRun,
  type BatchEntity,
  type MigrationOutcome,
  type MigrationRun,
} from './api';
import { StatusText } from './parts';
import { ResultView } from './ResultView';
import { useMigrationStyles } from './styles';
import { fieldText, reasonText } from './text';

const useStyles = makeStyles({
  select: { minWidth: '200px' },
  toggle: { justifySelf: 'start' },
  // The outcome gets the room; the other columns keep to their content.
  runs: { tableLayout: 'fixed' },
  colStarted: { width: '150px' },
  colKind: { width: '100px' },
  colStatus: { width: '120px' },
  colRows: { width: '64px' },
  colOpen: { width: '96px' },
});

const OUTCOMES = ['created', 'updated', 'unchanged', 'conflicts', 'rejected'] as const;

const ACTIONS = ['Created', 'Updated', 'Unchanged', 'Conflict', 'Rejected'] as const;

/** The list of runs, or one run with its rows and its batch marker; the way back is the page header's back button. */
export function RunsPanel({ runId, onOpen }: { runId: string | null; onOpen: (id: string | null) => void }) {
  return runId ? <RunDetail id={runId} /> : <RunsList onOpen={onOpen} />;
}

function RunsList({ onOpen }: { onOpen: (id: string) => void }) {
  const styles = useStyles();
  const table = useTableCardStyles();
  const m = useMigrationStyles();
  const { t } = useTranslation();
  const list = usePagedList<MigrationRun>(migrationKeys.runs, runsUrl, {}, { limit: 20, refetchWhile: (run) => run.status === 'Running' });

  if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  if (list.isPending) return <Spinner />;
  if (list.items.length === 0)
    return (
      <Panel>
        <EmptyState message={t('migration.runs.empty')} icon={<History24Regular />} />
      </Panel>
    );
  return (
    <div className={m.stack}>
      <ScrollRegion className={table.region} label={t('migration.runs.title')}>
        <Table className={mergeClasses(table.min800, styles.runs)} aria-label={t('migration.runs.title')}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell className={styles.colStarted}>{t('migration.runs.started')}</TableHeaderCell>
              <TableHeaderCell className={styles.colKind}>{t('migration.runs.kind')}</TableHeaderCell>
              <TableHeaderCell className={styles.colStatus}>{t('migration.runs.status')}</TableHeaderCell>
              <TableHeaderCell className={mergeClasses(table.numberHead, styles.colRows)}>{t('migration.counts.rows')}</TableHeaderCell>
              <TableHeaderCell>{t('migration.runs.outcome')}</TableHeaderCell>
              <TableHeaderCell className={styles.colOpen}>{t('migration.runs.details')}</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.items.map((run) => (
              <TableRow key={run.id}>
                <TableCell className={table.nowrap}>{formatDateTime(run.startedAt)}</TableCell>
                <TableCell>{run.mode === 'Real' ? t('migration.runKindReal') : t('migration.runKindPreview')}</TableCell>
                <TableCell>
                  <StatusText kind="status" value={run.status} />
                </TableCell>
                <TableCell className={table.number}>{run.rowsTotal}</TableCell>
                <TableCell className={table.muted}>
                  {OUTCOMES.filter((key) => run[key] > 0)
                    .map((key) => t(`migration.runs.outcomes.${key}`, { count: run[key] }))
                    .join(' · ') || '—'}
                </TableCell>
                <TableCell>
                  <Button size="small" onClick={() => onOpen(run.id)} aria-label={t('migration.runs.openRun', { started: formatDateTime(run.startedAt) })}>
                    {t('migration.runs.open')}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollRegion>
      <ListFooter shown={list.items.length} total={list.total} hasMore={Boolean(list.hasNextPage)} loading={list.isFetchingNextPage} onMore={() => void list.fetchNextPage()} />
    </div>
  );
}

function RunDetail({ id }: { id: string }) {
  const styles = useStyles();
  const table = useTableCardStyles();
  const m = useMigrationStyles();
  const { t } = useTranslation();
  const [action, setAction] = useState('');
  const [showEntities, setShowEntities] = useState(false);
  const run = useMigrationRun(id);
  const rows = usePagedList<MigrationOutcome>(migrationKeys.rows(id, action), rowsUrl(id), { action }, { limit: 50 });
  const entities = usePagedList<BatchEntity>(migrationKeys.entities(id), entitiesUrl(id), {}, { limit: 50, enabled: showEntities });

  return (
    <div className={m.stack}>
      {run.isError && <ErrorState error={run.error} onRetry={() => void run.refetch()} />}
      {run.isPending && <Spinner />}
      {run.data && (
        <Panel title={run.data.mode === 'Real' ? t('migration.resultImport') : t('migration.resultPreview')} icon={<DocumentSearch16Regular />}>
          <ResultView result={run.data} showSample={false} />
        </Panel>
      )}

      {/* The card is the region the rows are found by; the table inside only becomes a region of its own when it scrolls. */}
      <Panel title={t('migration.runs.rowsTitle')} icon={<ListBar16Regular />}>
        <Toolbar>
          <FilterField label={t('migration.runs.filterAction')}>
            <Select className={styles.select} value={action} onChange={(_, d) => setAction(d.value)}>
              <option value="">{t('migration.runs.allActions')}</option>
              {ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {t(`migration.actions.${a}`)}
                </option>
              ))}
            </Select>
          </FilterField>
        </Toolbar>
        {rows.isError && <ErrorState error={rows.error} onRetry={() => void rows.refetch()} />}
        {rows.isPending && <Spinner />}
        {!rows.isPending && !rows.isError && rows.items.length === 0 && <EmptyState message={t('migration.runs.noRows')} icon={<Filter24Regular />} />}
        {rows.items.length > 0 && (
          <ScrollTable className={table.inset}>
            <Table className={table.min720} aria-label={t('migration.runs.rowsTitle')}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell className={mergeClasses(table.numberHead, table.lineCol)}>{t('migration.fields.line')}</TableHeaderCell>
                  <TableHeaderCell>{t('migration.fields.action')}</TableHeaderCell>
                  <TableHeaderCell>{t('migration.fields.reason')}</TableHeaderCell>
                  <TableHeaderCell>{t('migration.fields.fields')}</TableHeaderCell>
                  <TableHeaderCell>{t('migration.fields.customer')}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.items.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className={table.number}>{row.line}</TableCell>
                    <TableCell>
                      <StatusText kind="actions" value={row.action} />
                    </TableCell>
                    <TableCell className={table.muted}>
                      {row.reasonCode ? reasonText(t, row.reasonCode) : row.warnings.length === 0 && '—'}
                      {row.warnings.map((code) => (
                        <div key={code}>{reasonText(t, code)}</div>
                      ))}
                    </TableCell>
                    <TableCell className={table.muted}>
                      {row.conflictFields.length > 0 && <div>{t('migration.conflictFields', { fields: row.conflictFields.map((f) => fieldText(t, f)).join(', ') })}</div>}
                      {row.fieldsChanged.length > 0 && <div>{t('migration.filledFields', { fields: row.fieldsChanged.map((f) => fieldText(t, f)).join(', ') })}</div>}
                      {row.conflictFields.length === 0 && row.fieldsChanged.length === 0 && '—'}
                    </TableCell>
                    <TableCell>
                      {row.organizationId ? <AppLink to={`/organizations/${row.organizationId}`}>{t('migration.openCustomer')}</AppLink> : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollTable>
        )}
        <ListFooter shown={rows.items.length} total={rows.total} hasMore={Boolean(rows.hasNextPage)} loading={rows.isFetchingNextPage} onMore={() => void rows.fetchNextPage()} />
      </Panel>

      <Panel title={t('migration.entities.title')} icon={<TaskListSquareLtr16Regular />}>
        <div className={m.form}>
          <p className={m.lead}>{t('migration.entities.readOnly')}</p>
          <Button className={styles.toggle} onClick={() => setShowEntities((v) => !v)} aria-expanded={showEntities}>
            {showEntities ? t('migration.entities.hide') : t('migration.entities.show')}
          </Button>
          {showEntities && (
            <div className={m.stack}>
              {entities.isError && <ErrorState error={entities.error} onRetry={() => void entities.refetch()} />}
              {entities.isPending && <Spinner />}
              {!entities.isPending && !entities.isError && entities.items.length === 0 && <EmptyState message={t('migration.entities.empty')} icon={<TaskListSquareLtr24Regular />} />}
              {entities.items.length > 0 && (
                <ScrollTable className={table.inset}>
                  <Table className={table.min560} aria-label={t('migration.entities.title')}>
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>{t('migration.entities.type')}</TableHeaderCell>
                        <TableHeaderCell>{t('migration.fields.action')}</TableHeaderCell>
                        <TableHeaderCell>{t('migration.fields.fields')}</TableHeaderCell>
                        <TableHeaderCell>{t('migration.entities.record')}</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {entities.items.map((entity) => (
                        <TableRow key={entity.id}>
                          <TableCell>{t(`migration.entities.types.${entity.entityType}`, { defaultValue: entity.entityType })}</TableCell>
                          <TableCell>
                            <StatusText kind="actions" value={entity.action} />
                          </TableCell>
                          <TableCell className={table.muted}>{entity.fields.length > 0 ? entity.fields.map((f) => fieldText(t, f)).join(', ') : '—'}</TableCell>
                          <TableCell>
                            {entity.entityType === 'Organization' ? (
                              <AppLink to={`/organizations/${entity.entityId}`}>{t('migration.openCustomer')}</AppLink>
                            ) : (
                              <span className={table.code} title={entity.entityId}>{`${entity.entityId.slice(0, 8)}…`}</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollTable>
              )}
              <ListFooter shown={entities.items.length} total={entities.total} hasMore={Boolean(entities.hasNextPage)} loading={entities.isFetchingNextPage} onMore={() => void entities.fetchNextPage()} />
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
