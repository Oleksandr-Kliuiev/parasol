import { useState } from 'react';
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import type { ContactRole, OrganizationContactItem } from '../../api/types';
import { errorMessage } from '../../shared/utils/errors';
import { useNotify } from '../../shared/components/useNotify';
import { blankToNull } from '../../shared/utils/format';
import { useCreateContact, useUpdateAffiliation } from './api';
import { RolePicker } from './RolePicker';

const useStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))', gap: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}` },
  wide: { gridColumn: '1 / -1' },
});

const emptyPerson = { firstName: '', lastName: '', email: '', phone: '', mobilePhone: '', title: '' };

export function AddContactDialog({ organizationId, open, onClose }: { organizationId: string; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onClose()}>
      {/* The form mounts per opening, so every dialog starts empty. */}
      <DialogSurface>{open && <AddContactForm organizationId={organizationId} onClose={onClose} />}</DialogSurface>
    </Dialog>
  );
}

function AddContactForm({ organizationId, onClose }: { organizationId: string; onClose: () => void }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const create = useCreateContact(organizationId);
  const [values, setValues] = useState(emptyPerson);
  const [roles, setRoles] = useState<ContactRole[]>([]);
  const [isPrimary, setIsPrimary] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const set = (key: keyof typeof emptyPerson) => (_: unknown, d: { value: string }) => setValues((v) => ({ ...v, [key]: d.value }));

  const submit = async () => {
    if (!values.firstName.trim() && !values.lastName.trim()) {
      setFieldErrors({ firstName: t('contacts.nameRequired') });
      return;
    }
    try {
      const result = await create.mutateAsync({
        firstName: values.firstName.trim(),
        lastName: values.lastName.trim(),
        email: blankToNull(values.email),
        phone: blankToNull(values.phone),
        mobilePhone: blankToNull(values.mobilePhone),
        preferredLanguage: null,
        title: blankToNull(values.title),
        roles,
        isPrimary,
      });
      notify(result.linkedExisting ? t('contacts.linkedExisting') : t('contacts.created'), result.linkedExisting ? 'info' : 'success');
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) setFieldErrors(error.fieldErrors);
    }
  };

  const conflict = create.error instanceof ApiError && create.error.code === 'CUS_DUPLICATE_CONTACT';
  const field = (key: keyof typeof emptyPerson, type?: 'email' | 'tel', className?: string) => (
    <Field
      label={t(`contacts.fields.${key}`)}
      className={className}
      validationState={fieldErrors[key] ? 'error' : 'none'}
      validationMessage={fieldErrors[key]}
      hint={key === 'email' ? t('contacts.dialog.emailHint') : undefined}
    >
      <Input type={type} value={values[key]} onChange={set(key)} />
    </Field>
  );

  return (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogBody>
            <DialogTitle>{t('contacts.dialog.createTitle')}</DialogTitle>
            <DialogContent>
              {create.error && !(create.error instanceof ApiError && create.error.status === 400) && (
                <MessageBar intent="error" style={{ marginBottom: 12 }}>
                  <MessageBarBody>{conflict ? t('contacts.duplicateInOrganization') : errorMessage(create.error, t)}</MessageBarBody>
                </MessageBar>
              )}
              <div className={styles.grid}>
                {field('firstName')}
                {field('lastName')}
                {field('email', 'email', styles.wide)}
                {field('phone', 'tel')}
                {field('mobilePhone', 'tel')}
                {field('title', undefined, styles.wide)}
                <RolePicker label={t('contacts.fields.roles')} className={styles.wide} value={roles} onChange={setRoles} />
                <Checkbox
                  id="contact-new-primary"
                  className={styles.wide}
                  label={t('contacts.fields.isPrimary')}
                  checked={isPrimary}
                  onChange={(_, d) => setIsPrimary(Boolean(d.checked))}
                />
              </div>
            </DialogContent>
            <DialogActions>
              <Button onClick={onClose}>{t('common.cancel')}</Button>
              <Button appearance="primary" type="submit" disabled={create.isPending}>
                {create.isPending ? t('common.saving') : t('contacts.add')}
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
  );
}

export function EditAffiliationDialog({
  organizationId,
  organizationName,
  contact,
  onClose,
}: {
  organizationId: string;
  organizationName: string;
  contact: OrganizationContactItem | null;
  onClose: () => void;
}) {
  if (!contact) return null;
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <EditAffiliationForm
          key={contact.contactId}
          organizationId={organizationId}
          organizationName={organizationName}
          contact={contact}
          onClose={onClose}
        />
      </DialogSurface>
    </Dialog>
  );
}

function EditAffiliationForm({
  organizationId,
  organizationName,
  contact,
  onClose,
}: {
  organizationId: string;
  organizationName: string;
  contact: OrganizationContactItem;
  onClose: () => void;
}) {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const update = useUpdateAffiliation(organizationId);
  const [title, setTitle] = useState(contact.title ?? '');
  const [roles, setRoles] = useState<ContactRole[]>(contact.roles);
  const [isPrimary, setIsPrimary] = useState(contact.isPrimary);
  const [isActive, setIsActive] = useState(contact.isActive);

  const submit = async () => {
    await update.mutateAsync({ contactId: contact.contactId, request: { title: blankToNull(title), roles, isPrimary: isActive && isPrimary, isActive } });
    notify(t('contacts.saved'));
    onClose();
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <DialogBody>
        <DialogTitle>{t('contacts.dialog.editTitle', { organization: organizationName })}</DialogTitle>
        <DialogContent>
          {update.error && (
            <MessageBar intent="error" style={{ marginBottom: 12 }}>
              <MessageBarBody>{errorMessage(update.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <div className={styles.grid}>
            <Field label={t('contacts.fields.title')} className={styles.wide}>
              <Input value={title} onChange={(_, d) => setTitle(d.value)} />
            </Field>
            <RolePicker label={t('contacts.fields.roles')} className={styles.wide} value={roles} onChange={setRoles} />
            <Checkbox
              id="affiliation-primary"
              label={t('contacts.fields.isPrimary')}
              checked={isActive && isPrimary}
              disabled={!isActive}
              onChange={(_, d) => setIsPrimary(Boolean(d.checked))}
            />
            <Checkbox id="affiliation-active" label={t('contacts.fields.isActive')} checked={isActive} onChange={(_, d) => setIsActive(Boolean(d.checked))} />
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={update.isPending}>
            {update.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}
