import { useState } from 'react';
import {
  Badge,
  Button,
  Link,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Skeleton,
  SkeletonItem,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  mergeClasses,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { h } from '../../app/hearth';
import { RecordCell } from '../organizations/RecordCell';
import { useRecordStyles } from '../organizations/recordStyles';
import { Add20Regular, MoreHorizontal20Regular, PeopleTeam24Regular, Star16Filled } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import type { OrganizationContactItem } from '../../api/types';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { useNotify } from '../../shared/components/useNotify';
import { NARROW_SCREEN, useMediaQuery } from '../../shared/utils/useMediaQuery';
import { useOrganizationContacts, useUpdateAffiliation } from './api';
import { AddContactDialog, EditAffiliationDialog } from './ContactDialogs';
import { ScrollTable } from '../../shared/components/ScrollTable';

const useStyles = makeStyles({
  toolbar: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '16px' },
  tableWrap: { borderRadius: '20px', border: `1px solid ${h.line}`, paddingLeft: '8px', paddingRight: '8px' },
  table: { minWidth: '720px' },
  name: { display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' },
  nameLink: { fontWeight: 700, color: 'inherit' },
  roles: { display: 'flex', flexWrap: 'wrap', gap: '4px' },
  // A former contact reads quieter but stays legible (4.5:1); the "Former" pill carries the state.
  inactive: { color: h.muted },
  card: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'start',
    gap: '8px',
    paddingTop: '12px',
    paddingBottom: '14px',
    paddingLeft: '14px',
    paddingRight: '8px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${h.line}`,
    borderRadius: '16px',
    boxShadow: tokens.shadow4,
  },
  cardBody: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 },
  cardLinks: { display: 'flex', flexDirection: 'column', gap: '4px', overflowWrap: 'anywhere', paddingLeft: '46px', fontSize: '13px' },
  cardRoles: { paddingLeft: '46px' },
});

export function ContactsTab({ organizationId, organizationName }: { organizationId: string; organizationName: string }) {
  const styles = useStyles();
  const record = useRecordStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const canWrite = useCan(Permissions.contactsWrite);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<OrganizationContactItem | null>(null);
  const { data, error, isPending, refetch } = useOrganizationContacts(organizationId, includeInactive);
  const update = useUpdateAffiliation(organizationId);
  // Dialogs here are controlled (no DialogTrigger): mark triggers so focus returns to them when a dialog closes.
  const restoreFocusTarget = useRestoreFocusTarget();
  const narrow = useMediaQuery(NARROW_SCREEN);

  const toggleActive = async (contact: OrganizationContactItem) => {
    await update.mutateAsync({
      contactId: contact.contactId,
      request: { title: contact.title, roles: contact.roles, isPrimary: false, isActive: !contact.isActive },
    });
    notify(t('contacts.saved'));
  };

  const actionsMenu = (contact: OrganizationContactItem) => (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <Button
          {...restoreFocusTarget}
          appearance="subtle"
          icon={<MoreHorizontal20Regular />}
          aria-label={t('contacts.actionsFor', { name: `${contact.firstName} ${contact.lastName}`.trim() })}
        />
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItem onClick={() => setEditing(contact)}>{t('common.edit')}</MenuItem>
          <MenuItem onClick={() => void toggleActive(contact)}>
            {contact.isActive ? t('contacts.deactivate') : t('contacts.reactivate')}
          </MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );

  const fullName = (contact: OrganizationContactItem) => `${contact.firstName} ${contact.lastName}`.trim();
  const nameNode = (contact: OrganizationContactItem) => (
    <span className={styles.name}>
      <AppLink to={`/contacts/${contact.contactId}`} className={styles.nameLink}>{fullName(contact)}</AppLink>
      {/* The word, not a star with a tooltip that only a mouse can reach. */}
      {contact.isPrimary && (
        <Badge appearance="tint" color="brand" size="small" icon={<Star16Filled />}>
          {t('contacts.primary')}
        </Badge>
      )}
      {!contact.isActive && (
        <Badge appearance="outline" color="informative" size="small">
          {t('contacts.inactive')}
        </Badge>
      )}
    </span>
  );
  const roleBadges = (contact: OrganizationContactItem, className?: string) => (
    <span className={mergeClasses(styles.roles, className)}>
      {contact.roles.map((role) => (
        <Badge key={role} appearance="tint" color="informative" size="small">
          {t(`roles.${role}`)}
        </Badge>
      ))}
    </span>
  );

  return (
    <>
      <div className={styles.toolbar}>
        <Switch id="contacts-include-inactive" label={t('contacts.includeInactive')} checked={includeInactive} onChange={(_, d) => setIncludeInactive(d.checked)} />
        {canWrite && (
          <Button {...restoreFocusTarget} appearance="primary" icon={<Add20Regular />} onClick={() => setAdding(true)}>
            {t('contacts.add')}
          </Button>
        )}
      </div>

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : narrow ? (
        <>
          <ul className={record.cards} aria-label={t('contacts.title')}>
            {data?.map((contact) => (
              <li key={contact.contactId} className={styles.card}>
                <div className={styles.cardBody}>
                  <RecordCell avatarName={fullName(contact)} size={36} name={nameNode(contact)} meta={[contact.title]} />
                  {contact.roles.length > 0 && roleBadges(contact, styles.cardRoles)}
                  {(contact.email || contact.phone || contact.mobilePhone) && (
                    <span className={styles.cardLinks}>
                      {contact.email && <Link href={`mailto:${contact.email}`}>{contact.email}</Link>}
                      {[contact.phone, contact.mobilePhone].filter(Boolean).map((phone) => (
                        <Link key={phone} href={`tel:${phone!.replace(/\s/g, '')}`}>
                          {phone}
                        </Link>
                      ))}
                    </span>
                  )}
                </div>
                {canWrite && actionsMenu(contact)}
              </li>
            ))}
          </ul>
          {data && data.length === 0 && <EmptyState icon={<PeopleTeam24Regular />} message={t('contacts.empty')} />}
        </>
      ) : (
        <ScrollTable className={styles.tableWrap}>
          <Table className={styles.table} aria-label={t('contacts.title')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell style={{ width: 260 }}>{t('contacts.columns.name')}</TableHeaderCell>
                <TableHeaderCell>{t('contacts.columns.roles')}</TableHeaderCell>
                <TableHeaderCell>{t('contacts.columns.email')}</TableHeaderCell>
                <TableHeaderCell>{t('contacts.columns.phone')}</TableHeaderCell>
                {canWrite && <TableHeaderCell style={{ width: 48 }} aria-label={t('contacts.columns.actions')} />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending && (
                <TableRow>
                  <TableCell>
                    <Skeleton aria-label={t('common.loading')}>
                      <SkeletonItem />
                    </Skeleton>
                  </TableCell>
                </TableRow>
              )}
              {data?.map((contact) => (
                <TableRow key={contact.contactId} className={contact.isActive ? undefined : styles.inactive}>
                  <TableCell>
                    <RecordCell avatarName={fullName(contact)} name={nameNode(contact)} meta={[contact.title]} />
                  </TableCell>
                  <TableCell>{roleBadges(contact)}</TableCell>
                  <TableCell>{contact.email && <Link href={`mailto:${contact.email}`}>{contact.email}</Link>}</TableCell>
                  <TableCell>
                    {[contact.phone, contact.mobilePhone].filter(Boolean).map((phone) => (
                      <Link key={phone} href={`tel:${phone!.replace(/\s/g, '')}`} style={{ display: 'block' }}>
                        {phone}
                      </Link>
                    ))}
                  </TableCell>
                  {canWrite && (
                    <TableCell>
                      {actionsMenu(contact)}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {data && data.length === 0 && <EmptyState icon={<PeopleTeam24Regular />} message={t('contacts.empty')} />}
        </ScrollTable>
      )}

      <AddContactDialog organizationId={organizationId} open={adding} onClose={() => setAdding(false)} />
      <EditAffiliationDialog organizationId={organizationId} organizationName={organizationName} contact={editing} onClose={() => setEditing(null)} />
    </>
  );
}
