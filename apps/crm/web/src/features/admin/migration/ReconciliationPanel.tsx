import { useState } from 'react';
import {
  Button,
  Field,
  MessageBar,
  MessageBarBody,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Textarea,
} from '@fluentui/react-components';
import { ArrowSwap16Regular, DataBarVertical16Regular, Info16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { FactGrid, Panel } from '../../../shared/components/Panel';
import { AppLink } from '../../../shared/components/AppLink';
import { errorMessage } from '../../../shared/utils/errors';
import { formatMoney } from '../../../shared/utils/format';
import { ScrollRegion } from '../ScrollRegion';
import { useTableCardStyles } from '../tableCard';
import { useReconcile } from './api';
import { StatusText } from './parts';
import { useMigrationStyles } from './styles';
import { reasonText } from './text';

/** Cutover reconciliation: the old system's monthly totals against what the CRM billed. Reads only, writes nothing. */
export function ReconciliationPanel() {
  const m = useMigrationStyles();
  const table = useTableCardStyles();
  const { t } = useTranslation();
  const reconcile = useReconcile();
  const [csv, setCsv] = useState('');
  const result = reconcile.data;
  const money = (value: number | null | undefined, currency: string) => (value == null ? '—' : formatMoney(value, currency));
  const empty = !csv.trim();

  return (
    <div className={m.stack}>
      <Panel title={t('migration.reconcile.title')} icon={<ArrowSwap16Regular />}>
        <div className={m.form}>
          <p className={m.lead}>{t('migration.reconcile.intro')}</p>
          <Field label={t('migration.file')}>
            <input
              className={m.file}
              type="file"
              accept=".csv,text/csv,text/plain"
              aria-label={t('migration.reconcile.file')}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void file.text().then((text) => { setCsv(text); reconcile.reset(); });
              }}
            />
          </Field>
          <Field label={t('migration.reconcile.paste')} hint={{ children: t('migration.reconcile.columns'), className: m.hint }} className={m.csv}>
            <Textarea value={csv} onChange={(_, d) => { setCsv(d.value); reconcile.reset(); }} resize="vertical" rows={6} />
          </Field>
          <div className={m.footer}>
            <div className={m.reason} aria-live="polite">
              <span className={m.reasonIcon} aria-hidden>
                {reconcile.isPending ? <Spinner size="extra-tiny" /> : <Info16Regular />}
              </span>
              {reconcile.isPending ? t('common.loading') : empty ? t('migration.reconcile.emptyFirst') : t('migration.reconcile.readOnly')}
            </div>
            <div className={m.actions}>
              <Button appearance="primary" disabled={empty || reconcile.isPending} onClick={() => reconcile.mutate(csv)}>
                {t('migration.reconcile.compare')}
              </Button>
            </div>
          </div>
        </div>
      </Panel>

      <div role="alert">
        {reconcile.error && (
          <MessageBar intent="error">
            <MessageBarBody>{errorMessage(reconcile.error, t)}</MessageBarBody>
          </MessageBar>
        )}
      </div>

      <div aria-live="polite">
        {result && (
          <Panel title={t('migration.reconcile.resultTitle')} icon={<DataBarVertical16Regular />}>
            <div className={m.stack}>
              <FactGrid
                items={[
                  { label: t('migration.reconcile.fileRows'), value: String(result.fileRows) },
                  { label: t('migration.reconcile.customersFound'), value: String(result.customers) },
                ]}
              />
              {!result.amountsVisible && (
                <MessageBar intent="info">
                  <MessageBarBody>{t('migration.reconcile.noAmounts')}</MessageBarBody>
                </MessageBar>
              )}
              <ul className={m.statusCounts} aria-label={t('migration.reconcile.counts')}>
                {Object.entries(result.statusCounts).map(([status, count]) => (
                  <li key={status} className={m.statusCount}>
                    <StatusText kind="recon" value={status} />
                    <span className={m.countValue}>{count}</span>
                  </li>
                ))}
              </ul>
              <div>
                <ScrollRegion className={table.inset} label={t('migration.reconcile.table')}>
                  <Table className={table.min720} aria-label={t('migration.reconcile.table')}>
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>{t('migration.reconcile.orgNumber')}</TableHeaderCell>
                        <TableHeaderCell>{t('migration.reconcile.period')}</TableHeaderCell>
                        <TableHeaderCell>{t('migration.runs.status')}</TableHeaderCell>
                        {result.amountsVisible && (
                          <>
                            <TableHeaderCell className={table.numberHead}>{t('migration.reconcile.fileAmount')}</TableHeaderCell>
                            <TableHeaderCell className={table.numberHead}>{t('migration.reconcile.crmBilled')}</TableHeaderCell>
                            <TableHeaderCell className={table.numberHead}>{t('migration.reconcile.difference')}</TableHeaderCell>
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
                              <span className={line.orgNumber ? table.code : table.muted}>{line.orgNumber ?? (line.line ? t('migration.reconcile.line', { line: line.line }) : '—')}</span>
                            )}
                          </TableCell>
                          <TableCell className={table.nowrap}>{line.period ? `${line.period} ${line.currency}` : '—'}</TableCell>
                          <TableCell>
                            <StatusText kind="recon" value={line.status} />
                            {line.reasonCode && <span className={table.sub}>{reasonText(t, line.reasonCode)}</span>}
                          </TableCell>
                          {result.amountsVisible && (
                            <>
                              <TableCell className={table.number}>{money(line.fileAmount, line.currency)}</TableCell>
                              <TableCell className={table.number}>{money(line.crmBilled, line.currency)}</TableCell>
                              <TableCell className={table.number}>{money(line.difference, line.currency)}</TableCell>
                            </>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollRegion>
              </div>
              <Text className={m.note}>{t('common.shownOf', { shown: result.lines.length, total: result.lines.length })}</Text>
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
