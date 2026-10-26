import { useCallback, useRef, useState, type ReactElement } from 'react';
import { Badge, Button, MessageBar, MessageBarBody, MessageBarTitle, Spinner, Text, makeStyles, type BadgeProps } from '@fluentui/react-components';
import {
  ArrowSync16Regular, BuildingGovernment16Regular, KeyMultiple16Regular, PeopleTeam16Regular, Receipt16Regular, Settings16Regular, Wrench16Regular,
} from '@fluentui/react-icons';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api, ApiError } from '../../api/client';
import { Permissions, useCurrentUser } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { h } from '../../app/hearth';
import { Panel } from '../../shared/components/Panel';
import { PageHeader } from '../../shared/components/PageHeader';
import { formatDateTime, formatReadAt, formatRelative } from '../../shared/utils/format';
import { useFlushStyles } from '../billing/flushStyles';
import { RecordRow, RowMeta } from '../billing/RecordRow';
import { ForbiddenPage } from '../errors/ForbiddenPage';
import {
  failedSinceRead, parseConnectionStatus, type ConnectionGap, type ConnectionIntegration, type ConnectionJob, type ConnectionStatusView,
} from './connectionStatusContract';
import { formatSpan, jobName, systemName } from './labels';

const useStyles = makeStyles({
  stack: { display: 'grid', gap: '16px', minWidth: 0, overflowWrap: 'anywhere' },
  // The cards side by side, as the integration cards of the reference: two per row on a desktop, one on a phone.
  cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(420px, 100%), 1fr))', gap: '16px', alignItems: 'start', minWidth: 0 },
  checked: { color: h.muted, fontSize: '13px', lineHeight: '20px', fontVariantNumeric: 'tabular-nums' },
  gaps: { margin: 0, marginTop: '4px', paddingLeft: '18px', display: 'grid', gap: '2px' },
  // The way to act on the gaps, in the box that names them; a 24 px hit box (WCAG 2.5.8).
  act: { display: 'inline-flex', alignItems: 'center', minHeight: '24px', marginTop: '6px' },
  // A line inside a flush card keeps the card's side padding and a bottom edge.
  pad: { margin: 0, paddingLeft: '20px', paddingRight: '20px', paddingBottom: '16px', color: h.muted, fontSize: '13px', lineHeight: '20px',
    '@media (max-width: 600px)': { paddingLeft: '16px', paddingRight: '16px' } },
  bad: { color: h.emberT },
  note: { color: h.muted, fontSize: '13px', lineHeight: '20px', maxWidth: '75ch' },
});

const stateColor: Record<string, BadgeProps['color']> = { on: 'success', gaps: 'warning', paused: 'warning', off: 'subtle' };
const freshnessColor: Record<ConnectionJob['freshness'], BadgeProps['color']> = { Fresh: 'success', Stale: 'warning', Never: 'danger', Paused: 'warning', Disabled: 'subtle' };
const workerColor: Record<string, BadgeProps['color']> = { Current: 'success', Late: 'warning', Missing: 'danger' };
const icons: Record<string, ReactElement> = {
  atera: <Wrench16Regular />, poweroffice: <Receipt16Regular />, partnercenter: <KeyMultiple16Regular />, 'microsoft-graph': <PeopleTeam16Regular />,
  brreg: <BuildingGovernment16Regular />,
};

export function ConnectionReadinessPage() {
  const user = useCurrentUser();
  if (!user.permissions.includes(Permissions.integrationsManage)) return <ForbiddenPage />;
  const permissionsKey = JSON.stringify([...user.permissions].sort());
  return <ConnectionStatus key={`${user.id}:${permissionsKey}`} employeeId={user.id} permissionsKey={permissionsKey} />;
}

/** The CRM's own state of its integrations (M38): read when the page opens and on Refresh, never by polling a provider. */
function ConnectionStatus({ employeeId, permissionsKey }: { employeeId: string; permissionsKey: string }) {
  const { t } = useTranslation(); const styles = useStyles(); const refreshing = useRef(false);
  const [pending, setPending] = useState(false);
  const query = useQuery({
    queryKey: ['integrations', 'connections', employeeId, permissionsKey],
    queryFn: async ({ signal }) => parseConnectionStatus((await api.get<unknown>('/api/v1/integrations/connections', signal)).data),
    retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const { refetch } = query;
  const refresh = useCallback(() => {
    if (refreshing.current) return; refreshing.current = true; setPending(true);
    void refetch().finally(() => { refreshing.current = false; setPending(false); });
  }, [refetch]);
  const checking = pending || query.isFetching; const view = !checking && !query.isError ? query.data : undefined;
  const error = query.isError ? query.error instanceof ApiError && query.error.status === 403 ? 'FORBIDDEN' : 'REQUEST_FAILED'
    : view === null ? 'INVALID_RESPONSE' : null;
  return <>
    <PageHeader title={t('connectionStatus.title')} subtitle={t('connectionStatus.subtitle')}
      meta={view ? <Text className={styles.checked}>{t('connectionStatus.checkedAt', { time: formatReadAt(view.checkedAt) })}</Text> : undefined}
      actions={<Button disabled={checking} disabledFocusable={checking} onClick={refresh}>{t('connectionStatus.refresh')}</Button>} />
    <div className={styles.stack}>
      {checking && <Spinner label={t('common.loading')} />}
      {error && <MessageBar intent="warning"><MessageBarBody><Text role="status">{t(`connectionStatus.error.${error}`)}</Text></MessageBarBody></MessageBar>}
      {view && <>
        <Summary view={view} />
        {/* The worker that runs every job closes the list: the status line above already says when it is late. */}
        <div className={styles.cards}>
          {view.integrations.map((integration) => <IntegrationCard key={integration.system} integration={integration} />)}
          <WorkerCard view={view} />
        </div>
        <Text className={styles.note}>
          {t('connectionStatus.administrationNote')} <AppLink to="/admin/integrations">{t('connectionStatus.openAdministration')}</AppLink>
        </Text>
      </>}
    </div>
  </>;
}

/** One status line: green only for a complete picture, otherwise every gap in the same box with the way to act on them (UX 2026). */
function Summary({ view }: { view: ConnectionStatusView }) {
  const { t } = useTranslation(); const styles = useStyles();
  if (view.status === 'Unavailable') {
    return <MessageBar intent="error" layout="multiline"><MessageBarBody><Text role="status">{t('connectionStatus.unavailable')}</Text></MessageBarBody></MessageBar>;
  }
  if (view.status === 'Ready') {
    return <MessageBar intent="success" layout="multiline"><MessageBarBody><Text role="status">{t('connectionStatus.ready')}</Text></MessageBarBody></MessageBar>;
  }
  return <MessageBar intent="warning" layout="multiline"><MessageBarBody>
    <MessageBarTitle>{t('connectionStatus.gapsTitle', { count: view.gaps.length })}</MessageBarTitle>
    <ul className={styles.gaps}>{view.gaps.map((gap, index) => <li key={`${gap.kind}:${gap.system ?? gap.component}:${gap.job ?? index}`}>{gapText(t, gap, view)}</li>)}</ul>
    <AppLink className={styles.act} to="/admin/integrations">{t('connectionStatus.openAdministration')}</AppLink>
  </MessageBarBody></MessageBar>;
}

function gapText(t: TFunction, gap: ConnectionGap, view: ConnectionStatusView) {
  const job = view.integrations.find((i) => i.system === gap.system)?.state?.jobs.find((j) => j.job === gap.job);
  const component = view.worker?.components.find((c) => c.component === gap.component);
  return t(`connectionStatus.gaps.${gap.kind}`, {
    job: gap.job ? jobName(t, gap.job) : '', system: gap.system ? systemName(t, gap.system) : '', count: gap.count ?? 0,
    component: gap.component ? t(`connectionStatus.worker.components.${gap.component}`, { defaultValue: gap.component }) : '',
    age: formatRelative(gap.kind === 'Failed' ? job?.lastFailedAt : gap.kind === 'Stale' ? job?.lastSucceededAt : component?.beatAt),
    limit: job ? formatSpan(t, job.thresholdMinutes) : '',
  });
}

/** The two parts of the background service that must keep beating, with the age of their last sign of life. */
function WorkerCard({ view }: { view: ConnectionStatusView }) {
  const { t } = useTranslation(); const styles = useStyles(); const flush = useFlushStyles();
  return <Panel title={t('connectionStatus.worker.title')} icon={<ArrowSync16Regular />} flush className={flush.panel}>
    {view.worker ? <>
      <Text block className={styles.pad}>{t('connectionStatus.worker.note', { limit: formatSpan(t, Math.max(1, Math.round(view.worker.staleAfterSeconds / 60))) })}</Text>
      <ul className={flush.list}>{view.worker.components.map((part) => <RecordRow key={part.component}
        title={t(`connectionStatus.worker.components.${part.component}`, { defaultValue: part.component })}
        meta={<RowMeta>{part.beatAt ? <>{t('connectionStatus.worker.beat')}{' '}<When at={part.beatAt} /></> : t('connectionStatus.worker.noBeat')}</RowMeta>}
        end={<Badge appearance="tint" color={workerColor[part.state]}>{t(`connectionStatus.worker.state.${part.state}`)}</Badge>} />)}</ul>
    </> : <Text block className={styles.pad}>{t('connectionStatus.unreadState')}</Text>}
  </Panel>;
}

function IntegrationCard({ integration }: { integration: ConnectionIntegration }) {
  const { t } = useTranslation(); const styles = useStyles(); const flush = useFlushStyles();
  const state = integration.state;
  const shape = !integration.enabled ? 'off' : state?.paused ? 'paused'
    : state && (state.failedOutbound > 0 || state.jobs.some((job) => job.freshness !== 'Fresh' || failedSinceRead(job))) ? 'gaps' : 'on';
  return <Panel title={systemName(t, integration.system)} icon={icons[integration.system] ?? <Settings16Regular />} flush className={flush.panel}
    actions={state && <Badge appearance="tint" color={stateColor[shape]}>{t(`connectionStatus.state.${shape}`)}</Badge>}>
    {!state ? <Text block className={styles.pad}>{t('connectionStatus.unreadState')}</Text>
      : !integration.enabled ? <Text block className={styles.pad}>{t('connectionStatus.off')}</Text> : <>
        {(integration.writeEnabled !== null || state.failedOutbound > 0) && <Text block className={styles.pad}>
          {integration.writeEnabled !== null
            && t(integration.writeEnabled ? 'connectionStatus.writesOn' : 'connectionStatus.writesOff', { system: systemName(t, integration.system) })}
          {integration.writeEnabled !== null && state.failedOutbound > 0 && ' '}
          {state.failedOutbound > 0 && <span className={styles.bad}>{t('connectionStatus.failedOutbound', { count: state.failedOutbound })}</span>}
        </Text>}
        <ul className={flush.list}>{state.jobs.map((job) => <JobRow key={job.job} job={job} />)}</ul>
      </>}
  </Panel>;
}

function JobRow({ job }: { job: ConnectionJob }) {
  const { t } = useTranslation(); const styles = useStyles();
  const failed = failedSinceRead(job);
  return <RecordRow
    title={jobName(t, job.job)}
    meta={<>
      <RowMeta>
        {job.lastSucceededAt ? <>{t('connectionStatus.lastRead')}{' '}<When at={job.lastSucceededAt} /></> : t('connectionStatus.notRead')}
        {` · ${t('connectionStatus.limit', { limit: formatSpan(t, job.thresholdMinutes) })}`}
      </RowMeta>
      {failed && <RowMeta className={styles.bad}>{t('connectionStatus.lastFailed')} <When at={job.lastFailedAt!} /></RowMeta>}
    </>}
    end={<Badge appearance="tint" color={freshnessColor[job.freshness]}>{t(`connectionStatus.freshness.${job.freshness}`)}</Badge>} />;
}

/** An age with the exact moment for whoever asks (UX 2026: lists show ages). */
function When({ at }: { at: string }) {
  return <time dateTime={at} title={formatDateTime(at)}>{formatRelative(at)}</time>;
}
