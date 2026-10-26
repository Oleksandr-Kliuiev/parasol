import type { ReactNode } from 'react';
import { Badge, Text, makeStyles } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { h } from '../../../app/hearth';
import { DetailList } from '../../../shared/components/Panel';
import { formatDate, formatDateTime, formatNumber, formatRelative } from '../../../shared/utils/format';
import { sourceName } from '../alerts/alertText';
import type { DevicePatch, MachineDevice } from '../types';
import { freeShare, memoryText } from './machineFormat';

const useStyles = makeStyles({
  section: { display: 'grid', gap: '8px', minWidth: 0 },
  heading: { margin: 0, fontSize: '15px', lineHeight: '22px', fontWeight: 700 },
  facts: { gridTemplateColumns: 'minmax(0, 132px) minmax(0, 1fr)' },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px' },
  values: { display: 'grid', gap: '2px', overflowWrap: 'anywhere' },
  mono: { fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' },
  list: { listStyleType: 'none', margin: 0, padding: 0, display: 'grid', gap: '6px' },
  update: { display: 'grid', gap: '2px', paddingTop: '6px', borderTop: `1px solid ${h.line}`, overflowWrap: 'anywhere' },
  updateHead: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px' },
  kb: { fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
});

type Fact = { label: string; value: ReactNode | null };

/**
 * What the machine's source says about the computer (M40): hardware, system, network, who is logged in and its Windows updates.
 * A field the source does not report is named once under its section, never shown as a dash.
 */
export function MachineInventory({ device }: { device: MachineDevice }) {
  const { t } = useTranslation(); const s = useStyles();
  const i = device.inventory;
  const source = sourceName(t, device.system);
  const lines = (values: readonly string[]) => (values.length === 0 ? null : <span className={s.values}>{values.map((v) => <span key={v}>{v}</span>)}</span>);
  return <>
    <FactSection id={`machine-hardware-${device.id}`} title={t('machines.hardware')} source={source} facts={[
      { label: t('machines.fields.model'), value: [i.vendor, i.model].filter(Boolean).join(' ') || null },
      { label: t('machines.fields.serialNumber'), value: i.serialNumber },
      { label: t('machines.fields.processor'), value: i.processor && (i.processorCores ? t('machines.processorCores', { processor: i.processor, count: i.processorCores }) : i.processor) },
      { label: t('machines.fields.memory'), value: memoryText(i.memory) },
      { label: t('machines.fields.disks'), value: lines(i.disks.map((d) => {
        const share = freeShare(d);
        return share === null ? (d.drive ?? '') : t('machines.diskFree', { drive: d.drive ?? '', share, free: formatNumber(d.free, 1), total: formatNumber(d.total, 1) });
      }).filter(Boolean)) },
      { label: t('machines.fields.motherboard'), value: i.motherboard },
      { label: t('machines.fields.bios'), value: i.biosVersion },
    ]} />
    <FactSection id={`machine-system-${device.id}`} title={t('machines.system')} source={source} facts={[
      { label: t('machines.fields.os'), value: [device.os, i.osVersion, i.osBuild && t('machines.build', { build: i.osBuild })].filter(Boolean).join(' · ') || null },
      { label: t('machines.fields.lastReboot'), value: i.lastRebootAt && <time dateTime={i.lastRebootAt} title={formatDateTime(i.lastRebootAt)}>{formatRelative(i.lastRebootAt)}</time> },
      { label: t('machines.fields.domain'), value: i.domainName },
      { label: t('machines.fields.agentVersion'), value: i.agentVersion && t('machines.agentVersion', { source, version: i.agentVersion }) },
    ]} />
    <FactSection id={`machine-network-${device.id}`} title={t('machines.network')} source={source} facts={[
      { label: t('machines.fields.ipAddresses'), value: lines(i.ipAddresses) },
      { label: t('machines.fields.publicIp'), value: i.publicIp },
      { label: t('machines.fields.macAddresses'), value: lines(i.macAddresses) },
    ]} />
    <FactSection id={`machine-users-${device.id}`} title={t('machines.users')} source={source} facts={[
      { label: t('machines.fields.loggedIn'), value: i.loggedInUsers },
      { label: t('machines.fields.lastLogin'), value: i.lastLoginUser },
    ]} />
    <MachineUpdates device={device} />
  </>;
}

function FactSection({ id, title, source, facts }: { id: string; title: string; source: string; facts: Fact[] }) {
  const { t } = useTranslation(); const s = useStyles();
  const present = facts.filter((f) => f.value !== null && f.value !== '' && f.value !== undefined);
  const missing = facts.filter((f) => !present.includes(f)).map((f) => f.label.toLocaleLowerCase());
  return <section className={s.section} aria-labelledby={id}>
    <h3 id={id} className={s.heading}>{title}</h3>
    {present.length > 0 && <DetailList className={s.facts} items={present.map((f) => ({ label: f.label, value: f.value }))} />}
    {missing.length > 0 && <Text block className={s.muted}>{present.length === 0
      ? t('machines.nothingReported', { source })
      : t('machines.notReported', { source, fields: missing.join(', ') })}</Text>}
  </section>;
}

/** The Windows updates of the last complete read: every available one, then the latest installed and the count of all. */
function MachineUpdates({ device }: { device: MachineDevice }) {
  const { t } = useTranslation(); const s = useStyles();
  const p = device.patches; const id = `machine-updates-${device.id}`; const source = sourceName(t, device.system);
  const windows = /windows/i.test(device.os ?? '');
  return <section className={s.section} aria-labelledby={id}>
    <h3 id={id} className={s.heading}>{t('machines.updates')}</h3>
    {!windows && <Text block className={s.muted}>{t('machines.updatesWindowsOnly', { source })}</Text>}
    {windows && p.readAt === null && <Text block className={s.muted}>{t('machines.updatesNotRead')}</Text>}
    {windows && p.readAt !== null && <>
      <Text block className={s.muted}>{t('machines.updatesRead', {
        read: formatRelative(p.readAt), collected: p.collectedAt ? formatDateTime(p.collectedAt) : t('machines.unknownTime'), source,
      })}</Text>
      <Text block weight="semibold">{t('machines.available', { count: p.available.length })}</Text>
      {p.available.length > 0 && <UpdateList updates={p.available} />}
      <Text block weight="semibold">{t('machines.installed', { count: p.installedCount })}</Text>
      {p.latestInstalled.length > 0 && <>
        <UpdateList updates={p.latestInstalled} />
        {p.installedCount > p.latestInstalled.length && <Text block className={s.muted}>
          {t('machines.installedShown', { shown: p.latestInstalled.length, count: p.installedCount })}</Text>}
      </>}
    </>}
  </section>;
}

function UpdateList({ updates }: { updates: readonly DevicePatch[] }) {
  const { t } = useTranslation(); const s = useStyles();
  return <ul className={s.list}>{updates.map((u, index) => <li key={`${u.kbId ?? ''}:${u.name}:${index}`} className={s.update}>
    <span className={s.updateHead}>
      {u.kbId && <span className={s.kb}>{u.kbId}</span>}
      {u.status && <Badge appearance="tint" color="warning">{t(`machines.updateStatus.${u.status}`, { defaultValue: u.status })}</Badge>}
      {u.installedAt && <Text size={200} className={s.muted}>{formatDate(u.installedAt)}</Text>}
    </span>
    <Text size={200}>{u.name}</Text>
    {u.class && <Text size={200} className={s.muted}>{u.class}</Text>}
  </li>)}</ul>;
}
