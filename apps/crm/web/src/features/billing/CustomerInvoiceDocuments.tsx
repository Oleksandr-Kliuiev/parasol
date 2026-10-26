import { useState } from 'react';
import { Button, Spinner } from '@fluentui/react-components';
import { ArrowDownload16Regular, DocumentPdf16Regular, DocumentPdf24Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { download } from '../../api/client';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { formatDateTime, formatNumber } from '../../shared/utils/format';
import { invoiceDocumentUrl, useInvoiceDocuments } from './customerFinanceApi';
import { useCustomerFinanceStyles } from './customerFinanceStyles';

export function CustomerInvoiceDocuments({ organizationId, invoiceId }: { organizationId: string; invoiceId: string }) {
  const { t } = useTranslation(); const s = useCustomerFinanceStyles();
  const result = useInvoiceDocuments(organizationId, invoiceId);
  const [busy, setBusy] = useState<string | null>(null); const [failed, setFailed] = useState(false);
  const save = async (documentId: string) => {
    if (busy) return;
    setBusy(documentId); setFailed(false);
    try { await download(invoiceDocumentUrl(organizationId, invoiceId, documentId)); }
    catch { setFailed(true); }
    finally { setBusy(null); }
  };
  return <section aria-label={t('customerFinance.pdfTitle')} className={s.stack}>
    <h4 className={s.heading}>{t('customerFinance.pdfTitle')}</h4>
    {result.error ? <ErrorState error={result.error} onRetry={() => void result.refetch()} /> :
      result.isPending || result.isFetching ? <Spinner size="small" label={t('common.loading')} /> : <>
        <p className={s.note}>
          {t(result.data.checkedAt == null ? 'customerFinance.pdfUnchecked' : result.data.sourceHasPdf === false
            ? 'customerFinance.pdfNoSource' : result.data.sourceHasPdf == null ? 'customerFinance.pdfUnavailable' : 'customerFinance.pdfSourceAvailable')}
          {result.data.checkedAt && <> {t('customerFinance.checkedAt', { date: formatDateTime(result.data.checkedAt) })}</>}
        </p>
        {result.data.documents.length === 0 ? <EmptyState icon={<DocumentPdf24Regular />} message={t('customerFinance.pdfEmpty')} /> :
          <ul className={s.frame}>{result.data.documents.map((d, index) => <li key={d.id} className={s.fileRow}>
            <span className={s.fileIcon} aria-hidden><DocumentPdf16Regular /></span>
            <span className={s.fileMain}>
              <span className={s.strong}>{d.sourceName}</span>
              <span className={s.muted}>
                {t('customerFinance.pdfVersion', { number: index + 1 })} · {t('customerFinance.pdfSaved', { date: formatDateTime(d.importedAt), size: formatNumber(d.length / 1024) })}
              </span>
            </span>
            <Button size="small" icon={<ArrowDownload16Regular />} disabled={busy !== null} onClick={() => void save(d.id)}>
              {t('customerFinance.downloadPdf', { number: index + 1 })}
            </Button>
          </li>)}</ul>}
        <p className={s.muted}>{t('customerFinance.pdfIntegrity')}</p>
      </>}
    {busy && <Spinner size="small" label={t('customerFinance.downloading')} />}
    {failed && <p role="alert" className={s.error}>{t('customerFinance.downloadFailed')}</p>}
  </section>;
}
