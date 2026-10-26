import { useCallback, useRef, useState, type ReactElement } from 'react';
import { Badge, Button, MessageBar, MessageBarBody, Spinner, Text, makeStyles, type BadgeProps } from '@fluentui/react-components';
import { Cloud16Regular, LinkMultiple16Regular, Person16Regular, Receipt16Regular, Settings16Regular, ShieldCheckmark16Regular,
  Wrench16Regular } from '@fluentui/react-icons';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import { Permissions, useCurrentUser } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { h } from '../../app/hearth';
import { Panel, DetailList, FactGrid } from '../../shared/components/Panel';
import { PageHeader } from '../../shared/components/PageHeader';
import { formatDateTime } from '../../shared/utils/format';
import { ForbiddenPage } from '../errors/ForbiddenPage';
import { parseLocalReadiness, type ReadinessAuthority, type ReadinessMappings, type ReadinessProvider } from './localReadinessContract';

const useStyles = makeStyles({
  stack: { display: 'grid', gap: '16px', minWidth: 0, overflowWrap: 'anywhere' },
  // The cards side by side, as the integration cards of the reference: two per row on a desktop, one on a phone.
  cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(420px, 100%), 1fr))', gap: '16px', alignItems: 'start', minWidth: 0 },
  body: { display: 'grid', gap: '14px', minWidth: 0 },
  // The one explaining line of a card, under its title.
  lead: { marginTop: '-6px', color: h.muted, fontSize: '13px', lineHeight: '20px', maxWidth: '75ch' },
  note: { color: h.muted, fontSize: '13px', lineHeight: '20px', maxWidth: '75ch' },
  checked: { color: h.muted, fontSize: '13px', lineHeight: '20px', fontVariantNumeric: 'tabular-nums' },
  review: { fontSize: '14px', lineHeight: '20px', maxWidth: '75ch' },
  strong: { fontWeight: 600 },
  // Four stored counts two by two; eight mapping counts four by two (two by four on a phone): no tile left alone in a row.
  facts: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  mappingFacts: { gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', '@media (max-width: 760px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' } },
});

// None of these states is a health result: present or enabled reads as information, never as a green light.
const tone = (good: boolean): BadgeProps['color'] => (good ? 'informative' : 'subtle');

export function ConnectionReadinessPage() {
  const user = useCurrentUser(); const authority = { atlasRead: user.permissions.includes(Permissions.parasolAtlasRead),
    integrationsManage: user.permissions.includes(Permissions.integrationsManage), customersRead: user.permissions.includes(Permissions.customersRead) };
  if (!authority.atlasRead && !authority.integrationsManage) return <ForbiddenPage />;
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
      meta={view ? <Text className={styles.checked}>{t('readiness.checkedAt', { time: formatDateTime(view.checkedAt) })}</Text> : undefined}
      actions={<Button disabled={checking} disabledFocusable={checking} onClick={refresh}>{t('readiness.refresh')}</Button>} />
    <div className={styles.stack}>
      <MessageBar intent="info" layout="multiline"><MessageBarBody>{t('readiness.notChecked')}</MessageBarBody></MessageBar>
      {checking && <Spinner label={t('common.loading')} />}
      {error && <MessageBar intent="warning"><MessageBarBody><Text role="status">{t(`readiness.error.${error}`)}</Text></MessageBarBody></MessageBar>}
      {view && <>
        {view.status === 'PARTIAL' && <MessageBar intent="warning" layout="multiline"><MessageBarBody>{t('readiness.partial')}</MessageBarBody></MessageBar>}
        <div className={styles.cards}>
          {view.personalAtlas && <Panel title={t('readiness.personalTitle')} icon={<Person16Regular />}
            actions={<Badge appearance="tint" color={view.personalAtlas.status === 'PERSONAL_ENTRY_PRESENT' ? 'informative' : view.personalAtlas.status === 'DISABLED' ? 'subtle' : 'warning'}>
              {t(`readiness.personal.${view.personalAtlas.status}`)}
            </Badge>}>
            <Text block className={styles.lead}>{t('readiness.personalNote')}</Text>
          </Panel>}
          {view.admin && <Panel title={t('readiness.adminTitle')} icon={<Settings16Regular />}>
            <div className={styles.body}>
              <DetailList items={[{ label: t('readiness.authMode'), value: t(`readiness.auth.${view.admin.authMode}`) }]} />
              <div>
                <Text block className={styles.note}>{t('readiness.workerNote')}</Text>
                <Text block className={styles.note}>{t('readiness.entraNote')}</Text>
              </div>
              <div><AppLink to="/admin/integrations">{t('readiness.openIntegrations')}</AppLink></div>
            </div>
          </Panel>}
          {view.admin && <>
            <ProviderReadiness title="Atera" icon={<Wrench16Regular />} value={view.admin.atera} />
            <ProviderReadiness title="PowerOffice" icon={<Receipt16Regular />} value={view.admin.powerOffice} />
            <Panel title="Microsoft Graph" icon={<Cloud16Regular />}>
              <div className={styles.body}>
                <Text block className={styles.lead}>{t('readiness.graphNote')}</Text>
                <DetailList items={[
                  ...(['enabled', 'calendarEnabled', 'mailEnabled', 'sharePointEnabled', 'teamsEnabled'] as const)
                    .map(key => ({ label: t(`readiness.graph.${key}`), value: <LocalFlag enabled={view.admin!.microsoftGraph[key]} /> })),
                  ...(view.admin.microsoftGraph.stored ? [
                    { label: t('readiness.directorySavedAt'), value: formatDateTime(view.admin.microsoftGraph.stored.directoryLastSucceededAt) },
                    { label: t('readiness.rolesSavedAt'), value: formatDateTime(view.admin.microsoftGraph.stored.roleLastSucceededAt) },
                  ] : []),
                ]} />
                {!view.admin.microsoftGraph.stored && <Text block className={styles.note}>{t('readiness.storedUnavailable')}</Text>}
              </div>
            </Panel>
            <Panel title="Huntress" icon={<ShieldCheckmark16Regular />}
              actions={<Badge appearance="tint" color="subtle">{t('readiness.huntressUnknown')}</Badge>}>
              <Text block className={styles.lead}>{t('readiness.huntressNote')}</Text>
            </Panel>
          </>}
        </div>
        {view.admin?.atlasMappings && <MappingReadiness value={view.admin.atlasMappings} />}
      </>}
    </div>
  </>;
}

function LocalFlag({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  return <Badge appearance="tint" color={tone(enabled)}>{t(enabled ? 'readiness.enabled' : 'readiness.disabled')}</Badge>;
}

function ProviderReadiness({ title, icon, value }: { title: string; icon: ReactElement; value: ReadinessProvider }) {
  const { t } = useTranslation(); const styles = useStyles(); const stored = value.stored;
  return <Panel title={title} icon={icon}>
    <div className={styles.body}>
      <Text block className={styles.lead}>{t('readiness.flagNote')}</Text>
      <DetailList items={[
        { label: t('readiness.enabledFlag'), value: <LocalFlag enabled={value.enabled} /> },
        { label: t('readiness.writeFlag'), value: <LocalFlag enabled={value.writeEnabled} /> },
        ...(stored ? [
          { label: t('readiness.savedPause'), value: t(stored.paused ? 'common.yes' : 'common.no') },
          { label: t('readiness.savedSuccess'), value: formatDateTime(stored.lastSucceededAt) },
        ] : []),
      ]} />
      {stored ? <FactGrid className={styles.facts} items={(['records', 'unlinkedRecords', 'pendingOutbound', 'failedOutbound'] as const)
        .map(key => ({ label: t(`readiness.stored.${key}`), value: String(stored[key]) }))} />
        : <Text block className={styles.note}>{t('readiness.storedUnavailable')}</Text>}
    </div>
  </Panel>;
}

const mappingTone: Record<ReadinessMappings['status'], BadgeProps['color']> = {
  CHECKED: 'informative', INCOMPLETE: 'warning', CHANGED: 'warning', UNAVAILABLE: 'subtle',
};

function MappingReadiness({ value: m }: { value: ReadinessMappings }) {
  const { t } = useTranslation(); const styles = useStyles();
  return <Panel title={t('readiness.mappingTitle')} icon={<LinkMultiple16Regular />}
    actions={<Badge appearance="tint" color={mappingTone[m.status]}>{t(`readiness.mappingStatus.${m.status}`)}</Badge>}>
    <div className={styles.body}>
      <div>
        <Text block className={styles.review}>{t(`readiness.review.${m.reviewStatus}`)}</Text>
        <Text block className={styles.note}>{t('readiness.mappingNote')}</Text>
      </div>
      {m.coverage && m.counts && <>
        <Text block className={styles.strong}>{t('readiness.mappingCoverage', { examined: m.coverage.examinedLinks, stored: m.coverage.storedLinks, limit: m.limit })}</Text>
        <FactGrid className={styles.mappingFacts} items={[
          { label: t('readiness.omittedLinks'), value: String(m.coverage.omittedLinks) },
          { label: t('readiness.unlinkedReferences'), value: String(m.coverage.unlinkedStoredReferences) },
          ...(['validLinks', 'invalidIdentities', 'missingReferences', 'goneReferences', 'invalidReferences', 'unavailableCustomers'] as const)
            .map(key => ({ label: t(`readiness.mappingCounts.${key}`), value: String(m.counts![key]) })),
        ]} />
      </>}
      <div><AppLink to="/admin/mappings/atlas">{t('readiness.openMappings')}</AppLink></div>
    </div>
  </Panel>;
}
