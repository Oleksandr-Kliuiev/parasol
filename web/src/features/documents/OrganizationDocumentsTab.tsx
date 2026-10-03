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
  tokens,
} from '@fluentui/react-components';
import { FolderAdd20Regular, Folder20Regular, Document20Regular, Open16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDateTime } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { useCreateDocumentFolder, useOrganizationDocuments } from './api';

const useStyles = makeStyles({
  head: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalM },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  name: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
});

/** The customer's folder in SharePoint: the CRM shows what is in it and links into Microsoft 365 (FR-DOC-01). */
export function OrganizationDocumentsTab({ organizationId }: { organizationId: string }) {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const canWrite = useCan(Permissions.customersWrite);
  const { data, error, isPending, refetch } = useOrganizationDocuments(organizationId);
  const createFolder = useCreateDocumentFolder(organizationId);

  if (isPending) return <Spinner label={t('common.loading')} />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!data.available) return <EmptyState message={t('documents.notConfigured')} />;

  const create = async () => {
    try {
      await createFolder.mutateAsync();
      notify(t('documents.folderCreated'));
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <Panel title={t('documents.title')}>
      <div className={styles.head}>
        {data.folder ? (
          <>
            <Text className={styles.name}>
              <Folder20Regular aria-hidden />
              {data.folder.name}
            </Text>
            <Link href={data.folder.webUrl} target="_blank" rel="noopener noreferrer">
              {t('documents.openInSharePoint')}
            </Link>
          </>
        ) : (
          <>
            <Text className={styles.muted}>{t('documents.noFolder')}</Text>
            {canWrite && (
              <Button icon={<FolderAdd20Regular />} disabled={createFolder.isPending} onClick={() => void create()}>
                {t('documents.createFolder')}
              </Button>
            )}
          </>
        )}
      </div>

      {data.folder && data.items.length === 0 ? (
        <EmptyState message={t('documents.empty')} />
      ) : (
        data.items.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <Table aria-label={t('documents.title')} style={{ minWidth: 520 }}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{t('documents.fields.name')}</TableHeaderCell>
                  <TableHeaderCell className={catalog.number}>{t('documents.fields.size')}</TableHeaderCell>
                  <TableHeaderCell>{t('documents.fields.modified')}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <span className={styles.name}>
                        {item.isFolder ? <Folder20Regular aria-hidden /> : <Document20Regular aria-hidden />}
                        <Link href={item.webUrl} target="_blank" rel="noopener noreferrer">
                          {item.name}
                          <Open16Regular aria-hidden style={{ marginInlineStart: 4 }} />
                        </Link>
                      </span>
                    </TableCell>
                    <TableCell className={catalog.number}>{item.size === null ? '—' : formatSize(item.size)}</TableCell>
                    <TableCell>
                      {item.modifiedAt ? formatDateTime(item.modifiedAt) : '—'}
                      {item.modifiedBy && <div className={styles.muted}>{item.modifiedBy}</div>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
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
