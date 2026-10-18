import { useState } from 'react';
import { Button, Spinner } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { download } from '../../api/client';
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
      result.isPending || result.isFetching ? <Spinner label={t('common.loading')} /> : <>
        <p className={s.muted}>{t(result.data.checkedAt == null ? 'customerFinance.pdfUnchecked' : result.data.sourceHasPdf === false
          ? 'customerFinance.pdfNoSource' : result.data.sourceHasPdf == null ? 'customerFinance.pdfUnavailable' : 'customerFinance.pdfSourceAvailable')}</p>
        {result.data.checkedAt && <p className={s.muted}>{t('customerFinance.checkedAt', { date: formatDateTime(result.data.checkedAt) })}</p>}
        {result.data.documents.length === 0 ? <p className={s.text}>{t('customerFinance.pdfEmpty')}</p> :
          <ul className={s.cards}>{result.data.documents.map((d, index) => <li key={d.id} className={s.card}>
            <div className={s.row}><strong>{t('customerFinance.pdfVersion', { number: index + 1 })}</strong>
              <Button disabled={busy !== null} onClick={() => void save(d.id)}>{t('customerFinance.downloadPdf', { number: index + 1 })}</Button></div>
            <p className={s.text}>{d.sourceName}</p>
            <p className={s.muted}>{t('customerFinance.pdfSaved', { date: formatDateTime(d.importedAt), size: formatNumber(d.length / 1024) })}</p>
          </li>)}</ul>}
        <p className={s.muted}>{t('customerFinance.pdfIntegrity')}</p>
      </>}
    {busy && <Spinner label={t('customerFinance.downloading')} />}
    {failed && <p role="alert" className={s.error}>{t('customerFinance.downloadFailed')}</p>}
  </section>;
}
