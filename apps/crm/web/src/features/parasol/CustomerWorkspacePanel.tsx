import { useCallback, useState } from 'react';
import { Button, MessageBar, MessageBarBody, Spinner, Text, makeStyles, tokens } from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { Permissions, useCan, useCurrentUser } from '../../auth/CurrentUserContext';
import { Panel, DetailList } from '../../shared/components/Panel';
import { ErrorState } from '../../shared/components/ErrorState';
import { formatDateTime } from '../../shared/utils/format';
import { CustomerTechnicalDetails } from './CustomerTechnicalDetails';
import { parseWorkspace } from './workspaceContract';
export type { Workspace } from './workspaceContract';

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
  const [sourceCheck, setSourceCheck] = useState({ pending: false, revision: 0 });
  const query = useQuery({
    queryKey: ['parasol', 'workspace', user.id, customerId],
    queryFn: async ({ signal }) => parseWorkspace((await api.get<unknown>(`/api/v1/parasol/customers/${customerId}/workspace`, signal)).data, customerId),
    retry: false, staleTime: 0, gcTime: 0,
    refetchOnWindowFocus: 'always',
  });
  const { refetch } = query;
  const refreshWorkspace = useCallback(() => {
    setSourceCheck(s => ({ pending: true, revision: s.revision + 1 }));
    // An explicit gate and revision also clear the old queue if a fast read is batched without a fetching render.
    void refetch().finally(() => setSourceCheck(s => ({ ...s, pending: false })));
  }, [refetch]);
  // A fresh check hides the previous snapshot, including during a failed refresh or a permission change.
  const checking = sourceCheck.pending || query.isFetching;
  const data = !checking && !query.isError ? query.data : undefined;
  const summary = data?.status === 'READY' ? data.summary : null;
  return (
    <Panel title={t('parasol.title')} actions={<Button size="small" disabled={checking} disabledFocusable={checking} onClick={refreshWorkspace}>{t('parasol.refresh')}</Button>}>
      {checking && <Spinner size="small" label={t('common.loading')} />}
      {!checking && query.isError && <ErrorState error={query.error} onRetry={refreshWorkspace} />}
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
        <CustomerTechnicalDetails key={`${user.id}:${sourceCheck.revision}`} customerId={customerId} summary={summary} onSourceInvalidated={refreshWorkspace} />
      </>}
    </Panel>
  );
}
