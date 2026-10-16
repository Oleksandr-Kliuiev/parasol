import { useState } from 'react';
import {
  Button,
  Field,
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
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { AppLink } from '../../../shared/components/AppLink';
import { errorMessage } from '../../../shared/utils/errors';
import { formatMoney } from '../../../shared/utils/format';
import { useCatalogStyles } from '../../catalog/styles';
import { useReconcile } from './api';
import { StatusText } from './parts';
import { reasonText } from './text';

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginBottom: tokens.spacingVerticalL },
  counts: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalL, marginBottom: tokens.spacingVerticalM },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
});

/** Cutover reconciliation: the old system's monthly totals against what the CRM billed. Reads only, writes nothing. */
export function ReconciliationPanel() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const reconcile = useReconcile();
  const [csv, setCsv] = useState('');
  const result = reconcile.data;
  const money = (value: number | null | undefined, currency: string) => (value == null ? '—' : formatMoney(value, currency));

  return (
    <>
      <div className={styles.form}>
        <Text className={styles.muted}>{t('migration.reconcile.intro')}</Text>
        <Field label={t('migration.file')}>
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            aria-label={t('migration.reconcile.file')}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void file.text().then((text) => { setCsv(text); reconcile.reset(); });
            }}
          />
        </Field>
        <Field label={t('migration.reconcile.paste')} hint={t('migration.reconcile.columns')}>
          <Textarea value={csv} onChange={(_, d) => { setCsv(d.value); reconcile.reset(); }} resize="vertical" rows={6} />
        </Field>
        <div>
          <Button appearance="primary" disabled={!csv.trim() || reconcile.isPending} onClick={() => reconcile.mutate(csv)}>
            {t('migration.reconcile.compare')}
          </Button>
        </div>
      </div>

      <div role="alert">
        {reconcile.error && (
          <MessageBar intent="error">
            <MessageBarBody>{errorMessage(reconcile.error, t)}</MessageBarBody>
          </MessageBar>
        )}
      </div>

      <div aria-live="polite">
        {result && (
          <>
            <p className={styles.muted}>{t('migration.reconcile.summary', { rows: result.fileRows, customers: result.customers })}</p>
            {!result.amountsVisible && (
              <MessageBar intent="info" style={{ marginBottom: 12 }}>
                <MessageBarBody>{t('migration.reconcile.noAmounts')}</MessageBarBody>
              </MessageBar>
            )}
            <ul className={styles.counts} style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }} aria-label={t('migration.reconcile.counts')}>
              {Object.entries(result.statusCounts).map(([status, count]) => (
                <li key={status}>
                  <StatusText kind="recon" value={status} />: <strong>{count}</strong>
                </li>
              ))}
            </ul>
            <div className={catalog.tableWrap} tabIndex={0} role="region" aria-label={t('migration.reconcile.table')}>
              <Table className={catalog.table} aria-label={t('migration.reconcile.table')}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>{t('migration.reconcile.orgNumber')}</TableHeaderCell>
                    <TableHeaderCell>{t('migration.reconcile.period')}</TableHeaderCell>
                    <TableHeaderCell>{t('migration.fields.action')}</TableHeaderCell>
                    {result.amountsVisible && (
                      <>
                        <TableHeaderCell className={catalog.number}>{t('migration.reconcile.fileAmount')}</TableHeaderCell>
                        <TableHeaderCell className={catalog.number}>{t('migration.reconcile.crmBilled')}</TableHeaderCell>
                        <TableHeaderCell className={catalog.number}>{t('migration.reconcile.difference')}</TableHeaderCell>
                      </>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.lines.map((line, index) => (
                    <TableRow key={`${line.orgNumber ?? 'x'}-${line.period}-${line.currency}-${line.line ?? index}-${index}`}>
                      <TableCell>
                        {line.organizationId ? (
                          <AppLink to={`/organizations/${line.organizationId}`}>{line.orgNumber}</AppLink>
                        ) : (
                          <span className={catalog.sku}>{line.orgNumber ?? (line.line ? t('migration.reconcile.line', { line: line.line }) : '—')}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {line.period || '—'} {line.currency}
                      </TableCell>
                      <TableCell>
                        <StatusText kind="recon" value={line.status} />
                        {line.reasonCode && <div className={catalog.muted}>{reasonText(t, line.reasonCode)}</div>}
                      </TableCell>
                      {result.amountsVisible && (
                        <>
                          <TableCell className={catalog.number}>{money(line.fileAmount, line.currency)}</TableCell>
                          <TableCell className={catalog.number}>{money(line.crmBilled, line.currency)}</TableCell>
                          <TableCell className={catalog.number}>{money(line.difference, line.currency)}</TableCell>
                        </>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Text className={styles.muted}>{t('common.shownOf', { shown: result.lines.length, total: result.lines.length })}</Text>
          </>
        )}
      </div>
    </>
  );
}
