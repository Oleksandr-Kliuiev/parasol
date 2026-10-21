import { useState } from 'react';
import {
  Button,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogTitle,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Textarea,
  mergeClasses,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatMoney, formatNumber, parseDecimal } from '../../shared/utils/format';
import { usePriceListActions } from './api';
import { useCatalogStyles } from './styles';
import { useDialogStyles } from '../contracts/dialogStyles';
import type { PriceList, PriceSheetImportResult } from './types';

/** Applies Microsoft's NCE price sheet to a draft price list; the preview shows the new prices before anything is written. */
export function PriceSheetForm({ list, onClose }: { list: PriceList; onClose: () => void }) {
  const catalog = useCatalogStyles();
  const dialog = useDialogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = usePriceListActions(list.id);
  const [csv, setCsv] = useState('');
  const [exchangeRate, setExchangeRate] = useState('');
  const [markup, setMarkup] = useState('');
  const [preview, setPreview] = useState<PriceSheetImportResult | null>(null);
  const rate = parseDecimal(exchangeRate);
  const invalid = !csv.trim() || rate === null || rate <= 0;

  const run = async (dryRun: boolean) => {
    if (invalid) return;
    try {
      const result = await actions.importPriceSheet.mutateAsync({ csv, exchangeRate: rate, markupPct: parseDecimal(markup), dryRun });
      if (dryRun) {
        setPreview(result);
      } else {
        notify(t('catalog.priceSheet.imported', { changed: result.changed, matched: result.matched }));
        onClose();
      }
    } catch (e) {
      notify(t('catalog.priceSheet.failed'), 'error', errorMessage(e, t));
    }
  };

  return (
    <DialogBody>
      <DialogTitle>{t('catalog.priceSheet.title', { name: list.name })}</DialogTitle>
      <DialogContent>
        <p className={dialog.lead}>{t('catalog.priceSheet.body')}</p>
        <div className={catalog.grid}>
          <Field label={t('catalog.fields.exchangeRate')} required hint={t('catalog.priceSheet.rateHint')}>
            <Input inputMode="decimal" value={exchangeRate} onChange={(_, d) => { setExchangeRate(d.value); setPreview(null); }} />
          </Field>
          <Field label={t('catalog.priceSheet.markup')} hint={t('catalog.priceSheet.markupHint')}>
            <Input inputMode="decimal" value={markup} onChange={(_, d) => { setMarkup(d.value); setPreview(null); }} contentAfter="%" />
          </Field>
          <Field label={t('licenses.importFile')} className={catalog.wide}>
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              aria-label={t('licenses.importFile')}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void file.text().then((text) => { setCsv(text); setPreview(null); });
              }}
            />
          </Field>
          <Field label={t('licenses.importPaste')} hint={t('catalog.priceSheet.pasteHint')} className={catalog.wide}>
            <Textarea value={csv} onChange={(_, d) => { setCsv(d.value); setPreview(null); }} resize="vertical" rows={5} />
          </Field>
        </div>
        {preview && (
          <>
            <MessageBar intent={preview.withoutProduct > 0 ? 'warning' : 'info'} className={dialog.after}>
              <MessageBarBody>
                {t('catalog.priceSheet.previewResult', {
                  matched: preview.matched,
                  changed: preview.changed,
                  withoutProduct: preview.withoutProduct,
                  markup: formatNumber(preview.markupPct, 1),
                })}
              </MessageBarBody>
            </MessageBar>
            <Table className={mergeClasses(catalog.table, dialog.after)} aria-label={t('catalog.priceSheet.preview')}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{t('catalog.fields.product')}</TableHeaderCell>
                  <TableHeaderCell className={catalog.number}>{t('catalog.fields.partnerPrice')}</TableHeaderCell>
                  <TableHeaderCell className={catalog.number}>{t('catalog.priceSheet.newPrice')}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.rows.slice(0, 10).map((row) => (
                  <TableRow key={row.productId}>
                    <TableCell>
                      <span className={catalog.name}>{row.productName}</span>
                      <div className={catalog.sku}>{row.offerId}</div>
                    </TableCell>
                    <TableCell className={catalog.number}>{formatMoney(row.partnerPrice, row.partnerCurrency)}</TableCell>
                    <TableCell className={catalog.number}>
                      {formatMoney(row.unitPrice, list.currency)}
                      {row.previousUnitPrice !== null && <div className={catalog.sku}>{formatMoney(row.previousUnitPrice, list.currency)}</div>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {/* The answer carries a sample of the rows (changed first); `matched` counts every product the sheet prices (DEV-12). */}
            {preview.matched > Math.min(preview.rows.length, 10) && (
              <Text className={catalog.muted}>{t('catalog.priceSheet.more', { rest: preview.matched - Math.min(preview.rows.length, 10) })}</Text>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button onClick={() => void run(true)} disabled={invalid || actions.importPriceSheet.isPending}>
          {t('licenses.preview')}
        </Button>
        <Button appearance="primary" onClick={() => void run(false)} disabled={invalid || actions.importPriceSheet.isPending}>
          {t('catalog.priceSheet.apply')}
        </Button>
      </DialogActions>
    </DialogBody>
  );
}
