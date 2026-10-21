import { Fragment, useState } from 'react';
import { useParams } from 'react-router';
import {
  Button,
  DialogSurface,
  Link,
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
  makeStyles,
  mergeClasses,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import {
  Add20Regular,
  ArrowRepeatAll20Regular,
  ArrowUndo20Regular,
  Checkmark20Regular,
  CheckmarkCircle16Regular,
  CloudArrowUp16Regular,
  Delete20Regular,
  DocumentBulletList24Regular,
  DocumentSearch20Regular,
  Edit20Regular,
  ErrorCircle16Regular,
  Money16Regular,
  Prohibited20Regular,
  Receipt16Regular,
  ReceiptAdd20Regular,
  Warning20Filled,
} from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { DetailList, Panel } from '../../shared/components/Panel';
import { useKeptWhileClosing } from '../../shared/components/useKeptWhileClosing';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatDateTime, formatMoney } from '../../shared/utils/format';
import { NotFoundPage } from '../errors/NotFoundPage';
import { useCatalogStyles } from '../catalog/styles';
import { useBasis, useBasisActions } from './api';
import { anomalyText } from './anomalyText';
import { BasisStatusBadge, InvoiceMovements, InvoiceStatusBadge } from './shared';
import { monthLabel } from './period';
import type { BasisLine } from './types';
import { safeHttpUrl } from '../../shared/utils/safeUrl';
import { ScrollTable } from '../../shared/components/ScrollTable';
import { h } from '../../app/hearth';
import { CancelForm, CorrectionForm, DecisionForm, LineForm, ReconcileForm } from './BasisLineForms';
import { useFlushStyles } from './flushStyles';
import { RecordRow, RowMeta } from './RecordRow';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: '16px' },
  log: { marginTop: '16px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: '16px', alignItems: 'stretch' },
  // The figure of the panel, as in the reference's "Monthly production": display type, then its unit in a muted line.
  total: { fontFamily: h.display, fontSize: 'clamp(26px, 2.2vw, 32px)', lineHeight: 1.1, fontWeight: 600, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' },
  totalNote: { marginTop: '4px', marginBottom: '16px' },
  muted: { color: h.muted, fontSize: '12.5px', lineHeight: '18px' },
  notSent: { display: 'block', marginTop: '12px', color: h.muted, fontSize: '13px', lineHeight: '20px' },
  failedAttempt: { color: h.emberT },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '4px' },
  // Lines: the description takes what the figures leave; widths include the cell padding.
  lines: { minWidth: '820px', '& th': { boxSizing: 'border-box' }, '& td': { paddingTop: '10px', paddingBottom: '10px' } },
  linesEditable: { minWidth: '920px' },
  quantityColumn: { width: '96px' },
  priceColumn: { width: '136px' },
  amountColumn: { width: '168px' },
  vatColumn: { width: '76px' },
  actionsColumn: { width: '156px' },
  correctColumn: { width: '64px' },
  // A group of lines is a slim caption row, not a full line.
  group: {
    backgroundColor: h.surface2,
    ':hover': { backgroundColor: h.surface2 },
    '& td': { height: '36px', paddingTop: '8px', paddingBottom: '8px', boxSizing: 'border-box', color: h.muted, fontSize: '12px', lineHeight: '16px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' },
  },
  description: { fontWeight: 600 },
  actions: { display: 'flex', gap: '4px', justifyContent: 'flex-end' },
  excluded: { textDecorationLine: 'line-through', color: h.muted },
  conflict: { display: 'flex', gap: '4px', alignItems: 'flex-start', color: h.saffronT, fontSize: '12.5px', lineHeight: '18px', '& svg': { flexShrink: 0, width: '16px', height: '16px' } },
});

type LineDialog =
  | { kind: 'add' }
  | { kind: 'edit'; line: BasisLine }
  | { kind: 'exclude'; line: BasisLine }
  | { kind: 'keep'; line: BasisLine }
  | { kind: 'correct'; line: BasisLine }
  | { kind: 'reconcile'; manual: boolean }
  | { kind: 'cancel' };

/** One customer's basis for one period: the lines that become an invoice, and what happened on export. */
export function BillingBasisPage() {
  const styles = useStyles();
  const flush = useFlushStyles();
  const catalog = useCatalogStyles();
  const { t, i18n } = useTranslation();
  const { id = '' } = useParams();
  const notify = useNotify();
  const canManage = useCan(Permissions.billingManage);
  const canSeeMoney = useCan(Permissions.financeRead);
  const { data: basis, error, isPending, refetch } = useBasis(id);
  const actions = useBasisActions(id);
  const [dialog, setDialog] = useState<LineDialog | null>(null);
  const shown = useKeptWhileClosing(dialog);
  const restoreFocusTarget = useRestoreFocusTarget();

  if (isPending) return <Spinner label={t('common.loading')} />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  if (error || !basis) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const editable = canManage && basis.status === 'Draft';
  // An exported line is never changed; Finance adds to it with a correction billed by the next run (ADR-013).
  const correctable = canManage && basis.status === 'Exported';
  const withActions = editable || correctable;
  // While an order may exist in PowerOffice the basis is reconciled before it can be cancelled.
  const mayExist = basis.status === 'ReconciliationRequired' || (basis.status === 'Approved' && basis.sendStarted);
  const cancellable = canManage && !mayExist && !['Exported', 'Cancelled'].includes(basis.status);
  const groups = [...new Set(basis.lines.map((line) => line.group))];

  const remove = async (line: BasisLine) => {
    try {
      await actions.removeLine.mutateAsync({ lineId: line.id, etag: basis.etag });
      notify(t('billing.lineRemoved'));
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  const revert = async (line: BasisLine) => {
    try {
      await actions.revertLine.mutateAsync({ lineId: line.id, etag: basis.etag });
      notify(line.decision === 'Exclusion' ? t('billing.lineIncluded') : t('billing.usedSource'));
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  const conflictText = (line: BasisLine) => {
    if (line.conflict === 'SourceChanged' && canSeeMoney && line.sourceLineTotal != null) {
      return t('billing.conflict.SourceChangedAmount', { amount: formatMoney(line.sourceLineTotal) });
    }
    return t(`billing.conflict.${line.conflict}`);
  };

  return (
    <>
      <PageHeader
        back={{ to: `/billing/runs/${basis.runId}`, label: monthLabel(basis.periodStart, i18n.language) }}
        title={basis.organization.name}
        meta={
          <>
            <BasisStatusBadge status={basis.status} />
            <Text className={styles.muted}>
              {formatDate(basis.periodStart)} – {formatDate(basis.periodEnd)}
            </Text>
            <AppLink to={`/organizations/${basis.organization.id}?tab=invoices`}>{t('billing.openCustomer')}</AppLink>
          </>
        }
        actions={
          <>
            {editable && (
              <Button {...restoreFocusTarget} icon={<Add20Regular />} onClick={() => setDialog({ kind: 'add' })}>
                {t('billing.addLine')}
              </Button>
            )}
            {/* Sending again repeats the failure until its cause is fixed elsewhere (a mapping, a product): a secondary step,
                and a refusal is said, never swallowed. */}
            {canManage && basis.status === 'Failed' && (
              <Button
                icon={<ArrowRepeatAll20Regular />}
                disabled={actions.retry.isPending}
                onClick={() => void actions.retry.mutateAsync().then(() => notify(t('billing.retried')),
                  (error: unknown) => notify(t('errors.generic'), 'error', errorMessage(error, t)))}
              >
                {t('billing.retry')}
              </Button>
            )}
            {canManage && basis.status === 'ReconciliationRequired' && (
              <Button {...restoreFocusTarget} appearance="primary" icon={<DocumentSearch20Regular />} onClick={() => setDialog({ kind: 'reconcile', manual: false })}>
                {t('billing.reconcile.action')}
              </Button>
            )}
            {canManage && (basis.status === 'Failed' || (basis.status === 'Approved' && !basis.sendStarted)) && (
              <Button {...restoreFocusTarget} appearance="subtle" icon={<DocumentSearch20Regular />} onClick={() => setDialog({ kind: 'reconcile', manual: true })}>
                {t('billing.reconcile.manualAction')}
              </Button>
            )}
            {cancellable && (
              <Button {...restoreFocusTarget} appearance="subtle" onClick={() => setDialog({ kind: 'cancel' })}>
                {t('billing.cancelBasis')}
              </Button>
            )}
          </>
        }
      />

      {basis.conflicts > 0 && (
        <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>{t('billing.conflictsBanner', { count: basis.conflicts })}</MessageBarBody>
        </MessageBar>
      )}

      {basis.status === 'ReconciliationRequired' && (
        <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>{t('billing.reconcile.banner')}</MessageBarBody>
        </MessageBar>
      )}
      {basis.status === 'Approved' && basis.sendStarted && (
        <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>{t('billing.reconcile.sending')}</MessageBarBody>
        </MessageBar>
      )}

      {basis.anomalies.length > 0 && (
        <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>
            <ul className={styles.list}>
              {basis.anomalies.map((anomaly) => (
                <li key={anomaly.code + anomaly.message}>{anomalyText(t, anomaly)}</li>
              ))}
            </ul>
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.stack}>
        <div className={styles.grid}>
          {canSeeMoney && (
            <Panel title={t('billing.toInvoice')} icon={<Money16Regular />}>
              <div className={styles.total}>{formatMoney(basis.totalExVat)}</div>
              <div className={mergeClasses(styles.muted, styles.totalNote)}>{t('billing.exVat')}</div>
              <DetailList
                items={[
                  { label: t('billing.fields.previousPeriod'), value: formatMoney(basis.previousPeriodTotal) },
                  { label: t('billing.fields.customerReference'), value: basis.customerReference },
                ]}
              />
            </Panel>
          )}
          <Panel title={t('billing.exportLog')} icon={<CloudArrowUp16Regular />} flush={basis.attempts.length > 0} className={basis.attempts.length > 0 ? flush.panel : undefined}>
            <div className={basis.attempts.length > 0 ? flush.body : undefined}>
              <DetailList
                items={[
                  { label: t('common.status'), value: t(`billing.basisStatus.${basis.status}`) },
                  ...(basis.orderNo || basis.exportedAt
                    ? [
                        { label: t('billing.fields.order'), value: basis.orderNo },
                        { label: t('billing.fields.exportedAt'), value: basis.exportedAt ? formatDateTime(basis.exportedAt) : null },
                      ]
                    : []),
                ]}
              />
              {!basis.orderNo && !basis.exportedAt && basis.attempts.length === 0 && <Text className={styles.notSent}>{t('billing.notSentYet')}</Text>}
            </div>
            {basis.attempts.length > 0 && (
              <ul className={mergeClasses(flush.list, styles.log)}>
                {basis.attempts.map((attempt) => (
                  <RecordRow
                    key={attempt.at + attempt.result}
                    icon={attempt.result === 'Failed' ? <ErrorCircle16Regular /> : <CheckmarkCircle16Regular />}
                    tone={attempt.result === 'Failed' ? 'ember' : 'spruce'}
                    title={<span className={attempt.result === 'Failed' ? styles.failedAttempt : undefined}>{attempt.message ?? attempt.result}</span>}
                    meta={<RowMeta>{formatDateTime(attempt.at)}</RowMeta>}
                  />
                ))}
              </ul>
            )}
          </Panel>
          {basis.invoices.length > 0 && (
            <Panel title={t('billing.invoices')} icon={<Receipt16Regular />} flush className={flush.panel}>
              <ul className={flush.list}>
                {basis.invoices.map((invoice) => (
                  <RecordRow
                    key={invoice.id}
                    icon={<Receipt16Regular />}
                    tone="iris"
                    title={
                      invoice.url ? (
                        <Link href={safeHttpUrl(invoice.url)} target="_blank" rel="noopener noreferrer">
                          {invoice.invoiceNo}
                        </Link>
                      ) : (
                        <Text weight="semibold">{invoice.invoiceNo}</Text>
                      )
                    }
                    meta={
                      <>
                        <RowMeta>
                          {t('billing.invoiceDates', {
                            invoiceDate: formatDate(invoice.invoiceDate),
                            dueDate: invoice.dueDate ? formatDate(invoice.dueDate) : '—',
                          })}
                        </RowMeta>
                        <InvoiceMovements movements={invoice.movements} canSeeMoney={canSeeMoney} />
                      </>
                    }
                    end={
                      <>
                        {canSeeMoney && <Text weight="semibold">{formatMoney(invoice.totalIncVat)}</Text>}
                        <InvoiceStatusBadge status={invoice.status} isOverdue={invoice.isOverdue} />
                      </>
                    }
                  />
                ))}
              </ul>
            </Panel>
          )}
        </div>

        {basis.lines.length === 0 ? (
          <div className={catalog.tableWrap}>
            <EmptyState icon={<DocumentBulletList24Regular />} message={t('billing.noLines')}
              action={editable && <Button {...restoreFocusTarget} icon={<Add20Regular />} onClick={() => setDialog({ kind: 'add' })}>{t('billing.addLine')}</Button>} />
          </div>
        ) : (
          <ScrollTable className={catalog.tableWrap}>
            <Table className={mergeClasses(catalog.table, styles.lines, editable && styles.linesEditable)} aria-label={t('billing.lines')}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{t('billing.fields.description')}</TableHeaderCell>
                  <TableHeaderCell className={mergeClasses(catalog.number, styles.quantityColumn)}>{t('billing.fields.quantity')}</TableHeaderCell>
                  {canSeeMoney && <TableHeaderCell className={mergeClasses(catalog.number, styles.priceColumn)}>{t('billing.fields.unitPrice')}</TableHeaderCell>}
                  {canSeeMoney && <TableHeaderCell className={mergeClasses(catalog.number, styles.amountColumn)}>{t('billing.fields.lineTotal')}</TableHeaderCell>}
                  <TableHeaderCell className={mergeClasses(catalog.number, styles.vatColumn)}>{t('billing.fields.vat')}</TableHeaderCell>
                  {withActions && <TableHeaderCell className={editable ? styles.actionsColumn : styles.correctColumn} />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((group) => (
                  <Fragment key={group}>
                    <TableRow className={styles.group}>
                      <TableCell colSpan={canSeeMoney ? (withActions ? 6 : 5) : withActions ? 4 : 3}>{t(`billing.groups.${group}`)}</TableCell>
                    </TableRow>
                    {basis.lines
                      .filter((line) => line.group === group)
                      .map((line) => {
                        const excluded = line.decision === 'Exclusion';
                        const collected = line.origin === 'Collected';
                        const changedBy = line.changedBy && line.changedAt
                          ? t('billing.changedByOn', { name: line.changedBy.name, date: formatDateTime(line.changedAt) })
                          : null;
                        return (
                          <TableRow key={line.id}>
                            <TableCell>
                              <span className={excluded ? styles.excluded : styles.description}>{line.description}</span>
                              <div className={styles.muted}>
                                {[
                                  line.productName,
                                  line.origin === 'Manual' ? t('billing.manual') : null,
                                  line.sourceOrganization ? t('billing.deliveredTo', { name: line.sourceOrganization.name }) : null,
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </div>
                              {line.decision !== 'None' && (
                                <div className={styles.muted}>
                                  {[
                                    line.decision === 'Override'
                                      ? t('billing.corrected', { reason: line.changeReason ?? '—' })
                                      : t('billing.leftOut', { reason: line.changeReason ?? '—' }),
                                    changedBy,
                                  ]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </div>
                              )}
                              {line.conflict !== 'None' && (
                                <div className={styles.conflict}>
                                  <Warning20Filled aria-hidden />
                                  <span>{conflictText(line)}</span>
                                </div>
                              )}
                            </TableCell>
                            <TableCell className={catalog.number}>{line.quantity}</TableCell>
                            {canSeeMoney && <TableCell className={catalog.number}>{formatMoney(line.unitPrice)}</TableCell>}
                            {canSeeMoney && (
                              <TableCell className={catalog.number}>
                                <span className={excluded ? styles.excluded : undefined}>{formatMoney(line.lineTotal)}</span>
                                {(line.discountPct ?? 0) > 0 && <div className={styles.muted}>{t('billing.discount', { pct: line.discountPct })}</div>}
                                {line.decision === 'Override' && line.sourceLineTotal != null && (
                                  <div className={styles.muted}>{t('billing.sourceAmount', { amount: formatMoney(line.sourceLineTotal) })}</div>
                                )}
                              </TableCell>
                            )}
                            <TableCell className={catalog.number}>{line.vatRate} %</TableCell>
                            {correctable && (
                              <TableCell>
                                {!excluded && (
                                  <Button
                                    {...restoreFocusTarget}
                                    size="small"
                                    appearance="subtle"
                                    icon={<ReceiptAdd20Regular />}
                                    aria-label={t('billing.correction.actionNamed', { description: line.description })}
                                    title={t('billing.correction.action')}
                                    onClick={() => setDialog({ kind: 'correct', line })}
                                  />
                                )}
                              </TableCell>
                            )}
                            {editable && (
                              <TableCell>
                                <span className={styles.actions}>
                                  {line.conflict !== 'None' && (
                                    <Button
                                      {...restoreFocusTarget}
                                      size="small"
                                      appearance="subtle"
                                      icon={<Checkmark20Regular />}
                                      aria-label={t('billing.keepDecisionNamed', { description: line.description })}
                                      title={t('billing.keepDecision')}
                                      onClick={() => setDialog({ kind: 'keep', line })}
                                    />
                                  )}
                                  {collected && (line.decision !== 'None' || line.conflict !== 'None') && (
                                    <Button
                                      size="small"
                                      appearance="subtle"
                                      icon={<ArrowUndo20Regular />}
                                      aria-label={
                                        excluded
                                          ? t('billing.includeAgainNamed', { description: line.description })
                                          : t('billing.useSourceNamed', { description: line.description })
                                      }
                                      title={excluded ? t('billing.includeAgain') : t('billing.useSource')}
                                      disabled={actions.revertLine.isPending}
                                      onClick={() => void revert(line)}
                                    />
                                  )}
                                  {!excluded && (
                                    <Button
                                      {...restoreFocusTarget}
                                      size="small"
                                      appearance="subtle"
                                      icon={<Edit20Regular />}
                                      aria-label={t('billing.editLineNamed', { description: line.description })}
                                      onClick={() => setDialog({ kind: 'edit', line })}
                                    />
                                  )}
                                  {collected && !excluded && (
                                    <Button
                                      {...restoreFocusTarget}
                                      size="small"
                                      appearance="subtle"
                                      icon={<Prohibited20Regular />}
                                      aria-label={t('billing.excludeLineNamed', { description: line.description })}
                                      title={t('billing.excludeLine')}
                                      onClick={() => setDialog({ kind: 'exclude', line })}
                                    />
                                  )}
                                  {!collected && (
                                    <Button
                                      size="small"
                                      appearance="subtle"
                                      icon={<Delete20Regular />}
                                      aria-label={t('billing.removeLineNamed', { description: line.description })}
                                      onClick={() => void remove(line)}
                                    />
                                  )}
                                </span>
                              </TableCell>
                            )}
                          </TableRow>
                        );
                      })}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </ScrollTable>
        )}
      </div>

      <Dialog open={dialog !== null} onOpenChange={(_, d) => !d.open && setDialog(null)}>
        <DialogSurface>
          {shown?.kind === 'add' && <LineForm basisId={id} etag={basis.etag} onClose={() => setDialog(null)} />}
          {shown?.kind === 'edit' && <LineForm basisId={id} etag={basis.etag} line={shown.line} onClose={() => setDialog(null)} />}
          {shown?.kind === 'exclude' && <DecisionForm basisId={id} etag={basis.etag} line={shown.line} kind="exclude" onClose={() => setDialog(null)} />}
          {shown?.kind === 'keep' && <DecisionForm basisId={id} etag={basis.etag} line={shown.line} kind="keep" onClose={() => setDialog(null)} />}
          {shown?.kind === 'cancel' && <CancelForm basisId={id} etag={basis.etag} onClose={() => setDialog(null)} />}
          {shown?.kind === 'reconcile' && <ReconcileForm basisId={id} etag={basis.etag} manual={shown.manual} onClose={() => setDialog(null)} />}
          {shown?.kind === 'correct' && <CorrectionForm basisId={id} line={shown.line} onClose={() => setDialog(null)} />}
        </DialogSurface>
      </Dialog>
    </>
  );
}
