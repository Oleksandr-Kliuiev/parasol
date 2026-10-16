import { Button, MessageBar, MessageBarBody, Spinner, Text, makeStyles, tokens } from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { Permissions, useCan, useCurrentUser } from '../../auth/CurrentUserContext';
import { Panel, DetailList } from '../../shared/components/Panel';
import { ErrorState } from '../../shared/components/ErrorState';
import { formatDateTime } from '../../shared/utils/format';

type Status = 'READY' | 'NOT_LINKED' | 'NOT_CONFIGURED' | 'ACCESS_DENIED' | 'SOURCE_NOT_FOUND' | 'UNAVAILABLE' | 'INVALID_RESPONSE' | 'IDENTITY_CHANGED';
type ResourceStatus = 'OK' | 'STALE' | 'ERROR' | 'MISSING' | 'FIXTURE';
export interface Workspace {
  customerId: string;
  status: Status;
  summary: null | {
    mode: 'db' | 'fixture'; generatedAt: string; completeness: string;
    knownDevices: number; knownPeople: number; activeObservations: number;
    severityCounts: Record<'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL', number>;
    resources: { source: string; resourceType: string; status: ResourceStatus; asOf: string | null;
      lastSuccessAt: string | null; returnedItems: number | null; truncated: boolean }[];
  };
}

const useStyles = makeStyles({
  list: { padding: 0, listStyle: 'none', display: 'grid', gap: tokens.spacingVerticalM },
  resource: { paddingTop: tokens.spacingVerticalS, borderTop: `1px solid ${tokens.colorNeutralStroke2}` },
  note: { marginBlock: tokens.spacingVerticalM },
});

export function CustomerWorkspacePanel({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const allowed = useCan(Permissions.parasolAtlasRead);
  if (!allowed) return <Panel title={t('parasol.title')}><Text>{t('parasol.noPermission')}</Text></Panel>;
  return <AuthorizedWorkspace key={customerId} customerId={customerId} />;
}

function AuthorizedWorkspace({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const user = useCurrentUser();
  const query = useQuery({
    queryKey: ['parasol', 'workspace', user.id, customerId],
    queryFn: async ({ signal }) => (await api.get<Workspace>(`/api/v1/parasol/customers/${customerId}/workspace`, signal)).data,
    retry: false, staleTime: 0, gcTime: 0,
    refetchOnWindowFocus: 'always',
  });
  // A fresh check hides the previous snapshot, including during a failed refresh or a permission change.
  const data = !query.isFetching && !query.isError ? query.data : undefined;
  const summary = data?.status === 'READY' ? data.summary : null;
  return (
    <Panel title={t('parasol.title')} actions={<Button size="small" disabled={query.isFetching} onClick={() => void query.refetch()}>{t('parasol.refresh')}</Button>}>
      {query.isFetching && <Spinner size="small" label={t('common.loading')} />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {data && data.status !== 'READY' && <Text role="status">{t(`parasol.status.${data.status}`)}</Text>}
      {summary && <>
        {summary.mode === 'fixture' && <MessageBar intent="warning"><MessageBarBody>{t('parasol.fixture')}</MessageBarBody></MessageBar>}
        <Text block className={styles.note}>{t('parasol.snapshot', { time: formatDateTime(summary.generatedAt) })}</Text>
        <DetailList items={[
          { label: t('parasol.devices'), value: String(summary.knownDevices) },
          { label: t('parasol.people'), value: String(summary.knownPeople) },
          { label: t('parasol.observations'), value: String(summary.activeObservations) },
          { label: t('parasol.critical'), value: String(summary.severityCounts.CRITICAL) },
          { label: t('parasol.high'), value: String(summary.severityCounts.HIGH) },
        ]} />
        <Text block className={styles.note}>{t('parasol.coverage')}</Text>
        {summary.resources.length === 0 && <Text>{t('parasol.noSources')}</Text>}
        <ul className={styles.list}>
          {summary.resources.map((r, i) => <li key={`${r.source}-${r.resourceType}-${i}`} className={styles.resource}>
            <Text weight="semibold">{t(`parasol.sources.${r.source}`)} · {t(`parasol.resources.${r.resourceType}`)}</Text>
            <Text block>{t(`parasol.resourceStatus.${r.status}`)}</Text>
            {r.asOf && <Text block>{t('parasol.asOf', { time: formatDateTime(r.asOf) })}</Text>}
            {r.lastSuccessAt && <Text block>{t('parasol.lastSuccess', { time: formatDateTime(r.lastSuccessAt) })}</Text>}
            {r.returnedItems !== null && <Text block>{t(r.truncated ? 'parasol.truncated' : 'parasol.returned', { count: r.returnedItems })}</Text>}
          </li>)}
        </ul>
      </>}
    </Panel>
  );
}
