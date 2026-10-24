import { useRef, useState } from 'react';
import { Badge, Button, Spinner, Text, makeStyles, useRestoreFocusTarget } from '@fluentui/react-components';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { formatDateTime, formatRelative } from '../../shared/utils/format';
import { ActionDialog } from '../actions/ActionDialog';
import { ActionList } from '../actions/ActionLog';
import { useActionAvailable } from '../actions/api';
import type { ActionRequest, VendorAction } from '../actions/types';
import { defenderStatus } from '../service/alerts/alertText';
import { useMachine } from '../service/api';
import type { MachineDevice } from '../service/types';
import { deviceActionRequest, isIsolated } from './securityText';

const useStyles = makeStyles({
  section: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '8px', minWidth: 0 },
  subheading: { margin: 0, fontSize: '14px', lineHeight: '20px', fontWeight: 700 },
  line: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px' },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px' },
  buttons: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
  log: { marginLeft: '-12px', marginRight: '-12px' },
});

type Ask = { request: ActionRequest; title: string; confirm: string };

/** The tone of a host's isolation: cut off is the warning, on its way in either direction is information. */
const isolationColor = (isolation: string | null) =>
  isolation === 'Isolated' ? 'danger' : isolation === 'Pending Isolation' || isolation === 'Pending Release' ? 'warning' : 'success';

/**
 * What Huntress says about a computer's protection (M41): Microsoft Defender's status as Huntress words it and when Huntress last
 * heard it, whether the computer is isolated from the network, and the Huntress agent's version. Nothing is said that Huntress did
 * not report, and nothing twice: the version is left to the machine's inventory where that inventory is this agent's (`version`).
 */
export function ProtectionFacts({ device, version = true }: { device: MachineDevice; version?: boolean }) {
  const { t } = useTranslation(); const styles = useStyles();
  const p = device.protection;
  if (!p) return null;
  const defender = p.antivirusStatus ? [defenderStatus(t, p.antivirusStatus), p.antivirusSubstatus].filter(Boolean).join(' · ') : null;
  return <>
    {defender && <Text size={200} className={styles.muted}>
      {t('machines.protection.defender', { status: defender })}
      {p.antivirusReportedAt && <>{' · '}{t('machines.protection.reported')} <time dateTime={p.antivirusReportedAt} title={formatDateTime(p.antivirusReportedAt)}>
        {formatRelative(p.antivirusReportedAt)}</time></>}
    </Text>}
    {p.isolation && <span className={styles.line}>
      <Badge appearance="tint" color={isolationColor(p.isolation)}>{t(`machines.protection.isolation.${p.isolation}`, { defaultValue: p.isolation })}</Badge>
    </span>}
    {version && device.inventory.agentVersion && <Text size={200} className={styles.muted}>{t('machines.protection.agentVersion', { version: device.inventory.agentVersion })}</Text>}
  </>;
}

/**
 * The actions at Huntress on one of its agents (M41): isolate the host or release it (disruptive: a reason), and uninstall the agent
 * (destructive: a fresh sign-in, the machine's name typed, a reason and a minute to change one's mind). Each is offered only when it
 * is switched on and fits the host's state; the confirmation then says exactly what happens.
 */
export function ProtectionActions({ device, withUninstall = true, onClosed }: {
  device: MachineDevice; withUninstall?: boolean;
  /** Where focus goes when the confirmation closes: the change swaps the button that opened it (isolate, lift), or removes it. */
  onClosed?: () => void;
}) {
  const { t } = useTranslation(); const styles = useStyles(); const client = useQueryClient(); const restore = useRestoreFocusTarget();
  const canWrite = useCan(Permissions.serviceWrite) && device.removedAt === null && device.system === 'huntress';
  const isolate = useActionAvailable(device.system, 'agent.isolate', canWrite);
  const release = useActionAvailable(device.system, 'agent.release', canWrite);
  const uninstall = useActionAvailable(device.system, 'agent.uninstall', canWrite && withUninstall);
  const [ask, setAsk] = useState<Ask | null>(null);
  const isolated = isIsolated(device.protection?.isolation);
  const releasing = device.protection?.isolation === 'Pending Release';
  const finished = (action: VendorAction) => {
    if (action.status === 'Succeeded' || action.status === 'Skipped') void client.invalidateQueries({ queryKey: ['service'] });
  };
  const offer = (kind: string, title: string, confirm: string) => setAsk({ request: deviceActionRequest(device.system, device.externalId, kind), title, confirm });
  const shown = (isolate && !isolated && !releasing) || (release && (isolated || releasing)) || uninstall;
  return <>
    {shown && <span className={styles.buttons}>
      {isolate && !isolated && !releasing && <Button {...restore} size="small" onClick={() =>
        offer('agent.isolate', t('machines.protection.isolateTitle', { name: device.machineName }), t('machines.protection.isolate'))}>
        {t('machines.protection.isolateItem')}</Button>}
      {release && (isolated || releasing) && <Button {...restore} size="small" onClick={() =>
        offer('agent.release', t('machines.protection.releaseTitle', { name: device.machineName }), t('machines.protection.release'))}>
        {t('machines.protection.releaseItem')}</Button>}
      {uninstall && <Button {...restore} size="small" appearance="subtle" onClick={() =>
        offer('agent.uninstall', t('machines.protection.uninstallTitle', { name: device.machineName }), t('machines.protection.uninstall'))}>
        {t('machines.protection.uninstallItem')}</Button>}
    </span>}
    <ActionDialog request={ask?.request ?? null} title={ask?.title ?? ''} confirm={ask?.confirm ?? ''} onFinished={finished}
      onClose={() => { setAsk(null); if (onClosed) window.setTimeout(onClosed, 0); }} />
  </>;
}

/**
 * The device of an incident (M41), in the incident's panel: whether Huntress has it isolated, and the way to isolate it or release
 * it from there. It is the incident's own agent (or the alert's device), never another agent the machine has had: a reinstalled
 * computer keeps its old, silent agent beside the new one. The device's card has the rest.
 */
export function DeviceIsolation({ machineId, agentExternalId, deviceId }: { machineId: string; agentExternalId: string | null; deviceId: string | null }) {
  const { t } = useTranslation(); const styles = useStyles();
  const read = useMachine(machineId);
  const heading = useRef<HTMLHeadingElement>(null);
  const huntress = (read.data?.devices ?? []).filter((d) => d.system === 'huntress');
  const device = agentExternalId ? huntress.find((d) => d.externalId === agentExternalId) : huntress.find((d) => d.id === deviceId);
  if (read.isPending) return <Spinner size="small" label={t('machines.loading')} />;
  if (!device || device.removedAt !== null) return null;
  const isolation = device.protection?.isolation ?? null;
  return <section className={styles.section} aria-labelledby={`isolation-${machineId}`}>
    <h4 id={`isolation-${machineId}`} ref={heading} tabIndex={-1} className={styles.subheading}>{t('machines.protection.machine', { name: device.machineName })}</h4>
    {/* An isolation Huntress did not report is not said at all, rather than as "not isolated". */}
    {isolation && <span className={styles.line}>
      <Badge appearance="tint" color={isolationColor(isolation)}>{t(`machines.protection.isolation.${isolation}`, { defaultValue: isolation })}</Badge>
    </span>}
    <ProtectionActions device={device} withUninstall={false} onClosed={() => heading.current?.focus()} />
    <div className={styles.log}>
      <ActionList filters={{ targetType: 'device', targetId: device.externalId }} showTarget={false} limit={3} empty={t('machines.protection.noActions')} />
    </div>
  </section>;
}
