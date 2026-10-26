import { useMemo, useState } from 'react';
import {
  Button,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  MessageBar,
  MessageBarBody,
  Option,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Textarea,
  makeStyles,
  mergeClasses,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import { ArrowTrending16Regular, ArrowUpload20Regular, DataUsage24Regular, Key16Regular, Money16Regular, Receipt16Regular, Receipt24Regular } from '@fluentui/react-icons';
import { h } from '../../app/hearth';
import { StatGrid, StatTile } from '../../shared/components/KpiTile';
import { useFlushStyles, useStatFitStyles } from '../billing/flushStyles';
import { useTranslation } from 'react-i18next';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { FilterField, Toolbar } from '../../shared/components/Toolbar';
import { RecordCell } from '../organizations/RecordCell';
import { useRecordStyles } from '../organizations/recordStyles';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatMoney, formatNumber } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { useDialogStyles } from '../contracts/dialogStyles';
import { useImportMsBilling, useLicenseUsage, useReconciliation, useReconciliationPeriods } from './api';
import type { ImportResult } from './types';
import { ScrollTable } from '../../shared/components/ScrollTable';

const useStyles = makeStyles({
  month: { minWidth: '160px' },
  // Sits on the line of the 42 px controls next to it.
  hint: { display: 'inline-flex', alignItems: 'center', minHeight: '42px', fontWeight: 600 },
  warn: { color: h.emberT },
  note: { color: h.muted, fontSize: '12.5px', lineHeight: '18px' },
});

/** FR-LIC-03: what each customer pays for against what is actually handed out in their tenant. */
export function LicenseUsageView({ organizationId }: { organizationId?: string }) {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const record = useRecordStyles();
  const flush = useFlushStyles();
  const { t } = useTranslation();
  const [unusedOnly, setUnusedOnly] = useState(false);
  const { data = [], error, isPending, refetch } = useLicenseUsage(organizationId, unusedOnly);
  const unusedSeats = data.reduce((sum, row) => sum + (row.unusedForWholeWindow ? row.unused : 0), 0);
  const windowDays = data[0]?.windowDays ?? 30;

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  return (
    <>
      <Toolbar
        label={t('licenses.tabs.usage')}
        end={
          unusedSeats > 0 && (
            <Text className={mergeClasses(styles.warn, styles.hint)}>{t('licenses.usage.unusedSeats', { count: unusedSeats, days: windowDays })}</Text>
          )
        }
      >
        <Switch className={catalog.toggle} label={t('licenses.usage.unusedOnly', { days: windowDays })} checked={unusedOnly} onChange={(_, d) => setUnusedOnly(Boolean(d.checked))} />
      </Toolbar>

      <ScrollTable className={catalog.tableWrap}>
        <Table className={mergeClasses(catalog.table, flush.cells)} style={{ minWidth: organizationId ? 700 : 860 }} aria-label={t('licenses.tabs.usage')}>
          <TableHeader>
            <TableRow>
              {/* Content widths: every cell adds 12 px of padding on each side; customer and licence share the rest. */}
              {!organizationId && <TableHeaderCell>{t('licenses.fields.customer')}</TableHeaderCell>}
              <TableHeaderCell>{t('licenses.usage.sku')}</TableHeaderCell>
              <TableHeaderCell className={catalog.number} style={{ width: 76 }}>{t('licenses.usage.purchased')}</TableHeaderCell>
              <TableHeaderCell className={catalog.number} style={{ width: 76 }}>{t('licenses.usage.assigned')}</TableHeaderCell>
              <TableHeaderCell className={catalog.number} style={{ width: 136 }}>{t('licenses.usage.unused')}</TableHeaderCell>
              <TableHeaderCell style={{ width: 96 }}>{t('licenses.usage.readAt')}</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={`${row.organizationId}-${row.skuId}`}>
                {!organizationId && (
                  <TableCell>
                    <RecordCell
                      avatarName={row.organizationName}
                      size={28}
                      name={<AppLink to={`/organizations/${row.organizationId}?tab=licenses`} className={record.quietLink}>{row.organizationName}</AppLink>}
                    />
                  </TableCell>
                )}
                <TableCell>
                  {/* Microsoft's part number is what people recognise; the SKU id stays in the tooltip for whoever needs it. */}
                  <span title={row.skuId}>
                    <RecordCell icon={<Key16Regular />} tone="iris" size={28} name={<span className={catalog.name}>{row.skuPartNumber}</span>} />
                  </span>
                </TableCell>
                <TableCell className={catalog.number}>{formatNumber(row.purchased, 0)}</TableCell>
                <TableCell className={catalog.number}>{formatNumber(row.assigned, 0)}</TableCell>
                <TableCell className={catalog.number}>
                  <Text className={row.unusedForWholeWindow ? styles.warn : undefined}>{formatNumber(row.unused, 0)}</Text>
                  {row.unusedForWholeWindow && <div className={styles.note}>{t('licenses.usage.wholeWindow', { days: row.windowDays })}</div>}
                </TableCell>
                <TableCell className="tabular">{formatDate(row.snapshotDate)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!isPending && data.length === 0 && <EmptyState icon={<DataUsage24Regular />} message={t(unusedOnly ? 'licenses.usage.noneUnused' : 'licenses.usage.empty')} />}
      </ScrollTable>
    </>
  );
}

/** FR-LIC-04: Microsoft's cost against the customer's invoice for the same month. */
export function ReconciliationView() {
  const styles = useStyles();
  const stat = useStatFitStyles();
  const catalog = useCatalogStyles();
  const record = useRecordStyles();
  const flush = useFlushStyles();
  const { t } = useTranslation();
  const restoreFocusTarget = useRestoreFocusTarget();
  const periods = useReconciliationPeriods();
  const fallback = useMemo(() => {
    const now = new Date();
    const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}`;
  }, []);
  const [period, setPeriod] = useState<string | null>(null);
  const selected = period ?? periods.data?.[0] ?? fallback;
  const { data, error, isPending, refetch } = useReconciliation(selected);
  const [importing, setImporting] = useState(false);
  const options = useMemo(() => {
    const known = periods.data ?? [];
    return known.includes(selected) ? known : [selected, ...known];
  }, [periods.data, selected]);

  return (
    <>
      <Toolbar
        label={t('licenses.tabs.reconciliation')}
        end={
          <Button {...restoreFocusTarget} icon={<ArrowUpload20Regular />} onClick={() => setImporting(true)}>
            {t('licenses.reconciliation.import')}
          </Button>
        }
      >
        <FilterField label={t('licenses.reconciliation.period')}>
          <Dropdown
            id="reconciliation-period"
            className={styles.month}
            value={formatPeriod(selected)}
            selectedOptions={[selected]}
            onOptionSelect={(_, d) => setPeriod(d.optionValue ?? null)}
          >
            {options.map((value) => (
              <Option key={value} value={value}>
                {formatPeriod(value)}
              </Option>
            ))}
          </Dropdown>
        </FilterField>
      </Toolbar>

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <>
          <StatGrid className={stat.fit}>
            <StatTile className={stat.money}
              icon={<Receipt16Regular />}
              tone="saffron"
              label={t('licenses.reconciliation.cost')}
              value={formatMoney(data?.microsoftCost ?? 0, data?.currency)}
              note={t('licenses.reconciliation.costLines', { count: data?.lines ?? 0 })}
            />
            <StatTile className={stat.money} icon={<Money16Regular />} tone="iris" label={t('licenses.reconciliation.revenue')} value={formatMoney(data?.billedRevenue ?? 0, data?.currency)} />
            <StatTile className={stat.money}
              icon={<ArrowTrending16Regular />}
              tone="spruce"
              label={t('licenses.reconciliation.margin')}
              value={formatMoney(data?.margin ?? 0, data?.currency)}
              status={(data?.margin ?? 0) < 0 ? 'bad' : (data?.margin ?? 0) > 0 ? 'good' : undefined}
            />
          </StatGrid>

          <ScrollTable className={catalog.tableWrap}>
            <Table className={mergeClasses(catalog.table, flush.cells)} aria-label={t('licenses.tabs.reconciliation')}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{t('licenses.fields.customer')}</TableHeaderCell>
                  <TableHeaderCell className={catalog.number}>{t('licenses.reconciliation.costShort')}</TableHeaderCell>
                  <TableHeaderCell className={catalog.number}>{t('licenses.reconciliation.revenueShort')}</TableHeaderCell>
                  <TableHeaderCell className={catalog.number}>{t('licenses.reconciliation.marginShort')}</TableHeaderCell>
                  <TableHeaderCell className={catalog.number}>{t('licenses.reconciliation.marginPct')}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.rows ?? []).map((row) => (
                  <TableRow key={row.organizationId ?? row.organizationName}>
                    <TableCell>
                      <RecordCell
                        avatarName={row.organizationName}
                        size={28}
                        name={
                          row.organizationId ? (
                            <AppLink to={`/organizations/${row.organizationId}?tab=licenses`} className={record.quietLink}>{row.organizationName}</AppLink>
                          ) : (
                            <span className={catalog.name}>{row.organizationName}</span>
                          )
                        }
                      />
                      {row.notBilled && (
                        <div className={styles.note}>
                          <Text className={styles.warn}>{t('licenses.reconciliation.notBilled')}</Text>
                          {row.offersWithoutRevenue.length > 0 ? ` · ${row.offersWithoutRevenue.join(', ')}` : ''}
                        </div>
                      )}
                      {!row.organizationId && <div className={styles.note}>{t('licenses.notLinked')}</div>}
                    </TableCell>
                    <TableCell className={catalog.number}>{formatMoney(row.microsoftCost, data?.currency)}</TableCell>
                    <TableCell className={catalog.number}>{formatMoney(row.billedRevenue, data?.currency)}</TableCell>
                    <TableCell className={catalog.number}>
                      <Text className={row.margin < 0 ? styles.warn : undefined}>{formatMoney(row.margin, data?.currency)}</Text>
                    </TableCell>
                    <TableCell className={catalog.number}>{row.billedRevenue === 0 ? '—' : `${formatNumber(row.marginPct, 1)} %`}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {!isPending && (data?.rows.length ?? 0) === 0 && <EmptyState icon={<Receipt24Regular />} message={t('licenses.reconciliation.empty')} />}
          </ScrollTable>
        </>
      )}

      <Dialog open={importing} onOpenChange={(_, d) => !d.open && setImporting(false)}>
        <DialogSurface><MsBillingImportForm onClose={() => setImporting(false)} /></DialogSurface>
      </Dialog>
    </>
  );
}

function formatPeriod(period: string): string {
  const [year, month] = period.split('-');
  return `${month}.${year}`;
}

function MsBillingImportForm({ onClose }: { onClose: () => void }) {
  const dialog = useDialogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const importLines = useImportMsBilling();
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<ImportResult | null>(null);

  const run = async (dryRun: boolean) => {
    try {
      const result = await importLines.mutateAsync({ csv, dryRun });
      if (dryRun) {
        setPreview(result);
      } else {
        notify(t('licenses.reconciliation.imported', { created: result.created, updated: result.updated }));
        onClose();
      }
    } catch (e) {
      notify(t('licenses.importFailed'), 'error', errorMessage(e, t));
    }
  };

  return (
    <DialogBody>
      <DialogTitle>{t('licenses.reconciliation.importTitle')}</DialogTitle>
      <DialogContent>
        <p className={dialog.lead}>{t('licenses.reconciliation.importBody')}</p>
        <div className={dialog.grid}>
          <Field label={t('licenses.importFile')} className={dialog.wide}>
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
          <Field className={dialog.wide} label={t('licenses.importPaste')} hint={t('licenses.reconciliation.importHint')}>
            <Textarea value={csv} onChange={(_, d) => { setCsv(d.value); setPreview(null); }} resize="vertical" rows={6} />
          </Field>
        </div>
        {preview && (
          <MessageBar intent={preview.warnings.length > 0 ? 'warning' : 'info'} className={dialog.after}>
            <MessageBarBody>
              {t('licenses.reconciliation.previewResult', {
                created: preview.created,
                updated: preview.updated,
                unchanged: preview.unchanged,
                withoutOrganization: preview.withoutOrganization,
              })}
              {preview.warnings.length > 0 ? ` ${preview.warnings.join(' ')}` : ''}
            </MessageBarBody>
          </MessageBar>
        )}
        {importLines.error && (
          <MessageBar intent="error" className={dialog.after}>
            <MessageBarBody>{errorMessage(importLines.error, t)}</MessageBarBody>
          </MessageBar>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button onClick={() => void run(true)} disabled={!csv.trim() || importLines.isPending}>
          {t('licenses.preview')}
        </Button>
        <Button appearance="primary" onClick={() => void run(false)} disabled={!csv.trim() || importLines.isPending}>
          {t('licenses.importNow')}
        </Button>
      </DialogActions>
    </DialogBody>
  );
}
