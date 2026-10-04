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
  Text,
  makeStyles,
  tokens,
  type BadgeProps,
} from '@fluentui/react-components';
import { Play20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import type { RecurringJob, SyncRun } from '../../api/types';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDateTime } from '../../shared/utils/format';
import { NotFoundPage } from '../errors/NotFoundPage';
import { DeliveryPanel } from '../integrations/DeliveryPanel';
import { OutboundPanel, SystemsPanel } from '../integrations/SystemsPanels';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  tableWrap: { overflowX: 'auto' },
  table: { minWidth: '760px' },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
  nowrap: { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
  message: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere' },
});

const statusColor: Record<SyncRun['status'], BadgeProps['color']> = { Running: 'informative', Succeeded: 'success', Failed: 'danger' };

function duration(run: SyncRun): string {
  if (!run.finishedAt) return '…';
  const seconds = Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export function IntegrationsPage() {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const client = useQueryClient();
  const allowed = useCan(Permissions.integrationsManage);

  const jobs = useQuery({
    queryKey: ['integrations', 'jobs'],
    enabled: allowed,
    queryFn: async ({ signal }) => (await api.get<RecurringJob[]>('/api/v1/integrations/jobs', signal)).data,
  });
  const runs = useQuery({
    queryKey: ['integrations', 'runs'],
    enabled: allowed,
    refetchInterval: 15_000,
    queryFn: async ({ signal }) => (await api.get<SyncRun[]>('/api/v1/integrations/runs?limit=50', signal)).data,
  });
  const trigger = useMutation({
    mutationFn: (jobId: string) => api.post(`/api/v1/integrations/jobs/${encodeURIComponent(jobId)}/trigger`),
    onSuccess: (_, jobId) => {
      notify(t('integrations.triggered', { job: t(`integrations.jobNames.${jobId}`, { defaultValue: jobId }) }));
      void client.invalidateQueries({ queryKey: ['integrations'] });
    },
    onError: (error) => notify(t('errors.generic'), 'error', errorMessage(error, t)),
  });

  if (!allowed) return <NotFoundPage />;
  const jobsUnavailable = jobs.error instanceof ApiError && jobs.error.status === 503;
  const jobName = (id: string) => t(`integrations.jobNames.${id}`, { defaultValue: id });

  return (
    <>
      <PageHeader title={t('integrations.title')} subtitle={t('integrations.subtitle')} />
      <div className={styles.stack}>
        <SystemsPanel />
        <Panel title={t('integrations.jobs')}>
          {jobsUnavailable ? (
            <MessageBar intent="info">
              <MessageBarBody>{t('integrations.unavailable')}</MessageBarBody>
            </MessageBar>
          ) : jobs.error ? (
            <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />
          ) : jobs.data?.length === 0 ? (
            <EmptyState message={t('integrations.noJobs')} />
          ) : (
            <div className={styles.tableWrap}>
              <Table size="small" className={styles.table} aria-label={t('integrations.jobs')}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>{t('integrations.columns.job')}</TableHeaderCell>
                    <TableHeaderCell>{t('integrations.columns.schedule')}</TableHeaderCell>
                    <TableHeaderCell>{t('integrations.columns.next')}</TableHeaderCell>
                    <TableHeaderCell>{t('integrations.columns.last')}</TableHeaderCell>
                    <TableHeaderCell>{t('integrations.columns.state')}</TableHeaderCell>
                    <TableHeaderCell aria-label={t('integrations.runNow')} />
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
                        {job.timeZone ? ` (${job.timeZone})` : ''}
                      </TableCell>
                      <TableCell className={styles.nowrap}>{formatDateTime(job.nextExecution)}</TableCell>
                      <TableCell className={styles.nowrap}>{formatDateTime(job.lastExecution)}</TableCell>
                      <TableCell>{job.lastState}</TableCell>
                      <TableCell>
                        <Button size="small" icon={<Play20Regular />} onClick={() => trigger.mutate(job.id)} disabled={trigger.isPending}>
                          {t('integrations.runNow')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Panel>

        <DeliveryPanel />
        <OutboundPanel />
        <Panel title={t('integrations.runs')}>
          {runs.error ? (
            <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
          ) : runs.data?.length === 0 ? (
            <EmptyState message={t('integrations.noRuns')} />
          ) : (
            <div className={styles.tableWrap}>
              <Table size="small" className={styles.table} aria-label={t('integrations.runs')}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>{t('integrations.columns.job')}</TableHeaderCell>
                    <TableHeaderCell>{t('integrations.columns.started')}</TableHeaderCell>
                    <TableHeaderCell>{t('integrations.columns.duration')}</TableHeaderCell>
                    <TableHeaderCell>{t('integrations.columns.status')}</TableHeaderCell>
                    <TableHeaderCell>{t('integrations.columns.counts')}</TableHeaderCell>
                    <TableHeaderCell>{t('integrations.columns.message')}</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.data?.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell>{jobName(run.job)}</TableCell>
                      <TableCell className={styles.nowrap}>{formatDateTime(run.startedAt)}</TableCell>
                      <TableCell className={styles.nowrap}>{duration(run)}</TableCell>
                      <TableCell>
                        <Badge appearance="tint" color={statusColor[run.status]}>
                          {t(`integrations.status.${run.status}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className={styles.nowrap}>
                        {run.read} / {run.changed} / {run.failed}
                      </TableCell>
                      <TableCell className={styles.message}>{run.message}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
