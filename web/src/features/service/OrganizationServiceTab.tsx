import { useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  Link,
  MessageBar,
  MessageBarBody,
  Option,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Textarea,
  makeStyles,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Add20Regular, Open16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { ListFooter } from '../../shared/components/ListFooter';
import { Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatDateTime, formatNumber } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { useOrganizationContacts } from '../contacts/api';
import { useAlerts, useCreateTicketRequest, useDevices, useServiceSummary, useTicketOptions, useTicketRequests, useTickets } from './api';
import { deviceTypes } from './types';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  tiles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: tokens.spacingHorizontalM },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  tileValue: { fontSize: tokens.fontSizeHero700, lineHeight: tokens.lineHeightHero700, fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums' },
  tileLabel: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  alert: { color: tokens.colorPaletteRedForeground1 },
  warning: { color: tokens.colorPaletteDarkOrangeForeground1 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: tokens.spacingHorizontalL, alignItems: 'start' },
  row: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, alignItems: 'baseline', paddingBlock: tokens.spacingVerticalXS },
  list: { listStyle: 'none', margin: 0, padding: 0 },
  dialogGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}` },
  wide: { gridColumn: '1 / -1' },
});

/** Mirror of Atera for one organization: what is open now, what runs there and what alerts (FR-SRV-01/03). */
export function OrganizationServiceTab({ organizationId }: { organizationId: string }) {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const canCreate = useCan(Permissions.serviceWrite);
  const [openOnly, setOpenOnly] = useState(true);
  const [creating, setCreating] = useState(false);
  const restoreFocusTarget = useRestoreFocusTarget();
  const summary = useServiceSummary(organizationId);
  const tickets = useTickets({ organizationId, openOnly: openOnly || undefined });
  const devices = useDevices(organizationId);
  const alerts = useAlerts(organizationId);
  const requests = useTicketRequests(organizationId);

  if (summary.error) return <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />;
  const devicesByType = summary.data?.devices ?? {};
  const totalDevices = Object.values(devicesByType).reduce((sum, count) => sum + (count ?? 0), 0);

  return (
    <div className={styles.stack}>
      <div className={styles.tiles}>
        <div className={styles.tile}>
          <span className={styles.tileValue}>{summary.data?.openTickets ?? 0}</span>
          <span className={styles.tileLabel}>{t('service.openTickets')}</span>
        </div>
        <div className={styles.tile}>
          <span className={styles.tileValue}>{totalDevices}</span>
          <span className={styles.tileLabel}>
            {t('service.devicesOnline', { online: summary.data?.devicesOnline ?? 0 })}
          </span>
        </div>
        <div className={styles.tile}>
          <span className={`${styles.tileValue} ${(summary.data?.criticalAlerts ?? 0) > 0 ? styles.alert : ''}`}>{summary.data?.criticalAlerts ?? 0}</span>
          <span className={styles.tileLabel}>{t('service.criticalAlerts')}</span>
        </div>
        <div className={styles.tile}>
          <span className={`${styles.tileValue} ${(summary.data?.warningAlerts ?? 0) > 0 ? styles.warning : ''}`}>{summary.data?.warningAlerts ?? 0}</span>
          <span className={styles.tileLabel}>{t('service.warningAlerts')}</span>
        </div>
      </div>

      {requests.items.map((request) => (
        <MessageBar key={request.id} intent={request.status === 'Failed' ? 'error' : 'info'}>
          <MessageBarBody>
            {request.status === 'Failed' ? t('service.ticketFailed', { title: request.title, error: request.error }) : t('service.ticketPending', { title: request.title })}
          </MessageBarBody>
        </MessageBar>
      ))}
      <ListFooter shown={requests.items.length} total={requests.hasNextPage ? requests.total : null} hasMore={requests.hasNextPage} loading={requests.isFetchingNextPage} onMore={() => void requests.fetchNextPage()} />

      <Panel
        title={t('service.tickets')}
        actions={
          <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <Switch label={t('service.openOnly')} checked={openOnly} onChange={(_, d) => setOpenOnly(d.checked)} />
            {canCreate && (
              <Button {...restoreFocusTarget} size="small" icon={<Add20Regular />} onClick={() => setCreating(true)}>
                {t('service.newTicket')}
              </Button>
            )}
          </span>
        }
      >
        <div style={{ overflowX: 'auto' }}>
          <Table aria-label={t('service.tickets')} style={{ minWidth: 640 }}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('service.fields.ticket')}</TableHeaderCell>
                <TableHeaderCell>{t('service.fields.status')}</TableHeaderCell>
                <TableHeaderCell>{t('service.fields.contact')}</TableHeaderCell>
                <TableHeaderCell>{t('service.fields.technician')}</TableHeaderCell>
                <TableHeaderCell>{t('service.fields.created')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tickets.items.map((ticket) => (
                <TableRow key={ticket.id}>
                  <TableCell>
                    {ticket.url ? (
                      <Link href={ticket.url} target="_blank" rel="noopener noreferrer">
                        {ticket.title} <Open16Regular aria-hidden />
                      </Link>
                    ) : (
                      ticket.title
                    )}
                    <div className={catalog.sku}>
                      #{ticket.externalId}
                      {ticket.priority ? ` · ${ticket.priority}` : ''}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge appearance={ticket.isOpen ? 'tint' : 'outline'} color={ticket.isOpen ? 'brand' : 'subtle'}>
                      {ticket.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{ticket.contactName}</TableCell>
                  <TableCell>{ticket.technicianName}</TableCell>
                  <TableCell className="tabular">{formatDate(ticket.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {tickets.isSuccess && tickets.items.length === 0 && <EmptyState message={openOnly ? t('service.noOpenTickets') : t('service.noTickets')} />}
        <ListFooter shown={tickets.items.length} total={tickets.total} hasMore={tickets.hasNextPage} loading={tickets.isFetchingNextPage} onMore={() => void tickets.fetchNextPage()} />
      </Panel>

      <div className={styles.grid}>
        <Panel title={t('service.devices')}>
          <div className={styles.row}>
            {deviceTypes.map((type) => (
              <Badge key={type} appearance="outline" color={devicesByType[type] ? 'brand' : 'subtle'}>
                {t(`service.deviceTypes.${type}`)}: {formatNumber(devicesByType[type] ?? 0, 0)}
              </Badge>
            ))}
          </div>
          <ul className={styles.list}>
            {devices.items.map((device) => (
              <li key={device.id} className={styles.row}>
                {device.url ? (
                  <Link href={device.url} target="_blank" rel="noopener noreferrer">
                    {device.machineName}
                  </Link>
                ) : (
                  <Text>{device.machineName}</Text>
                )}
                <Text className={catalog.muted}>
                  {t(`service.deviceTypes.${device.type}`)}
                  {device.os ? ` · ${device.os}` : ''} · {device.online ? t('service.online') : t('service.offline')}
                </Text>
              </li>
            ))}
          </ul>
          {devices.isSuccess && devices.items.length === 0 && <Text className={catalog.muted}>{t('service.noDevices')}</Text>}
          <ListFooter shown={devices.items.length} total={devices.total} hasMore={devices.hasNextPage} loading={devices.isFetchingNextPage} onMore={() => void devices.fetchNextPage()} />
        </Panel>

        <Panel title={t('service.alerts')}>
          <ul className={styles.list}>
            {alerts.items.map((alert) => (
              <li key={alert.id} className={styles.row}>
                <Badge appearance="tint" color={alert.severity === 'Critical' ? 'danger' : 'warning'}>
                  {t(`service.severities.${alert.severity}`)}
                </Badge>
                <Text>{alert.title}</Text>
                <Text className={catalog.muted}>
                  {alert.deviceName} · {formatDateTime(alert.createdAt)}
                </Text>
              </li>
            ))}
          </ul>
          {alerts.isSuccess && alerts.items.length === 0 && <Text className={catalog.muted}>{t('service.noAlerts')}</Text>}
          <ListFooter shown={alerts.items.length} total={alerts.total} hasMore={alerts.hasNextPage} loading={alerts.isFetchingNextPage} onMore={() => void alerts.fetchNextPage()} />
          {summary.data?.lastSyncedAt && <Text className={catalog.muted}>{t('service.lastSynced', { at: formatDateTime(summary.data.lastSyncedAt) })}</Text>}
        </Panel>
      </div>

      <Dialog open={creating} onOpenChange={(_, d) => !d.open && setCreating(false)}>
        <DialogSurface>{creating && <CreateTicketForm organizationId={organizationId} onClose={() => setCreating(false)} />}</DialogSurface>
      </Dialog>
    </div>
  );
}

function CreateTicketForm({ organizationId, onClose }: { organizationId: string; onClose: () => void }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const create = useCreateTicketRequest();
  const contacts = useOrganizationContacts(organizationId, false);
  const options = useTicketOptions();
  const [contactId, setContactId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('Medium');
  const [type, setType] = useState('Incident');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const selected = contacts.data?.find((c) => c.contactId === contactId);
  const contactName = selected ? `${selected.firstName} ${selected.lastName}`.trim() : '';

  const submit = async () => {
    try {
      await create.mutateAsync({ organizationId, contactId, title: title.trim(), description: description.trim(), priority, type });
      notify(t('service.ticketQueued'));
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) setErrors(error.fieldErrors);
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{t('service.newTicket')}</DialogTitle>
        <DialogContent>
          {create.error && !(create.error instanceof ApiError && create.error.status === 400) && (
            <MessageBar intent="error" style={{ marginBottom: 12 }}>
              <MessageBarBody>{errorMessage(create.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <div className={styles.dialogGrid}>
            <Field label={t('service.fields.contact')} required className={styles.wide} validationMessage={errors.contactId}>
              <Dropdown value={contactName} selectedOptions={contactId ? [contactId] : []} onOptionSelect={(_, d) => setContactId(d.optionValue ?? null)}>
                {(contacts.data ?? []).map((contact) => {
                  const name = `${contact.firstName} ${contact.lastName}`.trim();
                  return (
                    <Option key={contact.contactId} value={contact.contactId} text={name}>
                      {name}
                      {contact.email ? ` · ${contact.email}` : ''}
                    </Option>
                  );
                })}
              </Dropdown>
            </Field>
            <Field label={t('service.fields.title')} required className={styles.wide} validationMessage={errors.title}>
              <Input value={title} onChange={(_, d) => setTitle(d.value)} />
            </Field>
            <Field label={t('service.fields.description')} required className={styles.wide} validationMessage={errors.description}>
              <Textarea value={description} onChange={(_, d) => setDescription(d.value)} resize="vertical" />
            </Field>
            <Field label={t('service.fields.priority')}>
              <Dropdown value={priority} selectedOptions={[priority]} onOptionSelect={(_, d) => setPriority(d.optionValue ?? 'Medium')}>
                {(options.data?.priorities ?? []).map((p) => (
                  <Option key={p} value={p}>
                    {p}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label={t('service.fields.type')}>
              <Dropdown value={type} selectedOptions={[type]} onOptionSelect={(_, d) => setType(d.optionValue ?? 'Incident')}>
                {(options.data?.types ?? []).map((v) => (
                  <Option key={v} value={v}>
                    {v}
                  </Option>
                ))}
              </Dropdown>
            </Field>
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={!contactId || !title.trim() || !description.trim() || create.isPending}>
            {t('service.createTicket')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}
