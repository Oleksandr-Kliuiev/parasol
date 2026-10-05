import { useState } from 'react';
import { Button, Field, Input, Select, Switch, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text } from '@fluentui/react-components';
import { ArrowDownload20Regular } from '@fluentui/react-icons';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { download } from '../../../api/client';
import { Permissions, useCan } from '../../../auth/CurrentUserContext';
import { EmptyState } from '../../../shared/components/EmptyState';
import { ErrorState } from '../../../shared/components/ErrorState';
import { ListFooter } from '../../../shared/components/ListFooter';
import { Panel } from '../../../shared/components/Panel';
import { useNotify } from '../../../shared/components/useNotify';
import { errorMessage } from '../../../shared/utils/errors';
import { formatNumber } from '../../../shared/utils/format';
import { useBases } from '../api';
import { billingGroups } from '../types';
import { traceExportUrl, useTrace, type TraceFilters, type TraceRow } from './api';
import { ScrollRegion } from './parts';
import { money, usePilotStyles } from './styles';

function Decision({ row }: { row: TraceRow }) {
  const { t } = useTranslation();
  const parts = [
    row.origin === 'Manual' ? t('pilot.trace.originManual') : null,
    row.decision !== 'None' ? t(`pilot.trace.decision.${row.decision}`) : null,
    row.conflict !== 'None' ? t(`pilot.trace.conflict.${row.conflict}`) : null,
  ].filter(Boolean);
  return (
    <>
      {parts.length === 0 ? '—' : parts.join(' · ')}
      {row.changeReason && <div style={{ fontSize: 12 }}>{row.changeReason}</div>}
    </>
  );
}

/** One run's lines with where they came from and where they went; money columns only when the API returns them. */
export function TracePanel({ runId }: { runId: string }) {
  const styles = usePilotStyles();
  const { t, i18n } = useTranslation();
  const notify = useNotify();
  const canSeeMoney = useCan(Permissions.financeRead);
  const [payerId, setPayerId] = useState('');
  const [group, setGroup] = useState('');
  const [anomaly, setAnomaly] = useState('');
  const [anomaliesOnly, setAnomaliesOnly] = useState(false);
  const payers = useBases(runId, {});
  const filters: TraceFilters = { payerId, group, anomaly: anomaly.trim(), anomaliesOnly: anomaliesOnly || undefined };
  const trace = useTrace(runId, filters);
  const exportFile = useMutation({
    mutationFn: () => download(traceExportUrl(runId, filters, i18n.language)),
    onError: (e) => notify(t('pilot.trace.exportFailed'), 'error', errorMessage(e, t)),
  });
  const showMoney = canSeeMoney && trace.items.some((row) => row.lineTotal !== undefined);

  return (
    <Panel
      title={t('pilot.trace.title')}
      actions={
        <Button icon={<ArrowDownload20Regular />} disabled={exportFile.isPending} onClick={() => exportFile.mutate()}>
          {t('pilot.trace.export')}
        </Button>
      }
    >
      <p className={styles.muted} style={{ marginTop: 0 }}>
        {t('pilot.trace.hint')}
      </p>
      <div className={styles.filters}>
        <Field label={t('pilot.trace.payer')}>
          <Select value={payerId} onChange={(_, d) => setPayerId(d.value)}>
            <option value="">{t('pilot.trace.allPayers')}</option>
            {(payers.data ?? []).map((basis) => (
              <option key={basis.organization.id} value={basis.organization.id}>
                {basis.organization.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('pilot.trace.group')}>
          <Select value={group} onChange={(_, d) => setGroup(d.value)}>
            <option value="">{t('pilot.trace.allGroups')}</option>
            {billingGroups.map((g) => (
              <option key={g} value={g}>
                {t(`billing.groups.${g}`, { defaultValue: g })}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('pilot.trace.anomaly')}>
          <Input value={anomaly} onChange={(_, d) => setAnomaly(d.value)} placeholder="BIL_STALE_QUANTITY" />
        </Field>
        <Switch label={t('pilot.trace.anomaliesOnly')} checked={anomaliesOnly} onChange={(_, d) => setAnomaliesOnly(d.checked)} />
      </div>

      {trace.error ? (
        <ErrorState error={trace.error} onRetry={() => void trace.refetch()} />
      ) : (
        <>
          <ScrollRegion label={t('pilot.trace.tableLabel')}>
            <Table className={styles.table} style={{ minWidth: 1100 }} aria-label={t('pilot.trace.tableLabel')}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{t('pilot.trace.payer')}</TableHeaderCell>
                  <TableHeaderCell>{t('pilot.trace.delivered')}</TableHeaderCell>
                  <TableHeaderCell>{t('pilot.trace.group')}</TableHeaderCell>
                  <TableHeaderCell>{t('pilot.trace.product')}</TableHeaderCell>
                  <TableHeaderCell className={styles.number}>{t('pilot.trace.quantity')}</TableHeaderCell>
                  {showMoney && <TableHeaderCell className={styles.number}>{t('pilot.trace.unitPrice')}</TableHeaderCell>}
                  {showMoney && <TableHeaderCell className={styles.number}>{t('pilot.trace.discount')}</TableHeaderCell>}
                  <TableHeaderCell className={styles.number}>{t('pilot.trace.vat')}</TableHeaderCell>
                  {showMoney && <TableHeaderCell className={styles.number}>{t('pilot.trace.total')}</TableHeaderCell>}
                  <TableHeaderCell>{t('pilot.trace.decisionColumn')}</TableHeaderCell>
                  <TableHeaderCell>{t('pilot.trace.anomalies')}</TableHeaderCell>
                  <TableHeaderCell>{t('pilot.trace.followed')}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trace.items.map((row) => (
                  <TableRow key={row.lineId}>
                    <TableCell>
                      {row.payer.name}
                      <div className={styles.muted}>{row.payerOrgNumber ?? '—'}</div>
                    </TableCell>
                    <TableCell>{row.sourceOrganization?.name ?? '—'}</TableCell>
                    <TableCell>{t(`billing.groups.${row.group}`, { defaultValue: row.group })}</TableCell>
                    <TableCell>
                      {row.description}
                      <div className={styles.mono}>{row.productCode ?? '—'}</div>
                      {row.sourceKey && <div className={`${styles.mono} ${styles.muted}`}>{row.sourceKey}</div>}
                    </TableCell>
                    <TableCell className={styles.number}>{formatNumber(row.quantity)}</TableCell>
                    {showMoney && <TableCell className={styles.number}>{money(row.unitPrice)}</TableCell>}
                    {showMoney && <TableCell className={styles.number}>{row.discountPct === null || row.discountPct === undefined ? '—' : `${formatNumber(row.discountPct)} %`}</TableCell>}
                    <TableCell className={styles.number}>{formatNumber(row.vatRate)} %</TableCell>
                    {showMoney && <TableCell className={styles.number}>{money(row.lineTotal)}</TableCell>}
                    <TableCell>
                      <Decision row={row} />
                    </TableCell>
                    <TableCell>{row.anomalyCodes.length === 0 ? '—' : <span className={styles.mono}>{row.anomalyCodes.join(', ')}</span>}</TableCell>
                    <TableCell>
                      {row.orderNo ?? '—'}
                      {row.invoiceNo && (
                        <div className={styles.muted}>
                          {row.invoiceNo}
                          {row.invoiceStatus ? ` · ${t(`billing.invoiceStatus.${row.invoiceStatus}`, { defaultValue: row.invoiceStatus })}` : ''}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {!trace.isPending && trace.items.length === 0 && <EmptyState message={t('pilot.trace.empty')} />}
          </ScrollRegion>
          <ListFooter shown={trace.items.length} total={trace.total} hasMore={trace.hasNextPage} loading={trace.isFetchingNextPage} onMore={() => void trace.fetchNextPage()} />
        </>
      )}
      {trace.isPending && <Text>{t('common.loading')}</Text>}
    </Panel>
  );
}
