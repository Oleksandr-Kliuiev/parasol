import { useState } from 'react';
import { Button, Input, Select, Spinner, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, makeStyles, mergeClasses } from '@fluentui/react-components';
import { ArrowDownload20Regular, DocumentSearch24Regular, TextBulletListSquare16Regular } from '@fluentui/react-icons';
import { useMutation } from '@tanstack/react-query';
import { h } from '../../../app/hearth';
import { useTranslation } from 'react-i18next';
import { download } from '../../../api/client';
import { Permissions, useCan } from '../../../auth/CurrentUserContext';
import { EmptyState } from '../../../shared/components/EmptyState';
import { ErrorState } from '../../../shared/components/ErrorState';
import { ListFooter } from '../../../shared/components/ListFooter';
import { Panel } from '../../../shared/components/Panel';
import { FilterChips, FilterField, Toolbar } from '../../../shared/components/Toolbar';
import { useNotify } from '../../../shared/components/useNotify';
import { errorMessage } from '../../../shared/utils/errors';
import { formatNumber } from '../../../shared/utils/format';
import { useBases } from '../api';
import { billingGroups } from '../types';
import { traceExportUrl, useTrace, type TraceFilters, type TraceRow } from './api';
import { ScrollRegion } from './parts';
import { money, usePilotStyles } from './styles';

const useStyles = makeStyles({
  // Figures get fixed columns; the payer and the line take what is left.
  quantity: { width: '84px' },
  price: { width: '120px' },
  vat: { width: '68px' },
  total: { width: '124px' },
  decision: { width: '136px' },
  anomalies: { width: '164px' },
  followed: { width: '120px' },
  name: { fontWeight: 600 },
  stack: { display: 'grid', gap: '2px', minWidth: 0 },
  nowrap: { whiteSpace: 'nowrap' },
  // Anomaly codes as small code chips that wrap between codes, never inside one.
  codes: { display: 'flex', flexWrap: 'wrap', gap: '4px' },
  code: { whiteSpace: 'nowrap', paddingLeft: '6px', paddingRight: '6px', borderRadius: '6px', backgroundColor: h.saffronSoft, color: h.saffronT },
  anomaly: { minWidth: 'min(240px, 100%)' },
});

function Decision({ row }: { row: TraceRow }) {
  const { t } = useTranslation();
  const styles = usePilotStyles();
  const parts = [
    row.origin === 'Manual' ? t('pilot.trace.originManual') : null,
    row.decision !== 'None' ? t(`pilot.trace.decision.${row.decision}`) : null,
    row.conflict !== 'None' ? t(`pilot.trace.conflict.${row.conflict}`) : null,
  ].filter(Boolean);
  return (
    <>
      {parts.length === 0 ? '—' : parts.join(' · ')}
      {row.changeReason && <div className={styles.muted}>{row.changeReason}</div>}
    </>
  );
}

/** One run's lines with where they came from and where they went; money columns only when the API returns them. */
export function TracePanel({ runId }: { runId: string }) {
  const styles = usePilotStyles();
  const local = useStyles();
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
      icon={<TextBulletListSquare16Regular />}
      actions={
        <Button icon={<ArrowDownload20Regular />} disabled={exportFile.isPending} onClick={() => exportFile.mutate()}>
          {t('pilot.trace.export')}
        </Button>
      }
    >
      <p className={styles.lead}>{t('pilot.trace.hint')}</p>
      <Toolbar>
        <FilterField label={t('pilot.trace.payer')}>
          <Select value={payerId} onChange={(_, d) => setPayerId(d.value)}>
            <option value="">{t('pilot.trace.allPayers')}</option>
            {(payers.data ?? []).map((basis) => (
              <option key={basis.organization.id} value={basis.organization.id}>
                {basis.organization.name}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField label={t('pilot.trace.group')}>
          <Select value={group} onChange={(_, d) => setGroup(d.value)}>
            <option value="">{t('pilot.trace.allGroups')}</option>
            {billingGroups.map((g) => (
              <option key={g} value={g}>
                {t(`billing.groups.${g}`, { defaultValue: g })}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField label={t('pilot.trace.anomaly')}>
          <Input className={local.anomaly} value={anomaly} onChange={(_, d) => setAnomaly(d.value)} placeholder={t('pilot.trace.anomalyPlaceholder')} />
        </FilterField>
        <FilterChips
          label={t('pilot.trace.anomaliesOnly')}
          value={anomaliesOnly ? 'on' : ''}
          options={[{ value: 'on', label: t('pilot.trace.anomaliesOnly') }]}
          onChange={() => setAnomaliesOnly(!anomaliesOnly)}
        />
      </Toolbar>

      {trace.error ? (
        <ErrorState error={trace.error} onRetry={() => void trace.refetch()} />
      ) : trace.isPending ? (
        <Spinner size="small" label={t('common.loading')} />
      ) : trace.items.length === 0 ? (
        <EmptyState icon={<DocumentSearch24Regular />} message={t('pilot.trace.empty')} />
      ) : (
        <>
          <ScrollRegion label={t('pilot.trace.tableLabel')}>
            <Table className={styles.table} style={{ minWidth: 1180 }} aria-label={t('pilot.trace.tableLabel')}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{t('pilot.trace.payer')}</TableHeaderCell>
                  <TableHeaderCell>{t('pilot.trace.product')}</TableHeaderCell>
                  <TableHeaderCell className={mergeClasses(styles.number, local.quantity)}>{t('pilot.trace.quantity')}</TableHeaderCell>
                  {showMoney && <TableHeaderCell className={mergeClasses(styles.number, local.price)}>{t('pilot.trace.unitPrice')}</TableHeaderCell>}
                  <TableHeaderCell className={mergeClasses(styles.number, local.vat)}>{t('pilot.trace.vat')}</TableHeaderCell>
                  {showMoney && <TableHeaderCell className={mergeClasses(styles.number, local.total)}>{t('pilot.trace.total')}</TableHeaderCell>}
                  <TableHeaderCell className={local.decision}>{t('pilot.trace.decisionColumn')}</TableHeaderCell>
                  <TableHeaderCell className={local.anomalies}>{t('pilot.trace.anomalies')}</TableHeaderCell>
                  <TableHeaderCell className={local.followed}>{t('pilot.trace.followed')}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trace.items.map((row) => (
                  <TableRow key={row.lineId}>
                    <TableCell>
                      <span className={local.stack}>
                        <span className={local.name}>{row.payer.name}</span>
                        <span className={mergeClasses(styles.key, local.nowrap)}>{row.payerOrgNumber ?? '—'}</span>
                        {row.sourceOrganization && <span className={styles.muted}>{t('pilot.trace.deliveredTo', { name: row.sourceOrganization.name })}</span>}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className={local.stack}>
                        <span>{row.description}</span>
                        <span className={styles.muted}>{t(`billing.groups.${row.group}`, { defaultValue: row.group })}</span>
                        <span className={styles.key}>{[row.productCode, row.sourceKey].filter(Boolean).join(' · ') || '—'}</span>
                      </span>
                    </TableCell>
                    <TableCell className={styles.number}>{formatNumber(row.quantity)}</TableCell>
                    {showMoney && (
                      <TableCell className={styles.number}>
                        {money(row.unitPrice)}
                        {/* A discount is rare: it is told under the price instead of in a column of zeros. */}
                        {(row.discountPct ?? 0) > 0 && <div className={styles.muted}>{t('pilot.trace.discountShort', { pct: formatNumber(row.discountPct) })}</div>}
                      </TableCell>
                    )}
                    <TableCell className={styles.number}>{formatNumber(row.vatRate)} %</TableCell>
                    {showMoney && <TableCell className={styles.number}>{money(row.lineTotal)}</TableCell>}
                    <TableCell>
                      <Decision row={row} />
                    </TableCell>
                    <TableCell>
                      {row.anomalyCodes.length === 0 ? '—' : (
                        <span className={local.codes}>{row.anomalyCodes.map((code) => <span key={code} className={mergeClasses(styles.mono, local.code)}>{code}</span>)}</span>
                      )}
                    </TableCell>
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
          </ScrollRegion>
          <ListFooter shown={trace.items.length} total={trace.total} hasMore={trace.hasNextPage} loading={trace.isFetchingNextPage} onMore={() => void trace.fetchNextPage()} />
        </>
      )}
    </Panel>
  );
}
