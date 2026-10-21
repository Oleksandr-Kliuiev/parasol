import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Link, MessageBar, MessageBarBody, Switch, Table, TableBody, TableCell, TableHeader,
  TableHeaderCell, TableRow, Text, makeStyles, mergeClasses, tokens, useRestoreFocusTarget } from '@fluentui/react-components';
import { Add20Regular, Alert16Regular, AlertOn24Regular, Database16Regular, Desktop16Regular, Desktop24Regular, Headset24Regular, Headset16Regular,
  Open16Regular, Send16Regular, Send24Regular, Server16Regular } from '@fluentui/react-icons';
import { h } from '../../app/hearth';
import { useFlushStyles } from '../billing/flushStyles';
import { RecordRow, RowMeta } from '../billing/RecordRow';
import { useTranslation } from 'react-i18next';
import { Permissions, useCurrentUser } from '../../auth/CurrentUserContext';
import { useScrollEdges } from '../../shared/utils/useScrollEdges';
import { EmptyState } from '../../shared/components/EmptyState';
import { ListFooter } from '../../shared/components/ListFooter';
import { Panel } from '../../shared/components/Panel';
import { FigureGrid } from '../reports/FigureGrid';
import { formatDate, formatDateTime, formatNumber } from '../../shared/utils/format';
import { safeHttpUrl } from '../../shared/utils/safeUrl';
import { useAlerts, useDevices, useServiceSummary, useTicketRequests, useTickets } from './api';
import { CreateTicketDialog } from './CreateTicketDialog';
import { SavedServiceReadState } from './SavedServiceReadState';
import { deviceTypes } from './types';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: '16px' },
  bad: { color: h.emberT }, warning: { color: h.saffronT },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))', gap: '16px', alignItems: 'stretch' },
  row: { display: 'flex', flexWrap: 'wrap', gap: '8px 12px', alignItems: 'center' },
  // The copy's own line, then its figures: one card for what the CRM holds of Atera.
  mirror: { display: 'block', maxWidth: '75ch', marginBottom: '14px', color: h.muted, fontSize: '13px', lineHeight: '20px' },
  summary: { display: 'grid', gap: '12px' },
  facts: { gridTemplateColumns: 'repeat(auto-fit, minmax(min(140px, 100%), 1fr))' },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px' },
  // A read state or an empty line inside a flush panel keeps the panel's side padding and a bottom edge.
  pad: { paddingLeft: '20px', paddingRight: '20px', '@media (max-width: 600px)': { paddingLeft: '16px', paddingRight: '16px' } },
  padEnd: { paddingBottom: '16px' },
  // The device types as count pills (the reference's status chips, read only): the word, then the number.
  types: { listStyleType: 'none', margin: 0, marginBottom: '12px', padding: 0, display: 'flex', flexWrap: 'wrap', gap: '6px' },
  type: {
    display: 'inline-flex', alignItems: 'center', gap: '6px', height: '28px', paddingLeft: '10px', paddingRight: '10px', borderRadius: '999px',
    border: `1px solid ${h.line}`, color: h.muted, fontSize: '12.5px', fontWeight: 700, whiteSpace: 'nowrap',
    '& b': { color: h.text, fontVariantNumeric: 'tabular-nums' },
  },
  ticket: { fontWeight: 600 },
  // The external-link mark stays beside the title, also when the title wraps.
  ticketLink: { display: 'inline-flex', alignItems: 'center', gap: '4px', '& svg': { flexShrink: 0 } },
  statusColumn: { width: '136px' },
  personColumn: { width: '22%' },
  createdColumn: { width: '120px' },
  ticketMeta: { color: h.muted, fontSize: '12.5px', lineHeight: '18px', fontVariantNumeric: 'tabular-nums' },
  ticketScroll: { overflowX: 'auto', borderTop: `1px solid ${h.line}`, ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '-2px' },
    '& th': { boxSizing: 'border-box' } },
  requests: { display: 'grid', gap: '8px' },
});

/** Saved CRM mirror of Atera, with an employee/customer lifetime independent of other workspace tabs. */
export function OrganizationServiceTab({ organizationId }: { organizationId: string }) {
  const user = useCurrentUser();
  if (!user.permissions.includes(Permissions.serviceRead)) return null;
  const owner = JSON.stringify([user.id, [...user.permissions].sort(), organizationId]);
  return <SavedService key={owner} organizationId={organizationId} owner={owner} canCreate={user.permissions.includes(Permissions.serviceWrite)} />;
}

function SavedService({ organizationId, owner, canCreate }: { organizationId: string; owner: string; canCreate: boolean }) {
  const styles = useStyles(); const flush = useFlushStyles(); const { t } = useTranslation();
  const [openOnly, setOpenOnly] = useState(true); const [creating, setCreating] = useState(false); const [revision, setRevision] = useState(0);
  const refreshing = useRef(false); const restoreFocusTarget = useRestoreFocusTarget(); const scope = { owner, revision };
  const summary = useServiceSummary(organizationId, scope); const tickets = useTickets({ organizationId, openOnly: openOnly || undefined }, scope);
  // The table scrolls sideways on phones: the hidden edge fades, as in ScrollTable (the region name stays with the card).
  // The region mounts only once the saved list is available: measure again then, not only when the row count changes.
  const ticketScroll = useRef<HTMLDivElement>(null); const ticketEdges = useScrollEdges(ticketScroll, 'x', `${tickets.available}:${tickets.items.length}`);
  const devices = useDevices(organizationId, scope); const alerts = useAlerts(organizationId, scope); const requests = useTicketRequests(organizationId, scope);
  const checking = summary.isFetching || tickets.checking || devices.checking || alerts.checking || requests.checking;
  useEffect(() => { if (!checking) refreshing.current = false; }, [checking, revision]);
  const refresh = () => { if (checking || refreshing.current) return; refreshing.current = true; setRevision(value => value + 1); };
  const summaryAvailable = summary.isSuccess && !summary.isFetching;
  const devicesByType = summaryAvailable ? summary.data.devices : {};
  const totalDevices = Object.values(devicesByType).reduce((sum, count) => sum + (count ?? 0), 0);
  const count = (value: number, tone: 'bad' | 'warning') => (value > 0 ? <span className={styles[tone]}>{value}</span> : '0');
  // Zeros mean something only once Atera has been read for this customer: with nothing ever saved, the tab says so instead
  // of reporting "0 critical alerts" for a customer it knows nothing about.
  const nothingSaved = summaryAvailable && summary.data.lastSyncedAt === null && totalDevices === 0 && summary.data.openTickets === 0
    && summary.data.criticalAlerts === 0 && summary.data.warningAlerts === 0;

  return <div className={styles.stack}>
    <Panel title={t('service.savedData')} icon={<Database16Regular />}
      actions={<Button size="small" disabled={checking} disabledFocusable={checking} onClick={refresh}>{t('service.refreshSaved')}</Button>}>
      <Text className={styles.mirror}>{t('service.savedMirror')}</Text>
      <section aria-label={t('service.summary')} className={styles.summary}>
        <SavedServiceReadState checking={summary.isFetching} error={summary.error} onRetry={() => void summary.refetch()} />
        {nothingSaved && <Text block>{t('service.nothingSaved')}</Text>}
        {summaryAvailable && !nothingSaved && <>
          <FigureGrid className={styles.facts} items={[
            { label: t('service.openTickets'), value: String(summary.data.openTickets) },
            { label: t('service.devices'), value: String(totalDevices), note: t('service.onlineCount', { count: summary.data.devicesOnline }) },
            { label: t('service.criticalAlerts'), value: count(summary.data.criticalAlerts, 'bad') },
            { label: t('service.warningAlerts'), value: count(summary.data.warningAlerts, 'warning') },
          ]} />
          <Text className={styles.muted}>
            {summary.data.lastSyncedAt ? t('service.lastTicketChange', { at: formatDateTime(summary.data.lastSyncedAt) }) : t('service.lastTicketChangeUnknown')}
          </Text>
        </>}
      </section>
    </Panel>

    <Panel title={t('service.requests')} icon={<Send16Regular />}>
      <SavedServiceReadState checking={requests.checking} error={requests.error} onRetry={requests.refresh} />
      {requests.items.length > 0 && <div className={styles.requests}>
        {requests.items.map(request => <MessageBar key={request.id} intent={request.status === 'Failed' ? 'error' : 'info'}><MessageBarBody>
          {request.status === 'Failed' ? t('service.ticketFailed', { title: request.title, error: request.error }) : t('service.ticketPending', { title: request.title })}
        </MessageBarBody></MessageBar>)}
      </div>}
      {requests.available && requests.items.length === 0 && <EmptyState icon={<Send24Regular />} message={t('service.noRequests')} />}
      <ListFooter shown={requests.items.length} total={requests.hasNextPage ? requests.total : null} hasMore={requests.hasNextPage} loading={requests.isFetchingNextPage}
        onMore={() => void requests.fetchNextPage()} />
    </Panel>

    <Panel title={t('service.tickets')} icon={<Headset16Regular />} flush className={flush.panel} actions={<span className={styles.row}>
      <Switch label={t('service.openOnly')} checked={openOnly} onChange={(_, data) => setOpenOnly(data.checked)} />
      {canCreate && <Button {...restoreFocusTarget} size="small" icon={<Add20Regular />} onClick={() => setCreating(true)}>{t('service.newTicket')}</Button>}
    </span>}>
      <div className={mergeClasses(styles.pad, !tickets.available && styles.padEnd)}>
        <SavedServiceReadState checking={tickets.checking} error={tickets.error} onRetry={tickets.refresh} />
      </div>
      {tickets.available && <div ref={ticketScroll} className={styles.ticketScroll} style={ticketEdges.style} role="group" aria-label={t('service.tickets')} tabIndex={0}>
        <Table aria-label={t('service.tickets')} className={flush.table} style={{ minWidth: 780 }}>
          <TableHeader><TableRow>
            <TableHeaderCell>{t('service.fields.ticket')}</TableHeaderCell>
            <TableHeaderCell className={styles.statusColumn}>{t('service.fields.status')}</TableHeaderCell>
            <TableHeaderCell className={styles.personColumn}>{t('service.fields.contact')}</TableHeaderCell>
            <TableHeaderCell className={styles.personColumn}>{t('service.fields.technician')}</TableHeaderCell>
            <TableHeaderCell className={styles.createdColumn}>{t('service.fields.created')}</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>{tickets.items.map(ticket => <TableRow key={ticket.id}>
            <TableCell>
              {ticket.url
                ? <Link href={safeHttpUrl(ticket.url)} target="_blank" rel="noopener noreferrer" className={mergeClasses(styles.ticket, styles.ticketLink)}><span>{ticket.title}</span><Open16Regular aria-hidden /></Link>
                : <span className={styles.ticket}>{ticket.title}</span>}
              <div className={styles.ticketMeta}>{[`#${ticket.externalId}`, ticket.priority].filter(Boolean).join(' · ')}</div>
            </TableCell>
            <TableCell><Badge appearance="tint" color={ticket.isOpen ? 'informative' : 'subtle'}>{ticket.status}</Badge></TableCell>
            <TableCell>{ticket.contactName ?? '—'}</TableCell>
            <TableCell>{ticket.technicianName ?? '—'}</TableCell>
            <TableCell className="tabular">{formatDate(ticket.createdAt)}</TableCell>
          </TableRow>)}</TableBody>
        </Table>
        {tickets.items.length === 0 && <EmptyState icon={<Headset24Regular />} message={openOnly ? t('service.noOpenTickets') : t('service.noTickets')} />}
      </div>}
      <ListFooter shown={tickets.items.length} total={tickets.total} hasMore={tickets.hasNextPage} loading={tickets.isFetchingNextPage} onMore={() => void tickets.fetchNextPage()} />
    </Panel>

    <div className={styles.grid}>
      <Panel title={t('service.devices')} icon={<Desktop16Regular />} flush className={flush.panel}>
        <div className={styles.pad}>
          {summaryAvailable ? totalDevices > 0 && (
            <ul className={styles.types} aria-label={t('service.deviceTypesLabel')}>
              {deviceTypes.filter(type => (devicesByType[type] ?? 0) > 0).map(type => (
                <li key={type} className={styles.type}>{t(`service.deviceTypes.${type}`)} <b>{formatNumber(devicesByType[type] ?? 0, 0)}</b></li>
              ))}
            </ul>
          ) : <Text block className={mergeClasses(styles.muted, styles.padEnd)}>{t('service.deviceTotalsUnknown')}</Text>}
        </div>
        <div className={mergeClasses(styles.pad, !devices.available && styles.padEnd)}>
          <SavedServiceReadState checking={devices.checking} error={devices.error} onRetry={devices.refresh} />
        </div>
        <ul className={flush.list}>{devices.items.map(device => <RecordRow key={device.id} icon={device.type === 'Server' ? <Server16Regular /> : <Desktop16Regular />}
          tone={device.online ? 'spruce' : 'neutral'}
          title={device.url ? <Link href={safeHttpUrl(device.url)} target="_blank" rel="noopener noreferrer">{device.machineName}</Link> : <Text weight="semibold">{device.machineName}</Text>}
          meta={<RowMeta>{t(`service.deviceTypes.${device.type}`)}{device.os ? ` · ${device.os}` : ''}</RowMeta>}
          end={<Badge appearance="tint" color={device.online ? 'success' : 'subtle'}>{device.online ? t('service.online') : t('service.offline')}</Badge>} />)}</ul>
        {devices.available && devices.items.length === 0 && <EmptyState icon={<Desktop24Regular />} message={t('service.noDevices')} />}
        <ListFooter shown={devices.items.length} total={devices.total} hasMore={devices.hasNextPage} loading={devices.isFetchingNextPage} onMore={() => void devices.fetchNextPage()} />
      </Panel>
      <Panel title={t('service.alerts')} icon={<Alert16Regular />} flush className={flush.panel}>
        <div className={mergeClasses(styles.pad, !alerts.available && styles.padEnd)}>
          <SavedServiceReadState checking={alerts.checking} error={alerts.error} onRetry={alerts.refresh} />
        </div>
        <ul className={flush.list}>{alerts.items.map(alert => <RecordRow key={alert.id} icon={<Alert16Regular />} tone={alert.severity === 'Critical' ? 'ember' : 'saffron'}
          title={<Text weight="semibold">{alert.title}</Text>}
          meta={<RowMeta>{[alert.deviceName, formatDateTime(alert.createdAt)].filter(Boolean).join(' · ')}</RowMeta>}
          end={<Badge appearance="tint" color={alert.severity === 'Critical' ? 'danger' : 'warning'}>{t(`service.severities.${alert.severity}`)}</Badge>} />)}</ul>
        {alerts.available && alerts.items.length === 0 && <EmptyState icon={<AlertOn24Regular />} message={t(nothingSaved ? 'service.nothingSavedShort' : 'service.noAlerts')} />}
        <ListFooter shown={alerts.items.length} total={alerts.total} hasMore={alerts.hasNextPage} loading={alerts.isFetchingNextPage} onMore={() => void alerts.fetchNextPage()} />
      </Panel>
    </div>
    {canCreate && <CreateTicketDialog open={creating} organizationId={organizationId} owner={owner} onClose={() => setCreating(false)} onQueued={() => setRevision(value => value + 1)} />}
  </div>;
}
