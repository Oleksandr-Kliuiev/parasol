import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  MessageBar,
  MessageBarBody,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Spinner,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
  type BadgeProps,
} from '@fluentui/react-components';
import {
  CalendarClock16Regular,
  CalendarClock24Regular,
  History16Regular,
  History24Regular,
  LinkDismiss16Regular,
  Pause16Regular,
  Play16Regular,
  PlugConnected16Regular,
  PlugDisconnected16Regular,
} from '@fluentui/react-icons';
import { h } from '../../app/hearth';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import { usePagedList } from '../../api/paging';
import type { RecurringJob, SyncRun } from '../../api/types';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { ListFooter } from '../../shared/components/ListFooter';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDateTime, formatNumber } from '../../shared/utils/format';
import { StatGrid, StatTile } from '../../shared/components/KpiTile';
import { useIntegrationStatus } from '../integrations/api';
import { useTableCardStyles } from './tableCard';
import { ForbiddenPage } from '../errors/ForbiddenPage';
import { MonitoringPanel } from '../integrations/MonitoringPanel';
import { DeliveryPanel } from '../integrations/DeliveryPanel';
import { OutboundPanel, SystemsPanel } from '../integrations/SystemsPanels';
import { ScrollTable } from '../../shared/components/ScrollTable';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: '16px', minWidth: 0 },
  // Four figures that share the row instead of leaving an empty fifth column.
  stats: { marginBottom: 0, gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))' },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: '12px', color: h.muted },
  // A cron line ("5-59/10 * * * *") and its time zone under it: an equal share of a fixed-layout table is too narrow for either.
  scheduleCol: { width: '144px' },
  zone: { display: 'block' },
  message: { color: h.muted, fontSize: '13px', lineHeight: '18px', overflowWrap: 'anywhere' },
});

const statusColor: Record<string, BadgeProps['color']> = { Running: 'informative', Processing: 'informative', Succeeded: 'success', Failed: 'danger', Skipped: 'subtle' };

function duration(run: SyncRun): string {
  if (!run.finishedAt) return '…';
  const seconds = Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export function IntegrationsPage() {
  const styles = useStyles();
  const table = useTableCardStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const client = useQueryClient();
  const allowed = useCan(Permissions.integrationsManage);

  const jobs = useQuery({
    queryKey: ['integrations', 'jobs'],
    enabled: allowed,
    queryFn: async ({ signal }) => (await api.get<RecurringJob[]>('/api/v1/integrations/jobs', signal)).data,
  });
  // The same query as the system cards below (one request): the figures above them.
  const status = useIntegrationStatus(allowed);
  const runs = usePagedList<SyncRun>(['integrations', 'runs'], '/api/v1/integrations/runs', {}, { enabled: allowed, refetchInterval: 15_000 });
  const trigger = useMutation({
    mutationFn: (jobId: string) => api.post(`/api/v1/integrations/jobs/${encodeURIComponent(jobId)}/trigger`),
    onSuccess: (_, jobId) => {
      notify(t('integrations.triggered', { job: t(`integrations.jobNames.${jobId}`, { defaultValue: jobId }) }));
      void client.invalidateQueries({ queryKey: ['integrations'] });
    },
    onError: (error) => notify(t('errors.generic'), 'error', errorMessage(error, t)),
  });

  if (!allowed) return <ForbiddenPage />;
  const jobsUnavailable = jobs.error instanceof ApiError && jobs.error.status === 503;
  const jobName = (id: string) => t(`integrations.jobNames.${id}`, { defaultValue: id });
  const systems = status.data ?? [];
  const count = (test: (s: (typeof systems)[number]) => boolean) => formatNumber(systems.filter(test).length, 0);

  return (
    <>
      <PageHeader title={t('integrations.title')} subtitle={t('integrations.subtitle')} />
      <div className={styles.stack}>
        {systems.length > 0 && (
          <StatGrid label={t('systemsPanel.title')} className={styles.stats}>
            <StatTile icon={<PlugConnected16Regular />} tone="spruce" label={t('systemsPanel.enabled')} value={count((s) => s.enabled)} />
            <StatTile icon={<PlugDisconnected16Regular />} label={t('systemsPanel.disabled')} value={count((s) => !s.enabled)} />
            <StatTile icon={<Pause16Regular />} tone="saffron" label={t('systemsPanel.paused')} value={count((s) => s.paused)} />
            <StatTile
              icon={<LinkDismiss16Regular />}
              tone="iris"
              label={t('mappings.state.Unlinked')}
              value={formatNumber(systems.reduce((sum, s) => sum + s.unlinked, 0), 0)}
            />
          </StatGrid>
        )}
        <SystemsPanel />
        <MonitoringPanel />
        <Panel title={t('integrations.jobs')} icon={<CalendarClock16Regular />}>
          {jobsUnavailable ? (
            <MessageBar intent="info">
              <MessageBarBody>{t('integrations.unavailable')}</MessageBarBody>
            </MessageBar>
          ) : jobs.error ? (
            <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />
          ) : jobs.isPending ? (
            <Spinner size="small" label={t('common.loading')} />
          ) : jobs.data?.length === 0 ? (
            <EmptyState message={t('integrations.noJobs')} icon={<CalendarClock24Regular />} />
          ) : (
            <>
            {/* A job that ran is not a system that was read: a sync that skipped a switched-off system still ran. */}
            <Text block className={styles.message}>{t('integrations.jobsNote')}</Text>
            <ScrollTable className={table.inset}>
              <Table size="small" className={mergeClasses(table.min880, table.roomy)} aria-label={t('integrations.jobs')}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>{t('integrations.columns.job')}</TableHeaderCell>
                    <TableHeaderCell className={styles.scheduleCol}>{t('integrations.columns.schedule')}</TableHeaderCell>
                    <TableHeaderCell className={table.dateTimeCol}>{t('integrations.columns.next')}</TableHeaderCell>
                    <TableHeaderCell className={table.dateTimeCol}>{t('integrations.columns.last')}</TableHeaderCell>
                    <TableHeaderCell>{t('integrations.columns.state')}</TableHeaderCell>
                    <TableHeaderCell className={table.actionCol} aria-label={t('integrations.runNow')} />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.data?.map((job) => (
                    <TableRow key={job.id}>
                      <TableCell>
                        <Text weight="semibold">{jobName(job.id)}</Text>
                        {job.error && <Text block className={styles.message}>{job.error}</Text>}
                      </TableCell>
                      <TableCell className={styles.mono}>
                        {job.cron}
                        {job.timeZone && <span className={styles.zone}>{job.timeZone}</span>}
                      </TableCell>
                      <TableCell className={table.nowrap}>{formatDateTime(job.nextExecution)}</TableCell>
                      <TableCell className={table.nowrap}>{formatDateTime(job.lastExecution)}</TableCell>
                      <TableCell>
                        {job.lastState ? (
                          <Badge appearance="tint" color={statusColor[job.lastState] ?? 'subtle'}>
                            {t(`integrations.jobStatus.${job.lastState}`, { defaultValue: job.lastState })}
                          </Badge>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell>
                        <Button size="small" appearance="subtle" icon={<Play16Regular />} onClick={() => trigger.mutate(job.id)} disabled={trigger.isPending}>
                          {t('integrations.runNow')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollTable>
            </>
          )}
        </Panel>

        <DeliveryPanel />
        <OutboundPanel />
        <Panel title={t('integrations.runs')} icon={<History16Regular />}>
          {runs.error ? (
            <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
          ) : runs.isPending ? (
            <Spinner size="small" label={t('common.loading')} />
          ) : runs.items.length === 0 ? (
            <EmptyState message={t('integrations.noRuns')} icon={<History24Regular />} />
          ) : (
            <ScrollTable className={table.inset}>
              <Table size="small" className={mergeClasses(table.min800, table.roomy)} aria-label={t('integrations.runs')}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>{t('integrations.columns.job')}</TableHeaderCell>
                    <TableHeaderCell className={table.dateTimeCol}>{t('integrations.columns.started')}</TableHeaderCell>
                    <TableHeaderCell>{t('integrations.columns.duration')}</TableHeaderCell>
                    <TableHeaderCell>{t('integrations.columns.status')}</TableHeaderCell>
                    <TableHeaderCell className={table.numberHead}>{t('integrations.columns.counts')}</TableHeaderCell>
                    <TableHeaderCell>{t('integrations.columns.message')}</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.items.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell>{jobName(run.job)}</TableCell>
                      <TableCell className={table.nowrap}>{formatDateTime(run.startedAt)}</TableCell>
                      <TableCell className={table.nowrap}>{duration(run)}</TableCell>
                      <TableCell>
                        <Badge appearance="tint" color={statusColor[run.status]}>
                          {t(`integrations.status.${run.status}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className={mergeClasses(table.nowrap, table.number)}>
                        {run.read} / {run.changed} / {run.failed}
                      </TableCell>
                      <TableCell className={styles.message}>{run.message}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <ListFooter shown={runs.items.length} total={runs.total} hasMore={runs.hasNextPage} loading={runs.isFetchingNextPage} onMore={() => void runs.fetchNextPage()} />
            </ScrollTable>
          )}
        </Panel>
      </div>
    </>
  );
}
