import { useState } from 'react';
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
  MessageBar, MessageBarBody, Spinner, Text, makeStyles, tokens, useRestoreFocusTarget } from '@fluentui/react-components';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { Permissions, useCan, useCurrentUser } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { Panel, DetailList } from '../../shared/components/Panel';
import type { CustomerIdentity } from './identityImport';

const useStyles = makeStyles({
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalM, marginTop: tokens.spacingVerticalM },
});

export function CustomerIdentityPanel({ customerId }: { customerId: string }) {
  const allowed = useCan(Permissions.integrationsManage);
  const user = useCurrentUser();
  return allowed ? <IdentityPanel key={`${user.id}:${customerId}`} customerId={customerId} userId={user.id} /> : null;
}

function IdentityPanel({ customerId, userId }: { customerId: string; userId: string }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const client = useQueryClient();
  const [removing, setRemoving] = useState<CustomerIdentity | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const restoreFocus = useRestoreFocusTarget();
  const identity = useQuery({
    queryKey: ['parasol', 'identity', userId, customerId],
    queryFn: async ({ signal }) => (await api.get<CustomerIdentity>(`/api/v1/parasol/customers/${customerId}/identity`, signal)).data,
    retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: 'always',
  });
  const data = !identity.isFetching && !identity.isError ? identity.data : undefined;
  const unlink = async () => {
    if (!removing?.linkId || busy) return;
    setBusy(true); setFailed(false);
    try { await api.delete(`/api/v1/integrations/links/${removing.linkId}`); }
    catch { setFailed(true); }
    finally {
      setRemoving(null);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['parasol'] }),
        client.invalidateQueries({ queryKey: ['integrations'] }),
      ]);
      setBusy(false);
    }
  };
  return <Panel title={t('parasolIdentity.linkTitle')}>
    {identity.isFetching && <Spinner size="small" label={t('common.loading')} />}
    {(failed || identity.isError) && <MessageBar layout="multiline" intent="error"><MessageBarBody>{t(failed ? 'parasolIdentity.errors.unlinkFailed' : 'parasolIdentity.errors.identityFailed')}</MessageBarBody></MessageBar>}
    {identity.isError && <Button disabled={busy} onClick={() => void identity.refetch()}>{t('parasol.refresh')}</Button>}
    {data?.atlas && <>
      <DetailList items={[
        { label: t('parasolIdentity.workspace'), value: data.atlas.workspaceId },
        { label: t('parasolIdentity.atlasClient'), value: data.atlas.clientId },
      ]} />
    </>}
    {data && !data.atlas && <Text block>{t('parasol.status.NOT_LINKED')}</Text>}
    <div className={styles.actions}>
      {data?.atlas && <Button {...restoreFocus} disabled={busy || !data.linkId} onClick={() => setRemoving(data)}>{t('parasolIdentity.unlink')}</Button>}
      <AppLink to="/admin/mappings/atlas">{t('parasolIdentity.title')}</AppLink>
    </div>
    <Dialog open={removing !== null} onOpenChange={(_, d) => { if (!d.open && !busy) setRemoving(null); }}>
      <DialogSurface><DialogBody>
        <DialogTitle>{t('parasolIdentity.unlinkTitle')}</DialogTitle>
        <DialogContent>
          <Text block>{t('parasolIdentity.unlinkDescription')}</Text>
          <DetailList items={[
            { label: t('parasolIdentity.workspace'), value: removing?.atlas?.workspaceId },
            { label: t('parasolIdentity.atlasClient'), value: removing?.atlas?.clientId },
          ]} />
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setRemoving(null)}>{t('common.cancel')}</Button>
          <Button appearance="primary" disabled={busy} onClick={() => void unlink()}>{t('parasolIdentity.unlink')}</Button>
        </DialogActions>
      </DialogBody></DialogSurface>
    </Dialog>
  </Panel>;
}
