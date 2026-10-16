import { useCallback, useRef, useState } from 'react';
import { Badge, Button, MessageBar, MessageBarBody, Spinner, Text, makeStyles, tokens } from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import { Permissions, useCurrentUser } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { Panel, DetailList } from '../../shared/components/Panel';
import { PageHeader } from '../../shared/components/PageHeader';
import { formatDateTime } from '../../shared/utils/format';
import { NotFoundPage } from '../errors/NotFoundPage';
import { parseLocalReadiness, type ReadinessAuthority, type ReadinessMappings, type ReadinessProvider } from './localReadinessContract';

const useStyles = makeStyles({ stack: { display: 'grid', gap: tokens.spacingVerticalL, minWidth: 0, overflowWrap: 'anywhere' } });

export function ConnectionReadinessPage() {
  const user = useCurrentUser(); const authority = { atlasRead: user.permissions.includes(Permissions.parasolAtlasRead),
    integrationsManage: user.permissions.includes(Permissions.integrationsManage), customersRead: user.permissions.includes(Permissions.customersRead) };
  if (!authority.atlasRead && !authority.integrationsManage) return <NotFoundPage />;
  const permissionsKey = JSON.stringify([...user.permissions].sort());
  return <PersonalReadiness key={`${user.id}:${permissionsKey}`} employeeId={user.id} permissionsKey={permissionsKey} authority={authority} />;
}

function PersonalReadiness({ employeeId, permissionsKey, authority }: { employeeId: string; permissionsKey: string; authority: ReadinessAuthority }) {
  const { t } = useTranslation(); const styles = useStyles(); const refreshing = useRef(false);
  const [pending, setPending] = useState(false);
  const query = useQuery({
    queryKey: ['parasol', 'local-readiness', employeeId, permissionsKey],
    queryFn: async ({ signal }) => parseLocalReadiness((await api.get<unknown>('/api/v1/parasol/local-readiness', signal)).data, authority),
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
    <PageHeader title={t('readiness.title')} subtitle={t('readiness.subtitle')}
      actions={<Button disabled={checking} disabledFocusable={checking} onClick={refresh}>{t('readiness.refresh')}</Button>} />
    <div className={styles.stack}>
      <MessageBar intent="info" layout="multiline"><MessageBarBody>{t('readiness.notChecked')}</MessageBarBody></MessageBar>
      {checking && <Spinner label={t('common.loading')} />}
      {error && <MessageBar intent="warning"><MessageBarBody><Text role="status">{t(`readiness.error.${error}`)}</Text></MessageBarBody></MessageBar>}
      {view && <>
        <Text block>{t('readiness.checkedAt', { time: formatDateTime(view.checkedAt) })}</Text>
        {view.status === 'PARTIAL' && <MessageBar intent="warning"><MessageBarBody>{t('readiness.partial')}</MessageBarBody></MessageBar>}
        {view.personalAtlas && <Panel title={t('readiness.personalTitle')}>
          <Badge color="informative" appearance="outline">{t(`readiness.personal.${view.personalAtlas.status}`)}</Badge>
          <Text block>{t('readiness.personalNote')}</Text>
        </Panel>}
        {view.admin && <>
          <Panel title={t('readiness.adminTitle')}>
            <Text block>{t('readiness.workerNote')}</Text>
            <Text block>{t('readiness.authMode')}: {t(`readiness.auth.${view.admin.authMode}`)}</Text>
            <Text block>{t('readiness.entraNote')}</Text>
            <AppLink to="/admin/integrations">{t('readiness.openIntegrations')}</AppLink>
          </Panel>
          <ProviderReadiness title="Atera" value={view.admin.atera} />
          <ProviderReadiness title="PowerOffice" value={view.admin.powerOffice} />
          <Panel title="Microsoft Graph">
            <DetailList items={(['enabled', 'calendarEnabled', 'mailEnabled', 'sharePointEnabled', 'teamsEnabled'] as const)
              .map(key => ({ label: t(`readiness.graph.${key}`), value: <LocalFlag enabled={view.admin!.microsoftGraph[key]} /> }))} />
            <Text block>{t('readiness.graphNote')}</Text>
            {view.admin.microsoftGraph.stored ? <DetailList items={[
              { label: t('readiness.directorySavedAt'), value: formatDateTime(view.admin.microsoftGraph.stored.directoryLastSucceededAt) },
              { label: t('readiness.rolesSavedAt'), value: formatDateTime(view.admin.microsoftGraph.stored.roleLastSucceededAt) },
            ]} /> : <Text block>{t('readiness.storedUnavailable')}</Text>}
          </Panel>
          <Panel title="Huntress"><Badge color="informative" appearance="outline">{t('readiness.huntressUnknown')}</Badge><Text block>{t('readiness.huntressNote')}</Text></Panel>
          {view.admin.atlasMappings && <MappingReadiness value={view.admin.atlasMappings} />}
        </>}
      </>}
    </div>
  </>;
}

function LocalFlag({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation(); return <Badge color="informative" appearance="outline">{t(enabled ? 'readiness.enabled' : 'readiness.disabled')}</Badge>;
}

function ProviderReadiness({ title, value }: { title: string; value: ReadinessProvider }) {
  const { t } = useTranslation(); const stored = value.stored;
  return <Panel title={title}>
    <DetailList items={[
      { label: t('readiness.enabledFlag'), value: <LocalFlag enabled={value.enabled} /> },
      { label: t('readiness.writeFlag'), value: <LocalFlag enabled={value.writeEnabled} /> },
    ]} />
    <Text block>{t('readiness.flagNote')}</Text>
    {stored ? <DetailList items={[
      { label: t('readiness.savedPause'), value: t(stored.paused ? 'common.yes' : 'common.no') },
      { label: t('readiness.savedSuccess'), value: formatDateTime(stored.lastSucceededAt) },
      ...(['records', 'unlinkedRecords', 'pendingOutbound', 'failedOutbound'] as const).map(key => ({ label: t(`readiness.stored.${key}`), value: String(stored[key]) })),
    ]} /> : <Text block>{t('readiness.storedUnavailable')}</Text>}
  </Panel>;
}

function MappingReadiness({ value: m }: { value: ReadinessMappings }) {
  const { t } = useTranslation();
  return <Panel title={t('readiness.mappingTitle')}>
    <Badge color="informative" appearance="outline">{t(`readiness.mappingStatus.${m.status}`)}</Badge>
    <Text block>{t(`readiness.review.${m.reviewStatus}`)}</Text><Text block>{t('readiness.mappingNote')}</Text>
    {m.coverage && m.counts && <>
      <Text block>{t('readiness.mappingCoverage', { examined: m.coverage.examinedLinks, stored: m.coverage.storedLinks, limit: m.limit })}</Text>
      <DetailList items={[
        { label: t('readiness.omittedLinks'), value: String(m.coverage.omittedLinks) },
        { label: t('readiness.unlinkedReferences'), value: String(m.coverage.unlinkedStoredReferences) },
        ...(['validLinks', 'invalidIdentities', 'missingReferences', 'goneReferences', 'invalidReferences', 'unavailableCustomers'] as const)
          .map(key => ({ label: t(`readiness.mappingCounts.${key}`), value: String(m.counts![key]) })),
      ]} />
    </>}
    <AppLink to="/admin/mappings/atlas">{t('readiness.openMappings')}</AppLink>
  </Panel>;
}
