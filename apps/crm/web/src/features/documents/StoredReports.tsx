import { Badge, Button, Spinner, Text, makeStyles, tokens } from '@fluentui/react-components';
import { ArrowDownload16Regular, DocumentPdf16Regular, DocumentPdf20Regular, DocumentPdf24Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { ListFooter } from '../../shared/components/ListFooter';
import { Panel } from '../../shared/components/Panel';
import { formatDate, formatDateTime } from '../../shared/utils/format';
import { IconChip } from '../admin/settingsUi';
import { useStoredDocuments } from './api';
import { fileSize, reportMonth, useStoredDownload } from './storedFiles';

const useStyles = makeStyles({
  body: { display: 'grid', gap: '12px' },
  intro: { color: h.muted, fontSize: '13px', lineHeight: '18px' },
  hint: { color: h.muted, fontSize: '12px', lineHeight: '16px' },
  // The reports as rows in one frame: what it is and for which month, when it was filed, and its download.
  frame: { listStyleType: 'none', margin: 0, padding: 0, border: `1px solid ${h.line}`, borderRadius: '14px', overflow: 'hidden' },
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '8px 12px',
    paddingTop: '12px',
    paddingBottom: '12px',
    paddingLeft: '14px',
    paddingRight: '14px',
    borderTop: `1px solid ${h.line}`,
    ':first-child': { borderTop: 'none' },
  },
  main: { display: 'grid', gap: '2px', flexGrow: 1, flexShrink: 1, flexBasis: '220px', minWidth: 0, overflowWrap: 'anywhere' },
  name: { fontWeight: tokens.fontWeightSemibold, fontSize: '14px', lineHeight: '20px' },
  meta: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', color: h.muted, fontSize: '13px', lineHeight: '18px', fontVariantNumeric: 'tabular-nums' },
  note: { color: h.muted, fontSize: '12.5px', lineHeight: '18px', margin: 0 },
  error: { color: h.emberT, margin: 0, fontSize: '12.5px', lineHeight: '18px' },
});

/**
 * The monthly reports the CRM filed for the customer (M43): Huntress's own PDF and Parasoll's summary of each month, kept unchanged
 * in Parasoll beside the customer's SharePoint folder. A download is checked against the fingerprint the file was filed with; a
 * summary made after the month had closed says "Reconstructed".
 */
export function StoredReports({ organizationId }: { organizationId: string }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const list = useStoredDocuments(organizationId);
  const { busy, failed, save } = useStoredDownload(organizationId);

  return (
    <Panel title={t('documents.stored.title')} icon={<DocumentPdf16Regular />}>
      <div className={styles.body}>
        <Text className={styles.intro}>{t('documents.stored.intro')}</Text>
        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.isPending ? (
          <Spinner size="small" label={t('common.loading')} />
        ) : list.items.length === 0 ? (
          <EmptyState compact icon={<DocumentPdf24Regular />} message={t('documents.stored.empty')} />
        ) : (
          <>
            <ul className={styles.frame} aria-label={t('documents.stored.title')}>
              {list.items.map((document) => {
                const name = t('documents.stored.name', { kind: t(`documents.stored.kinds.${document.kind}`), month: reportMonth(document.periodStart) });
                return (
                  <li key={document.id} className={styles.row}>
                    <IconChip icon={<DocumentPdf20Regular />} tone={document.kind === 'huntress-monthly' ? 'iris' : 'saffron'} small />
                    <span className={styles.main}>
                      <Text className={styles.name}>{name}</Text>
                      <span className={styles.meta}>
                        <time dateTime={document.storedAt} title={formatDateTime(document.storedAt)}>
                          {t('documents.stored.stored', { date: formatDate(document.storedAt), size: fileSize(document.length) })}
                        </time>
                        {document.provenance === 'Reconstructed' && (
                          <Badge appearance="tint" color="warning">{t('documents.stored.reconstructed')}</Badge>
                        )}
                      </span>
                      {/* Said in words, not in a tooltip keyboard and touch never get. */}
                      {document.provenance === 'Reconstructed' && <Text className={styles.hint}>{t('documents.stored.reconstructedHint')}</Text>}
                    </span>
                    <Button size="small" icon={<ArrowDownload16Regular />} disabled={busy !== null} onClick={() => void save(document.id)}
                      aria-label={t('documents.stored.downloadLabel', { name })}>
                      {t('documents.stored.download')}
                    </Button>
                  </li>
                );
              })}
            </ul>
            <ListFooter shown={list.items.length} total={list.total} hasMore={list.hasNextPage} loading={list.isFetchingNextPage}
              onMore={() => void list.fetchNextPage()} />
            <p className={styles.note}>{t('documents.stored.integrity')}</p>
          </>
        )}
        {busy && <Spinner size="small" label={t('documents.stored.downloading')} />}
        {failed && <p role="alert" className={styles.error}>{t('documents.stored.downloadFailed')}</p>}
      </div>
    </Panel>
  );
}
