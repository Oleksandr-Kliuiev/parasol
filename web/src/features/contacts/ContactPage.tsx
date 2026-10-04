import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  Badge,
  Button,
  Field,
  Input,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import type { Contact } from '../../api/types';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { ErrorState } from '../../shared/components/ErrorState';
import { errorMessage } from '../../shared/utils/errors';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { blankToNull } from '../../shared/utils/format';
import { HistoryList } from '../audit/HistoryList';
import { NotFoundPage } from '../errors/NotFoundPage';
import { useContact, useUpdateContactPerson } from './api';

const useStyles = makeStyles({
  layout: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: tokens.spacingHorizontalL, alignItems: 'start' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}` },
  actions: { display: 'flex', justifyContent: 'flex-end', marginTop: tokens.spacingVerticalM },
  tableWrap: { overflowX: 'auto' },
});

const fields = ['firstName', 'lastName', 'email', 'phone', 'mobilePhone'] as const;
type PersonValues = Record<(typeof fields)[number], string>;

const toValues = (c: Contact): PersonValues => ({
  firstName: c.firstName,
  lastName: c.lastName,
  email: c.email ?? '',
  phone: c.phone ?? '',
  mobilePhone: c.mobilePhone ?? '',
});

export function ContactPage() {
  const styles = useStyles();
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const canPrivacy = useCan(Permissions.privacyManage);
  const { data, error, isPending, refetch } = useContact(id);

  if (isPending) return <Spinner label={t('common.loading')} />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const contact = data.data;
  const fullName = `${contact.firstName} ${contact.lastName}`.trim();
  const firstOrganization = contact.affiliations.find((a) => a.isActive) ?? contact.affiliations[0];

  return (
    <>
      <PageHeader
        title={fullName}
        back={firstOrganization ? { to: `/organizations/${firstOrganization.organizationId}?tab=contacts`, label: firstOrganization.organizationName } : undefined}
        actions={
          canPrivacy ? (
            // DEV-11: the person's name goes along in the navigation state, not in the address.
            <Button onClick={() => navigate(`/admin/privacy/new?subjectKind=Contact&subjectId=${contact.id}`, { state: { subjectName: fullName } })}>
              {t('privacy.new.button')}
            </Button>
          ) : undefined
        }
      />
      <div className={styles.layout}>
        {/* Remounts with fresh values whenever a save or reload produces a new version. */}
        <PersonForm key={data.etag ?? contact.id} contact={contact} etag={data.etag} onReload={() => void refetch()} />

        <Panel title={t('contacts.affiliations')}>
          <div className={styles.tableWrap}>
            <Table size="small">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{t('organizations.columns.name')}</TableHeaderCell>
                  <TableHeaderCell>{t('contacts.columns.title')}</TableHeaderCell>
                  <TableHeaderCell>{t('contacts.columns.roles')}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contact.affiliations.map((a) => (
                  <TableRow key={a.organizationId}>
                    <TableCell>
                      <AppLink to={`/organizations/${a.organizationId}?tab=contacts`}>{a.organizationName}</AppLink>{' '}
                      {a.isPrimary && (
                        <Badge size="small" appearance="tint" color="warning">
                          {t('contacts.primary')}
                        </Badge>
                      )}
                      {!a.isActive && (
                        <Badge size="small" appearance="outline" color="subtle">
                          {t('contacts.inactive')}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{a.title}</TableCell>
                    <TableCell>{a.roles.map((r) => t(`roles.${r}`)).join(', ')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Panel>

        <Panel title={t('history.title')}>
          <HistoryList module="customers" entityType="Contact" entityId={contact.id} compact />
        </Panel>
      </div>
    </>
  );
}

function PersonForm({ contact, etag, onReload }: { contact: Contact; etag: string | null; onReload: () => void }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const update = useUpdateContactPerson(contact.id);
  const canWrite = useCan(Permissions.contactsWrite);
  const [current, setValues] = useState<PersonValues>(() => toValues(contact));

  const save = async () => {
    try {
      await update.mutateAsync({
        etag,
        request: {
          firstName: current.firstName.trim(),
          lastName: current.lastName.trim(),
          email: blankToNull(current.email),
          phone: blankToNull(current.phone),
          mobilePhone: blankToNull(current.mobilePhone),
          preferredLanguage: contact.preferredLanguage,
        },
      });
      notify(t('contacts.saved'));
    } catch {
      // Rendered below from update.error.
    }
  };

  const duplicate = update.error instanceof ApiError && update.error.code === 'CUS_DUPLICATE_CONTACT_EMAIL';
  const conflict = update.error instanceof ApiError && update.error.status === 412;

  return (
        <Panel title={t('contacts.person')}>
          {update.error && (
            <MessageBar intent="error" style={{ marginBottom: 12 }}>
              <MessageBarBody>{duplicate ? t('contacts.duplicateEmail') : errorMessage(update.error, t)}</MessageBarBody>
              {conflict && (
                <MessageBarActions>
                  <Button
                    size="small"
                    onClick={() => {
                      update.reset();
                      onReload();
                    }}
                  >
                    {t('common.reload')}
                  </Button>
                </MessageBarActions>
              )}
            </MessageBar>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className={styles.grid}>
              {fields.map((field) => (
                <Field key={field} label={t(`contacts.fields.${field}`)}>
                  <Input
                    type={field === 'email' ? 'email' : field.toLowerCase().includes('phone') ? 'tel' : 'text'}
                    value={current[field]}
                    readOnly={!canWrite}
                    onChange={(_, d) => setValues({ ...current, [field]: d.value })}
                  />
                </Field>
              ))}
            </div>
            {canWrite && (
              <div className={styles.actions}>
                <Button appearance="primary" type="submit" disabled={update.isPending}>
                  {update.isPending ? t('common.saving') : t('common.save')}
                </Button>
              </div>
            )}
          </form>
        </Panel>
  );
}
