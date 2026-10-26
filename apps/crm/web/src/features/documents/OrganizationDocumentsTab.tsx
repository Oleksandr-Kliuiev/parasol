import {
  Button,
  Link,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { Document20Regular, Folder16Regular, Folder20Regular, Folder24Regular, FolderAdd20Regular, FolderProhibited24Regular, Open16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDateTime } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { useCreateDocumentFolder, useOrganizationDocuments } from './api';
import { safeHttpUrl } from '../../shared/utils/safeUrl';
import { ScrollTable } from '../../shared/components/ScrollTable';
import { IconChip, PersonCell, useSettingsStyles } from '../admin/settingsUi';
import { StoredReports } from './StoredReports';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: '16px' },
  // The customer's folder as a row of the integrations reference: chip, name and where it lives, the link on the right.
  head: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: '12px',
    rowGap: '8px',
    marginBottom: '16px',
    paddingTop: '12px',
    paddingBottom: '12px',
    paddingLeft: '12px',
    paddingRight: '16px',
    borderRadius: '14px',
    backgroundColor: h.well,
    minWidth: 0,
  },
  folder: { display: 'grid', gap: '2px', minWidth: 0, flex: '1 1 200px', overflowWrap: 'anywhere' },
  folderName: { fontWeight: tokens.fontWeightSemibold, fontSize: '14px', lineHeight: '20px' },
  link: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontWeight: tokens.fontWeightSemibold },
  table: { minWidth: '560px' },
  sizeHead: { '& .fui-TableHeaderCell__button': { justifyContent: 'flex-end' } },
  name: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, overflowWrap: 'anywhere' },
  fileLink: { fontWeight: tokens.fontWeightSemibold },
  muted: { color: h.muted, fontSize: '13px', fontVariantNumeric: 'tabular-nums' },
  // Not set up: the chip says "no connection", the empty state below says why.
});

/**
 * The customer's documents: the folder in SharePoint, which the CRM shows and links into (FR-DOC-01), and the monthly reports the CRM
 * files itself (M43). The reports describe the customer's IT, so they are shown to those who may also see the Drift tab.
 */
export function OrganizationDocumentsTab({ organizationId }: { organizationId: string }) {
  const styles = useStyles();
  const canCustomers = useCan(Permissions.customersRead);
  const canService = useCan(Permissions.serviceRead);
  const canReports = canCustomers && canService;
  return (
    <div className={styles.stack}>
      <SharePointDocuments organizationId={organizationId} />
      {canReports && <StoredReports organizationId={organizationId} />}
    </div>
  );
}

/** The customer's folder in SharePoint: the CRM shows what is in it and links into Microsoft 365 (FR-DOC-01). */
function SharePointDocuments({ organizationId }: { organizationId: string }) {
  const styles = useStyles();
  const settings = useSettingsStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const canWrite = useCan(Permissions.customersWrite);
  const { data, error, isPending, refetch } = useOrganizationDocuments(organizationId);
  const createFolder = useCreateDocumentFolder(organizationId);

  if (isPending) return <Spinner label={t('common.loading')} />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!data.available)
    return (
      <Panel title={t('documents.title')} icon={<Folder16Regular />}>
        {/* One picture for one state: the empty state's own icon says it. */}
        <EmptyState icon={<FolderProhibited24Regular />} message={t('documents.notConfigured')} />
      </Panel>
    );

  const create = async () => {
    try {
      await createFolder.mutateAsync();
      notify(t('documents.folderCreated'));
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <Panel title={t('documents.title')} icon={<Folder16Regular />}>
      <div className={styles.head}>
        {data.folder ? (
          <>
            <IconChip icon={<Folder20Regular />} tone="saffron" />
            <span className={styles.folder}>
              <Text className={styles.folderName}>{data.folder.name}</Text>
            </span>
            <Link className={styles.link} href={safeHttpUrl(data.folder.webUrl)} target="_blank" rel="noopener noreferrer">
              {t('documents.openInSharePoint')}
              <Open16Regular aria-hidden />
            </Link>
          </>
        ) : (
          <>
            <IconChip icon={<FolderAdd20Regular />} />
            <span className={styles.folder}>
              <Text className={settings.note}>{t('documents.noFolder')}</Text>
            </span>
            {canWrite && (
              <Button icon={<FolderAdd20Regular />} disabled={createFolder.isPending} onClick={() => void create()}>
                {t('documents.createFolder')}
              </Button>
            )}
          </>
        )}
      </div>

      {data.folder && data.items.length === 0 ? (
        <EmptyState icon={<Folder24Regular />} message={t('documents.empty')} />
      ) : (
        data.items.length > 0 && (
          <ScrollTable>
            <Table aria-label={t('documents.title')} className={styles.table}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{t('documents.fields.name')}</TableHeaderCell>
                  <TableHeaderCell className={mergeClasses(catalog.number, styles.sizeHead)}>{t('documents.fields.size')}</TableHeaderCell>
                  <TableHeaderCell>{t('documents.fields.modified')}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <span className={styles.name}>
                        <IconChip icon={item.isFolder ? <Folder20Regular /> : <Document20Regular />} tone={item.isFolder ? 'saffron' : 'iris'} small />
                        <Link className={styles.fileLink} href={safeHttpUrl(item.webUrl)} target="_blank" rel="noopener noreferrer">
                          {item.name}
                          <Open16Regular aria-hidden style={{ marginInlineStart: 4 }} />
                        </Link>
                      </span>
                    </TableCell>
                    <TableCell className={mergeClasses(catalog.number, styles.muted)}>{item.size === null ? '—' : formatSize(item.size)}</TableCell>
                    <TableCell>
                      {item.modifiedBy ? (
                        <PersonCell name={item.modifiedBy} detail={item.modifiedAt ? formatDateTime(item.modifiedAt) : undefined} size={28} />
                      ) : (
                        <span className={styles.muted}>{item.modifiedAt ? formatDateTime(item.modifiedAt) : '—'}</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollTable>
        )
      )}
    </Panel>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
