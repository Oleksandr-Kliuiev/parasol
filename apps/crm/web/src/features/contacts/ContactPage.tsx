import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  Badge,
  Button,
  Field,
  Input,
  Link,
  MessageBar,
  MessageBarBody,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
} from '@fluentui/react-components';
import { Building16Regular, History16Regular, Person16Regular } from '@fluentui/react-icons';
import { ProfileHeader } from '../organizations/ProfileHeader';
import { RecordCell } from '../organizations/RecordCell';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import type { Contact } from '../../api/types';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { ErrorState } from '../../shared/components/ErrorState';
import { errorMessage } from '../../shared/utils/errors';
import { ConflictBar } from '../../shared/forms/ConflictBar';
import { UnsavedChangesDialog } from '../../shared/forms/UnsavedChangesDialog';
import { useConflictFlow } from '../../shared/forms/useConflictFlow';
import { useUnsavedChanges } from '../../shared/forms/useUnsavedChanges';
import { Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { blankToNull } from '../../shared/utils/format';
import { HistoryList } from '../audit/HistoryList';
import { NotFoundPage } from '../errors/NotFoundPage';
import { useContact, useUpdateContactPerson } from './api';
import { ScrollTable } from '../../shared/components/ScrollTable';

const useStyles = makeStyles({
  layout: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))', gap: '16px', alignItems: 'start' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))', gap: '14px 16px', alignItems: 'start', '& .fui-Dropdown, & .fui-Combobox': { minWidth: 0 } },
  actions: { display: 'flex', justifyContent: 'flex-end', marginTop: '16px' },
  // The table sits flush in its panel: no second card around it.
  tableWrap: { border: 'none', borderRadius: 0, boxShadow: 'none', paddingLeft: '8px', paddingRight: '8px' },
  orgLink: { fontWeight: 700, color: 'inherit' },
  badges: { display: 'inline-flex', flexWrap: 'wrap', gap: '4px', marginLeft: '6px', verticalAlign: 'middle' },
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
  // "Keep my changes" after a conflict: the draft laid over the latest version, applied once the form is rebuilt from it.
  const [carried, setCarried] = useState<PersonValues | null>(null);

  if (isPending) return <Spinner label={t('common.loading')} />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const contact = data.data;
  const fullName = `${contact.firstName} ${contact.lastName}`.trim();
  const firstOrganization = contact.affiliations.find((a) => a.isActive) ?? contact.affiliations[0];

  return (
    <>
      <ProfileHeader
        title={fullName}
        meta={[
          contact.email && <Link href={`mailto:${contact.email}`}>{contact.email}</Link>,
          // A number on the card can be called from a phone, as in the customer's contact list.
          ...[contact.mobilePhone, contact.phone].filter((phone, i, all): phone is string => Boolean(phone) && all.indexOf(phone) === i)
            .map((phone) => <Link key={phone} href={`tel:${phone.replace(/\s/g, '')}`}>{phone}</Link>),
          firstOrganization && <span>{firstOrganization.organizationName}</span>,
        ]}
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
        <PersonForm
          key={data.etag ?? contact.id}
          contact={contact}
          etag={data.etag}
          carried={carried}
          onReload={() => {
            setCarried(null);
            void refetch();
          }}
          onKeepMine={(values) => {
            setCarried(values);
            void refetch();
          }}
        />

        <Panel title={t('contacts.affiliations')} icon={<Building16Regular />} flush>
          <ScrollTable className={styles.tableWrap}>
            <Table size="small">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell style={{ width: '48%' }}>{t('organizations.columns.name')}</TableHeaderCell>
                  <TableHeaderCell>{t('contacts.columns.title')}</TableHeaderCell>
                  <TableHeaderCell>{t('contacts.columns.roles')}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contact.affiliations.map((a) => (
                  <TableRow key={a.organizationId}>
                    <TableCell>
                      <RecordCell
                        avatarName={a.organizationName}
                        name={
                          <>
                            <AppLink to={`/organizations/${a.organizationId}?tab=contacts`} className={styles.orgLink}>{a.organizationName}</AppLink>
                            {(a.isPrimary || !a.isActive) && (
                              <span className={styles.badges}>
                                {a.isPrimary && (
                                  <Badge size="small" appearance="tint" color="warning">
                                    {t('contacts.primary')}
                                  </Badge>
                                )}
                                {!a.isActive && (
                                  <Badge size="small" appearance="outline" color="informative">
                                    {t('contacts.inactive')}
                                  </Badge>
                                )}
                              </span>
                            )}
                          </>
                        }
                      />
                    </TableCell>
                    <TableCell>{a.title}</TableCell>
                    <TableCell>{a.roles.map((r) => t(`roles.${r}`)).join(', ')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollTable>
        </Panel>

        <Panel title={t('history.title')} icon={<History16Regular />}>
          <HistoryList module="customers" entityType="Contact" entityId={contact.id} compact />
        </Panel>
      </div>
    </>
  );
}

interface PersonFormProps {
  contact: Contact;
  etag: string | null;
  carried: PersonValues | null;
  onReload: () => void;
  onKeepMine: (values: PersonValues) => void;
}

function PersonForm({ contact, etag, carried, onReload, onKeepMine }: PersonFormProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const update = useUpdateContactPerson(contact.id);
  const canWrite = useCan(Permissions.contactsWrite);
  const base = useMemo(() => toValues(contact), [contact]);
  const [current, setValues] = useState<PersonValues>(carried ?? base);
  const { blocker } = useUnsavedChanges(JSON.stringify(current) !== JSON.stringify(base));
  const conflictError = update.error instanceof ApiError && update.error.status === 412 ? update.error : null;
  const conflictFlow = useConflictFlow<PersonValues>({
    conflict: conflictError,
    base,
    getMine: () => current,
    readLatest: async () => toValues((await api.get<Contact>(`/api/v1/customers/contacts/${contact.id}`)).data),
    labelOf: (path) => t(`contacts.fields.${path}`),
  });

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
  const conflict = conflictError !== null;

  return (
        <Panel title={t('contacts.person')} icon={<Person16Regular />}>
          <UnsavedChangesDialog blocker={blocker} />
          {conflict && (
            <ConflictBar
              details={conflictFlow.details}
              onUseLatest={() => {
                update.reset();
                onReload();
              }}
              onKeepMine={() => {
                const rebased = conflictFlow.keepMine();
                if (!rebased) return;
                update.reset();
                onKeepMine(rebased);
              }}
            />
          )}
          {update.error && !conflict && (
            <MessageBar intent="error" style={{ marginBottom: 12 }}>
              <MessageBarBody>{duplicate ? t('contacts.duplicateEmail') : errorMessage(update.error, t)}</MessageBarBody>
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
