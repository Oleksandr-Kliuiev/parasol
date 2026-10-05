import { useState } from 'react';
import {
  Button,
  MessageBar,
  MessageBarBody,
  Select,
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
import { useTranslation } from 'react-i18next';
import { usePagedList } from '../../../api/paging';
import { AppLink } from '../../../shared/components/AppLink';
import { ErrorState } from '../../../shared/components/ErrorState';
import { ListFooter } from '../../../shared/components/ListFooter';
import { formatDateTime } from '../../../shared/utils/format';
import { useCatalogStyles } from '../../catalog/styles';
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
import { ResultView } from './ResultView';
import { StatusText } from './parts';
import { fieldText, reasonText } from './text';

const useStyles = makeStyles({
  filters: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: tokens.spacingHorizontalM, marginBlock: tokens.spacingVerticalM },
  heading: { margin: `${tokens.spacingVerticalL} 0 ${tokens.spacingVerticalS}`, fontSize: tokens.fontSizeBase400, fontWeight: tokens.fontWeightSemibold },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
});

const ACTIONS = ['Created', 'Updated', 'Unchanged', 'Conflict', 'Rejected'] as const;

export function RunsPanel({ runId, onOpen }: { runId: string | null; onOpen: (id: string | null) => void }) {
  return runId ? <RunDetail id={runId} onBack={() => onOpen(null)} /> : <RunsList onOpen={onOpen} />;
}

function RunsList({ onOpen }: { onOpen: (id: string) => void }) {
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const list = usePagedList<MigrationRun>(migrationKeys.runs, runsUrl, {}, { limit: 20, refetchWhile: (run) => run.status === 'Running' });

  if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  if (list.isPending) return <Spinner />;
  if (list.items.length === 0) return <Text>{t('migration.runs.empty')}</Text>;
  return (
    <>
      <div className={catalog.tableWrap} tabIndex={0} role="region" aria-label={t('migration.runs.title')}>
        <Table className={catalog.table} aria-label={t('migration.runs.title')}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>{t('migration.runs.started')}</TableHeaderCell>
              <TableHeaderCell>{t('migration.runs.kind')}</TableHeaderCell>
              <TableHeaderCell>{t('migration.runs.status')}</TableHeaderCell>
              <TableHeaderCell className={catalog.number}>{t('migration.counts.rows')}</TableHeaderCell>
              <TableHeaderCell>{t('migration.runs.outcome')}</TableHeaderCell>
              <TableHeaderCell>{t('migration.runs.details')}</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.items.map((run) => (
              <TableRow key={run.id}>
                <TableCell>{formatDateTime(run.startedAt)}</TableCell>
                <TableCell>{run.mode === 'Real' ? t('migration.runKindReal') : t('migration.runKindPreview')}</TableCell>
                <TableCell>
                  <StatusText kind="status" value={run.status} />
                </TableCell>
                <TableCell className={catalog.number}>{run.rowsTotal}</TableCell>
                <TableCell className={catalog.muted}>
                  {t('migration.runs.counts', {
                    created: run.created,
                    updated: run.updated,
                    unchanged: run.unchanged,
                    conflicts: run.conflicts,
                    rejected: run.rejected,
                  })}
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
      </div>
      <ListFooter shown={list.items.length} total={list.total} hasMore={Boolean(list.hasNextPage)} loading={list.isFetchingNextPage} onMore={() => void list.fetchNextPage()} />
    </>
  );
}

function RunDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const [action, setAction] = useState('');
  const [showEntities, setShowEntities] = useState(false);
  const run = useMigrationRun(id);
  const rows = usePagedList<MigrationOutcome>(migrationKeys.rows(id, action), rowsUrl(id), { action }, { limit: 50 });
  const entities = usePagedList<BatchEntity>(migrationKeys.entities(id), entitiesUrl(id), {}, { limit: 50, enabled: showEntities });

  return (
    <>
      <Button appearance="subtle" onClick={onBack}>
        {t('migration.runs.back')}
      </Button>
      {run.isError && <ErrorState error={run.error} onRetry={() => void run.refetch()} />}
      {run.isPending && <Spinner />}
      {run.data && <ResultView result={run.data} showSample={false} />}

      <h3 className={styles.heading}>{t('migration.runs.rowsTitle')}</h3>
      <div className={styles.filters}>
        <label>
          <span className={styles.muted}>{t('migration.fields.action')}</span>
          <Select value={action} onChange={(_, d) => setAction(d.value)} aria-label={t('migration.runs.filterAction')}>
            <option value="">{t('common.all')}</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {t(`migration.actions.${a}`)}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {rows.isError && <ErrorState error={rows.error} onRetry={() => void rows.refetch()} />}
      {rows.isPending && <Spinner />}
      {!rows.isPending && !rows.isError && rows.items.length === 0 && <Text>{t('migration.runs.noRows')}</Text>}
      {rows.items.length > 0 && (
        <div className={catalog.tableWrap} tabIndex={0} role="region" aria-label={t('migration.runs.rowsTitle')}>
          <Table className={catalog.table} aria-label={t('migration.runs.rowsTitle')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell className={catalog.number}>{t('migration.fields.line')}</TableHeaderCell>
                <TableHeaderCell>{t('migration.fields.action')}</TableHeaderCell>
                <TableHeaderCell>{t('migration.fields.reason')}</TableHeaderCell>
                <TableHeaderCell>{t('migration.fields.fields')}</TableHeaderCell>
                <TableHeaderCell>{t('migration.fields.customer')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.items.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className={catalog.number}>{row.line}</TableCell>
                  <TableCell>
                    <StatusText kind="actions" value={row.action} />
                  </TableCell>
                  <TableCell className={catalog.muted}>
                    {row.reasonCode ? reasonText(t, row.reasonCode) : '—'}
                    {row.warnings.map((code) => (
                      <div key={code}>{reasonText(t, code)}</div>
                    ))}
                  </TableCell>
                  <TableCell className={catalog.muted}>
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
        </div>
      )}
      <ListFooter shown={rows.items.length} total={rows.total} hasMore={Boolean(rows.hasNextPage)} loading={rows.isFetchingNextPage} onMore={() => void rows.fetchNextPage()} />

      <h3 className={styles.heading}>{t('migration.entities.title')}</h3>
      <MessageBar intent="info" style={{ marginBottom: 8 }}>
        <MessageBarBody>{t('migration.entities.readOnly')}</MessageBarBody>
      </MessageBar>
      <Button onClick={() => setShowEntities((v) => !v)} aria-expanded={showEntities}>
        {showEntities ? t('migration.entities.hide') : t('migration.entities.show')}
      </Button>
      {showEntities && (
        <div style={{ marginTop: 12 }}>
          {entities.isError && <ErrorState error={entities.error} onRetry={() => void entities.refetch()} />}
          {entities.isPending && <Spinner />}
          {!entities.isPending && !entities.isError && entities.items.length === 0 && <Text>{t('migration.entities.empty')}</Text>}
          {entities.items.length > 0 && (
            <div className={catalog.tableWrap} tabIndex={0} role="region" aria-label={t('migration.entities.title')}>
              <Table className={catalog.table} aria-label={t('migration.entities.title')}>
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
                      <TableCell className={catalog.muted}>{entity.fields.length > 0 ? entity.fields.map((f) => fieldText(t, f)).join(', ') : '—'}</TableCell>
                      <TableCell>
                        {entity.entityType === 'Organization' ? (
                          <AppLink to={`/organizations/${entity.entityId}`}>{t('migration.openCustomer')}</AppLink>
                        ) : (
                          <span className={catalog.sku}>{entity.entityId}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <ListFooter shown={entities.items.length} total={entities.total} hasMore={Boolean(entities.hasNextPage)} loading={entities.isFetchingNextPage} onMore={() => void entities.fetchNextPage()} />
        </div>
      )}
    </>
  );
}
