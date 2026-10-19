import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Dropdown, Field, Input,
  MessageBar, MessageBarBody, Option, Spinner, Textarea, makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { ErrorState } from '../../shared/components/ErrorState';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { useCreateTicketRequest, useTicketContacts, useTicketOptions } from './api';

const useStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))', gap: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}` },
  wide: { gridColumn: '1 / -1' },
});

/** The existing queued Atera request form, with the customer/employee lifetime owned by its parent. */
export function CreateTicketDialog({ open, organizationId, owner, onClose, onQueued }: { open: boolean; organizationId: string; owner: string; onClose: () => void; onQueued: () => void }) {
  return <Dialog open={open} onOpenChange={(_, data) => !data.open && onClose()}>
    <DialogSurface>{open && <CreateTicketForm organizationId={organizationId} owner={owner} onClose={onClose} onQueued={onQueued} />}</DialogSurface>
  </Dialog>;
}

function CreateTicketForm({ organizationId, owner, onClose, onQueued }: { organizationId: string; owner: string; onClose: () => void; onQueued: () => void }) {
  const styles = useStyles(); const { t } = useTranslation(); const notify = useNotify();
  const create = useCreateTicketRequest(); const contacts = useTicketContacts(organizationId, owner); const options = useTicketOptions(owner);
  const alive = useRef(false); const sending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [contactId, setContactId] = useState<string | null>(null); const [title, setTitle] = useState(''); const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('Medium'); const [type, setType] = useState('Incident'); const [errors, setErrors] = useState<Record<string, string>>({});
  const selected = contacts.data?.find(contact => contact.contactId === contactId);
  const contactName = selected ? `${selected.firstName} ${selected.lastName}`.trim() : '';
  const unavailable = contacts.isFetching || options.isFetching || contacts.isError || options.isError;
  const invalid = !contactId || !title.trim() || !description.trim() || unavailable;
  const submit = async () => {
    if (!alive.current || sending.current || invalid) return;
    sending.current = true;
    try {
      await create.mutateAsync({ organizationId, contactId, title: title.trim(), description: description.trim(), priority, type });
      if (!alive.current) return; notify(t('service.ticketQueued')); onQueued(); onClose();
    } catch (error) {
      if (alive.current && error instanceof ApiError && error.status === 400) setErrors(error.fieldErrors);
    } finally { sending.current = false; }
  };
  return <form onSubmit={event => { event.preventDefault(); void submit(); }}><DialogBody>
    <DialogTitle>{t('service.newTicket')}</DialogTitle>
    <DialogContent>
      {create.error && !(create.error instanceof ApiError && create.error.status === 400) && <MessageBar intent="error" style={{ marginBottom: 12 }}>
        <MessageBarBody>{errorMessage(create.error, t)}</MessageBarBody></MessageBar>}
      {(contacts.isFetching || options.isFetching) && <Spinner size="small" label={t('common.loading')} />}
      {contacts.isError && <ErrorState error={contacts.error} onRetry={() => void contacts.refetch()} />}
      {options.isError && <ErrorState error={options.error} onRetry={() => void options.refetch()} />}
      <div className={styles.grid}>
        <Field label={t('service.fields.contact')} required className={styles.wide} validationMessage={errors.contactId}>
          <Dropdown disabled={contacts.isFetching || contacts.isError || create.isPending} value={contactName} selectedOptions={contactId ? [contactId] : []}
            onOptionSelect={(_, data) => setContactId(data.optionValue ?? null)}>
            {!contacts.isFetching && !contacts.isError && (contacts.data ?? []).map(contact => {
              const name = `${contact.firstName} ${contact.lastName}`.trim();
              return <Option key={contact.contactId} value={contact.contactId} text={name}>{name}{contact.email ? ` · ${contact.email}` : ''}</Option>;
            })}
          </Dropdown>
        </Field>
        <Field label={t('service.fields.title')} required className={styles.wide} validationMessage={errors.title}>
          <Input value={title} onChange={(_, data) => setTitle(data.value)} />
        </Field>
        <Field label={t('service.fields.description')} required className={styles.wide} validationMessage={errors.description}>
          <Textarea value={description} onChange={(_, data) => setDescription(data.value)} resize="vertical" />
        </Field>
        <Field label={t('service.fields.priority')}>
          <Dropdown disabled={options.isFetching || options.isError || create.isPending} value={priority} selectedOptions={[priority]} onOptionSelect={(_, data) => setPriority(data.optionValue ?? 'Medium')}>
            {!options.isFetching && !options.isError && (options.data?.priorities ?? []).map(value => <Option key={value} value={value}>{value}</Option>)}
          </Dropdown>
        </Field>
        <Field label={t('service.fields.type')}>
          <Dropdown disabled={options.isFetching || options.isError || create.isPending} value={type} selectedOptions={[type]} onOptionSelect={(_, data) => setType(data.optionValue ?? 'Incident')}>
            {!options.isFetching && !options.isError && (options.data?.types ?? []).map(value => <Option key={value} value={value}>{value}</Option>)}
          </Dropdown>
        </Field>
      </div>
    </DialogContent>
    <DialogActions><Button onClick={onClose}>{t('common.cancel')}</Button>
      <Button appearance="primary" type="submit" disabled={invalid || create.isPending}>{t('service.createTicket')}</Button></DialogActions>
  </DialogBody></form>;
}
