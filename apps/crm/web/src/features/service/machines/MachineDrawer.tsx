import { useRef, useState } from 'react';
import {
  Badge, Button, DrawerBody, DrawerHeader, DrawerHeaderTitle, Link, MessageBar, MessageBarBody, OverlayDrawer, Spinner, Text, makeStyles,
} from '@fluentui/react-components';
import { Dismiss24Regular, Open16Regular } from '@fluentui/react-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../../api/client';
import { Permissions, useCan } from '../../../auth/CurrentUserContext';
import { h } from '../../../app/hearth';
import { AppLink } from '../../../shared/components/AppLink';
import { ConfirmDialog } from '../../../shared/components/ConfirmDialog';
import { ErrorState } from '../../../shared/components/ErrorState';
import { DetailList } from '../../../shared/components/Panel';
import { errorMessage } from '../../../shared/utils/errors';
import { formatDateTime, formatRelative } from '../../../shared/utils/format';
import { safeHttpUrl } from '../../../shared/utils/safeUrl';
import { sourceName } from '../alerts/alertText';
import { decideMachine, serviceKeys, useMachine, type MachineDecision } from '../api';
import { ServiceReadLine } from '../ServiceReadLine';
import type { MachineDetail, MachineDevice, MachineProposal } from '../types';
import { MachineInventory } from './MachineInventory';
import { evidenceOrder, leadDevice } from './machineFormat';

const useStyles = makeStyles({
  // A side panel beside the Drift tab, as the alert and ticket panels: the person keeps their place in the list.
  drawer: { width: 'min(560px, 100vw)' },
  body: { display: 'grid', gap: '20px', alignContent: 'start', paddingBottom: '24px', minWidth: 0 },
  facts: { gridTemplateColumns: 'minmax(0, 132px) minmax(0, 1fr)' },
  section: { display: 'grid', gap: '8px', minWidth: 0 },
  heading: { margin: 0, fontSize: '15px', lineHeight: '22px', fontWeight: 700 },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px' },
  external: { display: 'inline-flex', alignItems: 'center', gap: '4px', minHeight: '24px', '& svg': { flexShrink: 0 } },
  list: { listStyleType: 'none', margin: 0, padding: 0, display: 'grid', gap: '8px' },
  item: { display: 'grid', gap: '6px', padding: '10px 12px', borderRadius: '12px', border: `1px solid ${h.line}`, minWidth: 0 },
  itemHead: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', overflowWrap: 'anywhere' },
  buttons: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
  // The state and the last contact side by side; on a phone the contact moves under the state as a whole, never split mid-phrase.
  state: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px' },
  seen: { color: h.muted, fontSize: '13px', lineHeight: '20px', whiteSpace: 'nowrap' },
});

type Asking = { decision: MachineDecision; title: string; body: string; confirm: string };

/**
 * One machine in a side panel (M40): whether it is in touch, the other machines it may be, the agents of every source on it,
 * what its source says about the computer and its Windows updates, and the way to Atera for what Atera's API cannot do. The
 * address holds the machine (`?device=`), so a link and Back open and close it.
 */
export function MachineDrawer({ machineId, onClose, onChanged }: {
  machineId: string | null; onClose: () => void; onChanged: (machineId: string) => void;
}) {
  const { t } = useTranslation(); const styles = useStyles();
  const read = useMachine(machineId);
  const machine = machineId !== null && !read.isFetching ? read.data : undefined;
  const missing = read.error instanceof ApiError && read.error.status === 404;
  const title = (machine ?? read.data)?.name ?? t('machines.title');
  return <OverlayDrawer className={styles.drawer} position="end" open={machineId !== null} onOpenChange={(_, d) => { if (!d.open) onClose(); }} aria-label={title}>
    <DrawerHeader>
      <DrawerHeaderTitle action={<Button appearance="subtle" icon={<Dismiss24Regular />} aria-label={t('common.close')} onClick={onClose} />}>{title}</DrawerHeaderTitle>
    </DrawerHeader>
    <DrawerBody className={styles.body}>
      {read.isFetching && !read.data && <Spinner size="small" label={t('machines.loading')} />}
      {!read.isFetching && read.isError && (missing
        ? <Text block role="status">{t('machines.notFound')}</Text>
        : <ErrorState error={read.error} onRetry={() => void read.refetch()} />)}
      {(machine ?? read.data) && <MachineBody machine={(machine ?? read.data)!} onClose={onClose} onChanged={onChanged} reread={() => void read.refetch()} />}
    </DrawerBody>
  </OverlayDrawer>;
}

function MachineBody({ machine, onClose, onChanged, reread }: {
  machine: MachineDetail; onClose: () => void; onChanged: (machineId: string) => void; reread: () => void;
}) {
  const { t } = useTranslation(); const styles = useStyles(); const client = useQueryClient();
  const canDecide = useCan(Permissions.serviceWrite);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // After a decision the button that made it is gone: focus goes to the devices the machine has now, inside the panel.
  const sourcesHeading = useRef<HTMLHeadingElement>(null);
  const lead = leadDevice(machine.devices);
  const current = machine.devices.filter((d) => d.removedAt === null);
  const link = lead?.url ? safeHttpUrl(lead.url) : undefined;

  const decide = async (decision: MachineDecision) => {
    setBusy(true); setError(null); setDone(null);
    try {
      const answer = await decideMachine(machine, decision);
      client.setQueryData(serviceKeys.machine(answer.data.id), answer.data);
      setAsking(null);
      setDone(t(`machines.decided.${decision.kind}`));
      onChanged(answer.data.id);
      window.setTimeout(() => sourcesHeading.current?.focus(), 0);
    } catch (failure) {
      // A read in between changed the card: it is read again, and the person decides on what is there now.
      if (failure instanceof ApiError && failure.status === 412) { setAsking(null); setError(t('machines.changed')); reread(); }
      else setError(errorMessage(failure, t));
    } finally {
      setBusy(false);
    }
  };
  const join = (proposal: MachineProposal) => void decide({ kind: 'join', otherMachineId: proposal.otherMachineId });
  const keepApart = (proposal: MachineProposal) => setAsking({
    decision: { kind: 'keep-apart', otherMachineId: proposal.otherMachineId },
    title: t('machines.keepApartTitle', { name: machine.name, other: proposal.otherName }),
    body: t('machines.keepApartBody', { name: machine.name, other: proposal.otherName }), confirm: t('machines.keepApart'),
  });
  const detach = (device: MachineDevice) => setAsking({
    decision: { kind: 'detach', deviceId: device.id },
    title: t('machines.detachTitle', { device: device.machineName, source: sourceName(t, device.system) }),
    body: t('machines.detachBody', { device: device.machineName, name: machine.name }), confirm: t('machines.detach'),
  });

  return <>
    {error && !asking && <MessageBar intent="warning"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
    <div role="status">{done && <MessageBar intent="success"><MessageBarBody>{done}</MessageBarBody></MessageBar>}</div>
    <DetailList className={styles.facts} items={[
      { label: t('machines.fields.state'), value: <span className={styles.state}>
        <Badge appearance="tint" color={machine.removedAt ? 'subtle' : machine.online ? 'success' : 'informative'}>
          {t(machine.removedAt ? 'machines.removed' : machine.online ? 'machines.online' : 'machines.offline')}</Badge>
        {machine.lastSeenAt && <Text className={styles.seen}>{t('service.lastSeen')} <time dateTime={machine.lastSeenAt} title={formatDateTime(machine.lastSeenAt)}>
          {formatRelative(machine.lastSeenAt)}</time></Text>}
      </span> },
      { label: t('machines.fields.type'), value: t(`service.deviceType.${machine.type}`) },
      { label: t('machines.fields.customer'), value: <AppLink to={`/organizations/${machine.organizationId}?tab=drift`} onClick={onClose}>
        {machine.organizationName ?? t('alerts.detail.unknownCustomer')}</AppLink> },
      ...(machine.openAlerts > 0 ? [{ label: t('machines.fields.alerts'), value: t('service.deviceOpenAlerts', { count: machine.openAlerts }) }] : []),
    ]} />
    {machine.removedAt && <Text block className={styles.muted}>{t('machines.removedSince', { date: formatDateTime(machine.removedAt) })}</Text>}
    {machine.reads.length > 0 && <ServiceReadLine reads={machine.reads} />}

    {machine.proposals.length > 0 && <section className={styles.section} aria-labelledby={`machine-proposals-${machine.id}`}>
      <h3 id={`machine-proposals-${machine.id}`} className={styles.heading}>{t('machines.proposals')}</h3>
      <Text block className={styles.muted}>{t('machines.proposalsHint')}</Text>
      <ul className={styles.list}>{machine.proposals.map((proposal) => <li key={proposal.otherMachineId} className={styles.item}>
        <Text weight="semibold">{t('machines.maybeSame', { other: proposal.otherName })}</Text>
        <Text size={200} className={styles.muted}>{evidenceOrder.filter((e) => proposal.evidence.includes(e)).map((e) => t(`machines.evidence.${e}`)).join(' · ')}</Text>
        {canDecide && <span className={styles.buttons}>
          <Button size="small" disabled={busy} onClick={() => join(proposal)}>{t('machines.join')}</Button>
          <Button size="small" appearance="subtle" disabled={busy} onClick={() => keepApart(proposal)}>{t('machines.keepApart')}</Button>
        </span>}
      </li>)}</ul>
    </section>}

    <section className={styles.section} aria-labelledby={`machine-sources-${machine.id}`}>
      <h3 id={`machine-sources-${machine.id}`} ref={sourcesHeading} tabIndex={-1} className={styles.heading}>{t('machines.sources')}</h3>
      <ul className={styles.list}>{machine.devices.map((device) => {
        const href = device.url ? safeHttpUrl(device.url) : undefined;
        return <li key={device.id} className={styles.item}>
          <span className={styles.itemHead}>
            <Text weight="semibold">{sourceName(t, device.system)}</Text>
            {device.machineName !== machine.name && <Text>{device.machineName}</Text>}
            <Badge appearance="tint" color={device.removedAt ? 'subtle' : device.online ? 'success' : 'informative'}>
              {t(device.removedAt ? 'machines.removed' : device.online ? 'machines.online' : 'machines.offline')}</Badge>
          </span>
          <Text size={200} className={styles.muted}>{device.lastSeenAt
            ? <>{t('service.lastSeen')} <time dateTime={device.lastSeenAt} title={formatDateTime(device.lastSeenAt)}>{formatRelative(device.lastSeenAt)}</time></>
            : t('machines.neverSeen')}</Text>
          <span className={styles.buttons}>
            {href && <Link href={href} target="_blank" rel="noopener noreferrer" className={styles.external}>
              {t('machines.openIn', { source: sourceName(t, device.system) })}<Open16Regular aria-hidden /></Link>}
            {canDecide && current.length > 1 && device.removedAt === null &&
              <Button size="small" appearance="subtle" disabled={busy} onClick={() => detach(device)}>{t('machines.detach')}</Button>}
          </span>
        </li>;
      })}</ul>
    </section>

    {lead && <MachineInventory device={lead} />}

    {/* What Atera's API cannot do is one link away: the person does it in Atera itself. */}
    <section className={styles.section} aria-labelledby={`machine-console-${machine.id}`}>
      <h3 id={`machine-console-${machine.id}`} className={styles.heading}>{t('machines.inConsole', { source: sourceName(t, lead?.system ?? 'atera') })}</h3>
      <Text block className={styles.muted}>{t('machines.consoleOnly', { source: sourceName(t, lead?.system ?? 'atera') })}</Text>
      {link && <Link href={link} target="_blank" rel="noopener noreferrer" className={styles.external}>
        {t('machines.openIn', { source: sourceName(t, lead?.system ?? 'atera') })}<Open16Regular aria-hidden /></Link>}
    </section>

    <ConfirmDialog open={asking !== null} title={asking?.title ?? ''} confirm={asking?.confirm ?? ''} busy={busy} error={asking ? error : null}
      onConfirm={() => { if (asking) void decide(asking.decision); }} onCancel={() => { setAsking(null); setError(null); }}>
      <Text block>{asking?.body}</Text>
    </ConfirmDialog>
  </>;
}
