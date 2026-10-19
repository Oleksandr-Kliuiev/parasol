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
  TableCellLayout,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Tooltip,
  makeStyles,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Add20Regular, MoreHorizontal20Regular, Star16Filled } from '@fluentui/react-icons';
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
  toolbar: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalM },
  tableWrap: { overflowX: 'auto', backgroundColor: tokens.colorNeutralBackground1, borderRadius: tokens.borderRadiusLarge, border: `1px solid ${tokens.colorNeutralStroke2}` },
  table: { minWidth: '720px' },
  name: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, fontWeight: tokens.fontWeightSemibold, whiteSpace: 'nowrap' },
  star: { color: tokens.colorPaletteMarigoldForeground1 },
  roles: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXXS },
  inactive: { color: tokens.colorNeutralForegroundDisabled },
  cards: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  card: {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  cardBody: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  cardLinks: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, overflowWrap: 'anywhere' },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
});

export function ContactsTab({ organizationId, organizationName }: { organizationId: string; organizationName: string }) {
  const styles = useStyles();
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
          <ul className={styles.cards} aria-label={t('contacts.title')}>
            {data?.map((contact) => (
              <li key={contact.contactId} className={styles.card}>
                <div className={styles.cardBody}>
                  <span className={styles.name}>
                    <AppLink to={`/contacts/${contact.contactId}`}>{fullName(contact)}</AppLink>
                    {contact.isPrimary && (
                      <Tooltip content={t('contacts.primary')} relationship="label">
                        <Star16Filled className={styles.star} />
                      </Tooltip>
                    )}
                    {!contact.isActive && (
                      <Badge appearance="outline" color="informative" size="small">
                        {t('contacts.inactive')}
                      </Badge>
                    )}
                  </span>
                  {contact.title && <span className={styles.muted}>{contact.title}</span>}
                  {contact.roles.length > 0 && (
                    <span className={styles.roles}>
                      {contact.roles.map((role) => (
                        <Badge key={role} appearance="tint" color="informative" size="small">
                          {t(`roles.${role}`)}
                        </Badge>
                      ))}
                    </span>
                  )}
                  <span className={styles.cardLinks}>
                    {contact.email && <Link href={`mailto:${contact.email}`}>{contact.email}</Link>}
                    {[contact.phone, contact.mobilePhone].filter(Boolean).map((phone) => (
                      <Link key={phone} href={`tel:${phone!.replace(/\s/g, '')}`}>
                        {phone}
                      </Link>
                    ))}
                  </span>
                </div>
                {canWrite && actionsMenu(contact)}
              </li>
            ))}
          </ul>
          {data && data.length === 0 && <EmptyState message={t('contacts.empty')} />}
        </>
      ) : (
        <ScrollTable className={styles.tableWrap}>
          <Table className={styles.table} aria-label={t('contacts.title')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('contacts.columns.name')}</TableHeaderCell>
                <TableHeaderCell>{t('contacts.columns.title')}</TableHeaderCell>
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
                    <TableCellLayout>
                      <span className={styles.name}>
                        <AppLink to={`/contacts/${contact.contactId}`}>{fullName(contact)}</AppLink>
                        {contact.isPrimary && (
                          <Tooltip content={t('contacts.primary')} relationship="label">
                            <Star16Filled className={styles.star} />
                          </Tooltip>
                        )}
                        {!contact.isActive && (
                          <Badge appearance="outline" color="informative" size="small">
                            {t('contacts.inactive')}
                          </Badge>
                        )}
                      </span>
                    </TableCellLayout>
                  </TableCell>
                  <TableCell>{contact.title}</TableCell>
                  <TableCell>
                    <span className={styles.roles}>
                      {contact.roles.map((role) => (
                        <Badge key={role} appearance="tint" color="informative" size="small">
                          {t(`roles.${role}`)}
                        </Badge>
                      ))}
                    </span>
                  </TableCell>
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
          {data && data.length === 0 && <EmptyState message={t('contacts.empty')} />}
        </ScrollTable>
      )}

      <AddContactDialog organizationId={organizationId} open={adding} onClose={() => setAdding(false)} />
      <EditAffiliationDialog organizationId={organizationId} organizationName={organizationName} contact={editing} onClose={() => setEditing(null)} />
    </>
  );
}
