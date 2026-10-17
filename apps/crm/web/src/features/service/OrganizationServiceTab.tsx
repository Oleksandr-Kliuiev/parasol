import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Link, MessageBar, MessageBarBody, Switch, Table, TableBody, TableCell, TableHeader,
  TableHeaderCell, TableRow, Text, makeStyles, tokens, useRestoreFocusTarget } from '@fluentui/react-components';
import { Add20Regular, Open16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCurrentUser } from '../../auth/CurrentUserContext';
import { EmptyState } from '../../shared/components/EmptyState';
import { ListFooter } from '../../shared/components/ListFooter';
import { Panel } from '../../shared/components/Panel';
import { formatDate, formatDateTime, formatNumber } from '../../shared/utils/format';
import { safeHttpUrl } from '../../shared/utils/safeUrl';
import { useCatalogStyles } from '../catalog/styles';
import { useAlerts, useDevices, useServiceSummary, useTicketRequests, useTickets } from './api';
import { CreateTicketDialog } from './CreateTicketDialog';
import { SavedServiceReadState } from './SavedServiceReadState';
import { deviceTypes } from './types';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  tiles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: tokens.spacingHorizontalM },
  tile: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground1, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge },
  tileValue: { fontSize: tokens.fontSizeHero700, lineHeight: tokens.lineHeightHero700, fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums' },
  tileLabel: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  alert: { color: tokens.colorPaletteRedForeground1 }, warning: { color: tokens.colorPaletteDarkOrangeForeground1 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: tokens.spacingHorizontalL, alignItems: 'start' },
  row: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, alignItems: 'baseline', paddingBlock: tokens.spacingVerticalXS },
  list: { listStyle: 'none', margin: 0, padding: 0 },
  ticketScroll: { overflowX: 'auto', ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px' } },
});

/** Saved CRM mirror of Atera, with an employee/customer lifetime independent of other workspace tabs. */
export function OrganizationServiceTab({ organizationId }: { organizationId: string }) {
  const user = useCurrentUser();
  if (!user.permissions.includes(Permissions.serviceRead)) return null;
  const owner = JSON.stringify([user.id, [...user.permissions].sort(), organizationId]);
  return <SavedService key={owner} organizationId={organizationId} owner={owner} canCreate={user.permissions.includes(Permissions.serviceWrite)} />;
}

function SavedService({ organizationId, owner, canCreate }: { organizationId: string; owner: string; canCreate: boolean }) {
  const styles = useStyles(); const catalog = useCatalogStyles(); const { t } = useTranslation();
  const [openOnly, setOpenOnly] = useState(true); const [creating, setCreating] = useState(false); const [revision, setRevision] = useState(0);
  const refreshing = useRef(false); const restoreFocusTarget = useRestoreFocusTarget(); const scope = { owner, revision };
  const summary = useServiceSummary(organizationId, scope); const tickets = useTickets({ organizationId, openOnly: openOnly || undefined }, scope);
  const devices = useDevices(organizationId, scope); const alerts = useAlerts(organizationId, scope); const requests = useTicketRequests(organizationId, scope);
  const checking = summary.isFetching || tickets.checking || devices.checking || alerts.checking || requests.checking;
  useEffect(() => { if (!checking) refreshing.current = false; }, [checking, revision]);
  const refresh = () => { if (checking || refreshing.current) return; refreshing.current = true; setRevision(value => value + 1); };
  const summaryAvailable = summary.isSuccess && !summary.isFetching;
  const devicesByType = summaryAvailable ? summary.data.devices : {};
  const totalDevices = Object.values(devicesByType).reduce((sum, count) => sum + (count ?? 0), 0);
  return <div className={styles.stack}>
    <Panel title={t('service.savedData')} actions={<Button size="small" disabled={checking} disabledFocusable={checking} onClick={refresh}>{t('service.refreshSaved')}</Button>}>
      <Text>{t('service.savedMirror')}</Text>
    </Panel>
    <Panel title={t('service.summary')}>
      <SavedServiceReadState checking={summary.isFetching} error={summary.error} onRetry={() => void summary.refetch()} />
      {summaryAvailable && <>
        <div className={styles.tiles}>
          <div className={styles.tile}><span className={styles.tileValue}>{summary.data.openTickets}</span><span className={styles.tileLabel}>{t('service.openTickets')}</span></div>
          <div className={styles.tile}><span className={styles.tileValue}>{totalDevices}</span><span className={styles.tileLabel}>{t('service.devicesOnline', { online: summary.data.devicesOnline })}</span></div>
          <div className={styles.tile}><span className={`${styles.tileValue} ${summary.data.criticalAlerts > 0 ? styles.alert : ''}`}>{summary.data.criticalAlerts}</span><span className={styles.tileLabel}>{t('service.criticalAlerts')}</span></div>
          <div className={styles.tile}><span className={`${styles.tileValue} ${summary.data.warningAlerts > 0 ? styles.warning : ''}`}>{summary.data.warningAlerts}</span><span className={styles.tileLabel}>{t('service.warningAlerts')}</span></div>
        </div>
        <Text className={catalog.muted}>{summary.data.lastSyncedAt ? t('service.lastTicketChange', { at: formatDateTime(summary.data.lastSyncedAt) }) : t('service.lastTicketChangeUnknown')}</Text>
      </>}
    </Panel>
    <Panel title={t('service.requests')}>
      <SavedServiceReadState checking={requests.checking} error={requests.error} onRetry={requests.refresh} />
      {requests.items.map(request => <MessageBar key={request.id} intent={request.status === 'Failed' ? 'error' : 'info'}><MessageBarBody>
        {request.status === 'Failed' ? t('service.ticketFailed', { title: request.title, error: request.error }) : t('service.ticketPending', { title: request.title })}
      </MessageBarBody></MessageBar>)}
      {requests.available && requests.items.length === 0 && <Text className={catalog.muted}>{t('service.noRequests')}</Text>}
      <ListFooter shown={requests.items.length} total={requests.hasNextPage ? requests.total : null} hasMore={requests.hasNextPage} loading={requests.isFetchingNextPage} onMore={() => void requests.fetchNextPage()} />
    </Panel>
    <Panel title={t('service.tickets')} actions={<span className={styles.row}>
      <Switch label={t('service.openOnly')} checked={openOnly} onChange={(_, data) => setOpenOnly(data.checked)} />
      {canCreate && <Button {...restoreFocusTarget} size="small" icon={<Add20Regular />} onClick={() => setCreating(true)}>{t('service.newTicket')}</Button>}
    </span>}>
      <SavedServiceReadState checking={tickets.checking} error={tickets.error} onRetry={tickets.refresh} />
      {tickets.available && <div className={styles.ticketScroll} role="group" aria-label={t('service.tickets')} tabIndex={0}><Table aria-label={t('service.tickets')} style={{ minWidth: 640 }}>
        <TableHeader><TableRow>{['ticket', 'status', 'contact', 'technician', 'created'].map(field => <TableHeaderCell key={field}>{t(`service.fields.${field}`)}</TableHeaderCell>)}</TableRow></TableHeader>
        <TableBody>{tickets.items.map(ticket => <TableRow key={ticket.id}>
          <TableCell>{ticket.url ? <Link href={safeHttpUrl(ticket.url)} target="_blank" rel="noopener noreferrer">{ticket.title} <Open16Regular aria-hidden /></Link> : ticket.title}
            <div className={catalog.sku}>#{ticket.externalId}{ticket.priority ? ` · ${ticket.priority}` : ''}</div></TableCell>
          <TableCell><Badge appearance={ticket.isOpen ? 'tint' : 'outline'} color={ticket.isOpen ? 'brand' : 'subtle'}>{ticket.status}</Badge></TableCell>
          <TableCell>{ticket.contactName}</TableCell><TableCell>{ticket.technicianName}</TableCell><TableCell className="tabular">{formatDate(ticket.createdAt)}</TableCell>
        </TableRow>)}</TableBody>
      </Table></div>}
      {tickets.available && tickets.items.length === 0 && <EmptyState message={openOnly ? t('service.noOpenTickets') : t('service.noTickets')} />}
      <ListFooter shown={tickets.items.length} total={tickets.total} hasMore={tickets.hasNextPage} loading={tickets.isFetchingNextPage} onMore={() => void tickets.fetchNextPage()} />
    </Panel>
    <div className={styles.grid}>
      <Panel title={t('service.devices')}>
        <div className={styles.row}>{summaryAvailable ? deviceTypes.map(type => <Badge key={type} appearance="outline" color={devicesByType[type] ? 'brand' : 'subtle'}>{t(`service.deviceTypes.${type}`)}: {formatNumber(devicesByType[type] ?? 0, 0)}</Badge>) : <Text className={catalog.muted}>{t('service.deviceTotalsUnknown')}</Text>}</div>
        <SavedServiceReadState checking={devices.checking} error={devices.error} onRetry={devices.refresh} />
        <ul className={styles.list}>{devices.items.map(device => <li key={device.id} className={styles.row}>
          {device.url ? <Link href={safeHttpUrl(device.url)} target="_blank" rel="noopener noreferrer">{device.machineName}</Link> : <Text>{device.machineName}</Text>}
          <Text className={catalog.muted}>{t(`service.deviceTypes.${device.type}`)}{device.os ? ` · ${device.os}` : ''} · {device.online ? t('service.online') : t('service.offline')}</Text>
        </li>)}</ul>
        {devices.available && devices.items.length === 0 && <Text className={catalog.muted}>{t('service.noDevices')}</Text>}
        <ListFooter shown={devices.items.length} total={devices.total} hasMore={devices.hasNextPage} loading={devices.isFetchingNextPage} onMore={() => void devices.fetchNextPage()} />
      </Panel>
      <Panel title={t('service.alerts')}>
        <SavedServiceReadState checking={alerts.checking} error={alerts.error} onRetry={alerts.refresh} />
        <ul className={styles.list}>{alerts.items.map(alert => <li key={alert.id} className={styles.row}>
          <Badge appearance="tint" color={alert.severity === 'Critical' ? 'danger' : 'warning'}>{t(`service.severities.${alert.severity}`)}</Badge>
          <Text>{alert.title}</Text><Text className={catalog.muted}>{alert.deviceName} · {formatDateTime(alert.createdAt)}</Text>
        </li>)}</ul>
        {alerts.available && alerts.items.length === 0 && <Text className={catalog.muted}>{t('service.noAlerts')}</Text>}
        <ListFooter shown={alerts.items.length} total={alerts.total} hasMore={alerts.hasNextPage} loading={alerts.isFetchingNextPage} onMore={() => void alerts.fetchNextPage()} />
      </Panel>
    </div>
    {canCreate && <CreateTicketDialog open={creating} organizationId={organizationId} owner={owner} onClose={() => setCreating(false)} onQueued={() => setRevision(value => value + 1)} />}
  </div>;
}
