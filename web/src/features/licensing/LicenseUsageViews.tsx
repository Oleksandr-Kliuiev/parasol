import { useMemo, useState } from 'react';
import {
  Button,
  Dialog,
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
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { ArrowUpload20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatMoney, formatNumber } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { useImportMsBilling, useLicenseUsage, useReconciliation, useReconciliationPeriods } from './api';
import type { ImportResult } from './types';

const useStyles = makeStyles({
  bar: { display: 'flex', flexWrap: 'wrap', alignItems: 'end', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalM },
  month: { minWidth: '160px' },
  tiles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalL },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  value: { fontSize: tokens.fontSizeHero700, lineHeight: tokens.lineHeightHero700, fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums' },
  label: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  warn: { color: tokens.colorPaletteDarkOrangeForeground1 },
  good: { color: tokens.colorPaletteGreenForeground1 },
  note: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
});

/** FR-LIC-03: what each customer pays for against what is actually handed out in their tenant. */
export function LicenseUsageView({ organizationId }: { organizationId?: string }) {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const [unusedOnly, setUnusedOnly] = useState(false);
  const { data = [], error, isPending, refetch } = useLicenseUsage(organizationId, unusedOnly);
  const unusedSeats = data.reduce((sum, row) => sum + (row.unusedForWholeWindow ? row.unused : 0), 0);
  const windowDays = data[0]?.windowDays ?? 30;

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  return (
    <>
      <div className={styles.bar}>
        <Switch label={t('licenses.usage.unusedOnly', { days: windowDays })} checked={unusedOnly} onChange={(_, d) => setUnusedOnly(Boolean(d.checked))} />
        {unusedSeats > 0 && <Text className={styles.warn}>{t('licenses.usage.unusedSeats', { seats: unusedSeats, days: windowDays })}</Text>}
      </div>

      <div className={catalog.tableWrap}>
        <Table className={catalog.table} aria-label={t('licenses.tabs.usage')}>
          <TableHeader>
            <TableRow>
              {!organizationId && <TableHeaderCell>{t('licenses.fields.customer')}</TableHeaderCell>}
              <TableHeaderCell>{t('licenses.usage.sku')}</TableHeaderCell>
              <TableHeaderCell className={catalog.number}>{t('licenses.usage.purchased')}</TableHeaderCell>
              <TableHeaderCell className={catalog.number}>{t('licenses.usage.assigned')}</TableHeaderCell>
              <TableHeaderCell className={catalog.number}>{t('licenses.usage.unused')}</TableHeaderCell>
              <TableHeaderCell>{t('licenses.usage.readAt')}</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={`${row.organizationId}-${row.skuId}`}>
                {!organizationId && (
                  <TableCell>
                    <AppLink to={`/organizations/${row.organizationId}?tab=licenses`}>{row.organizationName}</AppLink>
                  </TableCell>
                )}
                <TableCell>
                  <span className={catalog.name}>{row.skuPartNumber}</span>
                  <div className={catalog.sku}>{row.skuId}</div>
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
        {!isPending && data.length === 0 && <EmptyState message={t(unusedOnly ? 'licenses.usage.noneUnused' : 'licenses.usage.empty')} />}
      </div>
    </>
  );
}

/** FR-LIC-04: Microsoft's cost against the customer's invoice for the same month. */
export function ReconciliationView() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
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
      <div className={styles.bar}>
        <Field label={t('licenses.reconciliation.period')} className={styles.month}>
          <Dropdown
            id="reconciliation-period"
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
        </Field>
        <Button {...restoreFocusTarget} icon={<ArrowUpload20Regular />} onClick={() => setImporting(true)}>
          {t('licenses.reconciliation.import')}
        </Button>
      </div>

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <>
          <div className={styles.tiles}>
            <div className={styles.tile}>
              <span className={styles.value}>{formatMoney(data?.microsoftCost ?? 0, data?.currency)}</span>
              <span className={styles.label}>{t('licenses.reconciliation.cost', { lines: data?.lines ?? 0 })}</span>
            </div>
            <div className={styles.tile}>
              <span className={styles.value}>{formatMoney(data?.billedRevenue ?? 0, data?.currency)}</span>
              <span className={styles.label}>{t('licenses.reconciliation.revenue')}</span>
            </div>
            <div className={styles.tile}>
              <span className={`${styles.value} ${(data?.margin ?? 0) < 0 ? styles.warn : styles.good}`}>{formatMoney(data?.margin ?? 0, data?.currency)}</span>
              <span className={styles.label}>{t('licenses.reconciliation.margin')}</span>
            </div>
          </div>

          <div className={catalog.tableWrap}>
            <Table className={catalog.table} aria-label={t('licenses.tabs.reconciliation')}>
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
                      {row.organizationId ? (
                        <AppLink to={`/organizations/${row.organizationId}?tab=licenses`}>{row.organizationName}</AppLink>
                      ) : (
                        <span className={catalog.name}>{row.organizationName}</span>
                      )}
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
            {!isPending && (data?.rows.length ?? 0) === 0 && <EmptyState message={t('licenses.reconciliation.empty')} />}
          </div>
        </>
      )}

      <Dialog open={importing} onOpenChange={(_, d) => !d.open && setImporting(false)}>
        <DialogSurface>{importing && <MsBillingImportForm onClose={() => setImporting(false)} />}</DialogSurface>
      </Dialog>
    </>
  );
}

function formatPeriod(period: string): string {
  const [year, month] = period.split('-');
  return `${month}.${year}`;
}

function MsBillingImportForm({ onClose }: { onClose: () => void }) {
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
        <p style={{ marginTop: 0 }}>{t('licenses.reconciliation.importBody')}</p>
        <Field label={t('licenses.importFile')}>
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
        <Field label={t('licenses.importPaste')} hint={t('licenses.reconciliation.importHint')}>
          <Textarea value={csv} onChange={(_, d) => { setCsv(d.value); setPreview(null); }} resize="vertical" rows={6} />
        </Field>
        {preview && (
          <MessageBar intent={preview.warnings.length > 0 ? 'warning' : 'info'} style={{ marginTop: 12 }}>
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
          <MessageBar intent="error" style={{ marginTop: 12 }}>
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
