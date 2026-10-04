import { useState } from 'react';
import { useParams } from 'react-router';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Link,
  MessageBar,
  MessageBarBody,
  Radio,
  RadioGroup,
  Spinner,
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
import {
  Add20Regular,
  ArrowRepeatAll20Regular,
  ArrowUndo20Regular,
  Checkmark20Regular,
  Delete20Regular,
  DocumentSearch20Regular,
  Edit20Regular,
  Prohibited20Regular,
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
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatDateTime, formatMoney, parseDecimal } from '../../shared/utils/format';
import { NotFoundPage } from '../errors/NotFoundPage';
import { useCatalogStyles } from '../catalog/styles';
import { ProductPicker } from '../catalog/ProductPicker';
import { useBasis, useBasisActions } from './api';
import { BasisStatusBadge, InvoiceStatusBadge } from './shared';
import { monthLabel } from './period';
import type { ProductListItem } from '../catalog/types';
import type { BasisLine } from './types';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: tokens.spacingHorizontalL, alignItems: 'start' },
  total: { fontSize: tokens.fontSizeHero700, lineHeight: tokens.lineHeightHero700, fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums' },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  anomaly: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-start', color: tokens.colorPaletteDarkOrangeForeground1 },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  group: { fontWeight: tokens.fontWeightSemibold, backgroundColor: tokens.colorNeutralBackground2 },
  actions: { display: 'flex', gap: tokens.spacingHorizontalXS },
  dialogGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: tokens.spacingHorizontalM },
  wide: { gridColumn: '1 / -1' },
  excluded: { textDecorationLine: 'line-through', color: tokens.colorNeutralForeground3 },
  conflict: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'flex-start', color: tokens.colorPaletteDarkOrangeForeground1, fontSize: tokens.fontSizeBase200 },
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
  const catalog = useCatalogStyles();
  const { t, i18n } = useTranslation();
  const { id = '' } = useParams();
  const notify = useNotify();
  const canManage = useCan(Permissions.billingManage);
  const canSeeMoney = useCan(Permissions.financeRead);
  const { data: basis, error, isPending, refetch } = useBasis(id);
  const actions = useBasisActions(id);
  const [dialog, setDialog] = useState<LineDialog | null>(null);
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
            {canManage && basis.status === 'Failed' && (
              <Button
                appearance="primary"
                icon={<ArrowRepeatAll20Regular />}
                disabled={actions.retry.isPending}
                onClick={() => void actions.retry.mutateAsync().then(() => notify(t('billing.retried')))}
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
                <li key={anomaly.code + anomaly.message}>{anomaly.message}</li>
              ))}
            </ul>
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.stack}>
        <div className={styles.grid}>
          {canSeeMoney && (
            <Panel title={t('billing.fields.total')}>
              <div className={styles.total}>{formatMoney(basis.totalExVat)}</div>
              <Text className={styles.muted}>{t('billing.exVat')}</Text>
              <DetailList
                items={[
                  { label: t('billing.fields.previousPeriod'), value: formatMoney(basis.previousPeriodTotal) },
                  { label: t('billing.fields.customerReference'), value: basis.customerReference },
                ]}
              />
            </Panel>
          )}
          <Panel title={t('billing.exportLog')}>
            <DetailList
              items={[
                { label: t('common.status'), value: t(`billing.basisStatus.${basis.status}`) },
                { label: t('billing.fields.order'), value: basis.orderNo },
                { label: t('billing.fields.exportedAt'), value: basis.exportedAt ? formatDateTime(basis.exportedAt) : null },
              ]}
            />
            {basis.attempts.length > 0 && (
              <ul className={styles.list} style={{ marginTop: tokens.spacingVerticalS }}>
                {basis.attempts.map((attempt) => (
                  <li key={attempt.at + attempt.result} className={attempt.result === 'Failed' ? undefined : styles.muted}>
                    {attempt.result === 'Failed' ? (
                      <span className={styles.anomaly}>
                        <Warning20Filled aria-hidden />
                        <span>
                          {formatDateTime(attempt.at)} — {attempt.message}
                        </span>
                      </span>
                    ) : (
                      `${formatDateTime(attempt.at)} — ${attempt.message ?? attempt.result}`
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          {basis.invoices.length > 0 && (
            <Panel title={t('billing.invoices')}>
              <ul className={styles.list}>
                {basis.invoices.map((invoice) => (
                  <li key={invoice.id}>
                    <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      {invoice.url ? (
                        <Link href={invoice.url} target="_blank" rel="noopener noreferrer">
                          {invoice.invoiceNo}
                        </Link>
                      ) : (
                        <Text weight="semibold">{invoice.invoiceNo}</Text>
                      )}
                      <InvoiceStatusBadge status={invoice.status} isOverdue={invoice.isOverdue} />
                      {canSeeMoney && <Text>{formatMoney(invoice.totalIncVat)}</Text>}
                    </span>
                    <Text block className={styles.muted}>
                      {t('billing.invoiceDates', {
                        invoiceDate: formatDate(invoice.invoiceDate),
                        dueDate: invoice.dueDate ? formatDate(invoice.dueDate) : '—',
                      })}
                    </Text>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>

        <div className={catalog.tableWrap}>
          <Table className={catalog.table} aria-label={t('billing.lines')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('billing.fields.description')}</TableHeaderCell>
                <TableHeaderCell className={catalog.number}>{t('billing.fields.quantity')}</TableHeaderCell>
                {canSeeMoney && <TableHeaderCell className={catalog.number}>{t('billing.fields.unitPrice')}</TableHeaderCell>}
                {canSeeMoney && <TableHeaderCell className={catalog.number}>{t('billing.fields.lineTotal')}</TableHeaderCell>}
                <TableHeaderCell className={catalog.number}>{t('billing.fields.vat')}</TableHeaderCell>
                {withActions && <TableHeaderCell />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <>
                  <TableRow key={group} className={styles.group}>
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
                            <span className={excluded ? styles.excluded : undefined}>{line.description}</span>
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
                </>
              ))}
            </TableBody>
          </Table>
          {basis.lines.length === 0 && <EmptyState message={t('billing.noLines')} />}
        </div>
      </div>

      <Dialog open={dialog !== null} onOpenChange={(_, d) => !d.open && setDialog(null)}>
        <DialogSurface>
          {dialog?.kind === 'add' && <LineForm basisId={id} etag={basis.etag} onClose={() => setDialog(null)} />}
          {dialog?.kind === 'edit' && <LineForm basisId={id} etag={basis.etag} line={dialog.line} onClose={() => setDialog(null)} />}
          {dialog?.kind === 'exclude' && <DecisionForm basisId={id} etag={basis.etag} line={dialog.line} kind="exclude" onClose={() => setDialog(null)} />}
          {dialog?.kind === 'keep' && <DecisionForm basisId={id} etag={basis.etag} line={dialog.line} kind="keep" onClose={() => setDialog(null)} />}
          {dialog?.kind === 'cancel' && <CancelForm basisId={id} etag={basis.etag} onClose={() => setDialog(null)} />}
          {dialog?.kind === 'reconcile' && <ReconcileForm basisId={id} etag={basis.etag} manual={dialog.manual} onClose={() => setDialog(null)} />}
          {dialog?.kind === 'correct' && <CorrectionForm basisId={id} line={dialog.line} onClose={() => setDialog(null)} />}
        </DialogSurface>
      </Dialog>
    </>
  );
}

function LineForm({ basisId, etag, line, onClose }: { basisId: string; etag: string; line?: BasisLine; onClose: () => void }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useBasisActions(basisId);
  const [product, setProduct] = useState<ProductListItem | null>(null);
  const [description, setDescription] = useState(line?.description ?? '');
  const [quantity, setQuantity] = useState(String(line?.quantity ?? 1));
  const [unitPrice, setUnitPrice] = useState(String(line?.unitPrice ?? 0));
  const [discountPct, setDiscountPct] = useState(String(line?.discountPct ?? 0));
  const [reason, setReason] = useState('');
  const canSeeMoney = useCan(Permissions.financeRead);
  const mutation = line ? actions.adjustLine : actions.addLine;
  // A collected line keeps its source values; Finance's values replace them only with a reason (BR-BIL-02).
  const needsReason = line?.origin === 'Collected';

  const submit = async () => {
    try {
      if (line) {
        await actions.adjustLine.mutateAsync({
          lineId: line.id,
          etag,
          request: {
            quantity: parseDecimal(quantity) ?? 0,
            unitPrice: parseDecimal(unitPrice) ?? 0,
            discountPct: parseDecimal(discountPct) ?? 0,
            description: description.trim(),
            reason: reason.trim() || null,
          },
        });
      } else {
        await actions.addLine.mutateAsync({
          etag,
          request: {
            productId: product?.id ?? null,
            description: description.trim(),
            quantity: parseDecimal(quantity) ?? 0,
            unitPrice: parseDecimal(unitPrice) ?? 0,
            discountPct: parseDecimal(discountPct) ?? 0,
            vatRate: null,
          },
        });
      }

      notify(line ? t('billing.lineSaved') : t('billing.lineAdded'));
      onClose();
    } catch {
      // Shown in the dialog.
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogBody>
        <DialogTitle>{line ? t('billing.editLine') : t('billing.addLine')}</DialogTitle>
        <DialogContent>
          {mutation.error && (
            <MessageBar intent="error" style={{ marginBottom: 12 }}>
              <MessageBarBody>{errorMessage(mutation.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <div className={styles.dialogGrid}>
            {!line && (
              <Field label={t('billing.fields.product')} className={styles.wide} hint={t('billing.productHint')}>
                <ProductPicker
                  value={product}
                  onChange={(picked) => {
                    setProduct(picked);
                    if (picked && !description.trim()) setDescription(picked.name);
                    if (picked && (parseDecimal(unitPrice) ?? 0) === 0) setUnitPrice(String(picked.listPrice ?? 0));
                  }}
                />
              </Field>
            )}
            <Field label={t('billing.fields.description')} required className={styles.wide}>
              <Textarea value={description} onChange={(_, d) => setDescription(d.value)} resize="vertical" />
            </Field>
            <Field label={t('billing.fields.quantity')} required>
              <Input inputMode="decimal" value={quantity} onChange={(_, d) => setQuantity(d.value)} />
            </Field>
            <Field label={t('billing.fields.unitPrice')} required>
              <Input inputMode="decimal" value={unitPrice} onChange={(_, d) => setUnitPrice(d.value)} contentAfter="NOK" />
            </Field>
            <Field label={t('billing.fields.discount')}>
              <Input inputMode="decimal" value={discountPct} onChange={(_, d) => setDiscountPct(d.value)} contentAfter="%" />
            </Field>
            {needsReason && (
              <Field
                label={t('billing.fields.reason')}
                required
                className={styles.wide}
                hint={[
                  t('billing.reasonHint'),
                  canSeeMoney && line?.sourceLineTotal != null ? t('billing.sourceAmount', { amount: formatMoney(line.sourceLineTotal) }) : null,
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <Input value={reason} onChange={(_, d) => setReason(d.value)} />
              </Field>
            )}
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={!description.trim() || (needsReason && !reason.trim()) || mutation.isPending}>
            {line ? t('common.save') : t('common.create')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}

/** Leaving a collected line out, or keeping a decision against a changed source: both are recorded with a reason. */
function DecisionForm({
  basisId,
  etag,
  line,
  kind,
  onClose,
}: {
  basisId: string;
  etag: string;
  line: BasisLine;
  kind: 'exclude' | 'keep';
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useBasisActions(basisId);
  const [reason, setReason] = useState('');
  const mutation = kind === 'exclude' ? actions.excludeLine : actions.keepLine;

  const submit = async () => {
    try {
      await mutation.mutateAsync({ lineId: line.id, reason: reason.trim(), etag });
      notify(kind === 'exclude' ? t('billing.lineExcluded') : t('billing.decisionKept'));
      onClose();
    } catch {
      // Shown in the dialog.
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogBody>
        <DialogTitle>{kind === 'exclude' ? t('billing.excludeTitle') : t('billing.keepDecision')}</DialogTitle>
        <DialogContent>
          {mutation.error && (
            <MessageBar intent="error" style={{ marginBottom: 12 }}>
              <MessageBarBody>{errorMessage(mutation.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <p style={{ marginTop: 0 }}>
            <strong>{line.description}</strong>
          </p>
          <p>{kind === 'exclude' ? t('billing.excludeBody') : t('billing.keepBody')}</p>
          <Field label={t('billing.fields.reason')} required>
            <Input value={reason} onChange={(_, d) => setReason(d.value)} />
          </Field>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={!reason.trim() || mutation.isPending}>
            {kind === 'exclude' ? t('billing.excludeLine') : t('billing.keepDecision')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}

function CancelForm({ basisId, etag, onClose }: { basisId: string; etag: string; onClose: () => void }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useBasisActions(basisId);
  const [reason, setReason] = useState('');

  const submit = async () => {
    try {
      await actions.cancel.mutateAsync({ reason: reason.trim(), etag });
      notify(t('billing.basisCancelled'));
      onClose();
    } catch {
      // Shown in the dialog.
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogBody>
        <DialogTitle>{t('billing.cancelBasis')}</DialogTitle>
        <DialogContent>
          {actions.cancel.error && (
            <MessageBar intent="error" style={{ marginBottom: 12 }}>
              <MessageBarBody>{errorMessage(actions.cancel.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <p style={{ marginTop: 0 }}>{t('billing.cancelBody')}</p>
          <Field label={t('billing.fields.reason')} required>
            <Input value={reason} onChange={(_, d) => setReason(d.value)} />
          </Field>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={!reason.trim() || actions.cancel.isPending}>
            {t('billing.cancelBasis')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}

/**
 * A send got no answer and the order is not found by its reference: Finance checks PowerOffice and records what is there —
 * the order with its number, or no order (the basis can then be sent again or cancelled). With <c>manual</c> it records an
 * order made by hand outside the CRM, so no later run bills the basis again (runbook 07). ADR-013.
 */
function ReconcileForm({ basisId, etag, manual, onClose }: { basisId: string; etag: string; manual: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useBasisActions(basisId);
  const [created, setCreated] = useState<'yes' | 'no'>('yes');
  const [orderNo, setOrderNo] = useState('');
  const [reason, setReason] = useState('');
  const valid = reason.trim() && (created === 'no' || orderNo.trim());

  const submit = async () => {
    try {
      await actions.reconcile.mutateAsync({ request: { created: created === 'yes', orderNo: created === 'yes' ? orderNo.trim() : null, reason: reason.trim() }, etag });
      notify(t('billing.reconcile.done'));
      onClose();
    } catch {
      // Shown in the dialog.
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogBody>
        <DialogTitle>{manual ? t('billing.reconcile.manualTitle') : t('billing.reconcile.title')}</DialogTitle>
        <DialogContent>
          {actions.reconcile.error && (
            <MessageBar intent="error" style={{ marginBottom: 12 }}>
              <MessageBarBody>{errorMessage(actions.reconcile.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <p style={{ marginTop: 0 }}>{manual ? t('billing.reconcile.manualBody') : t('billing.reconcile.body')}</p>
          {!manual && (
            <Field label={t('billing.reconcile.found')} required>
              <RadioGroup value={created} onChange={(_, d) => setCreated(d.value as 'yes' | 'no')}>
                <Radio value="yes" label={t('billing.reconcile.created')} />
                <Radio value="no" label={t('billing.reconcile.notCreated')} />
              </RadioGroup>
            </Field>
          )}
          {created === 'yes' && (
            <Field label={t('billing.fields.order')} required>
              <Input value={orderNo} onChange={(_, d) => setOrderNo(d.value)} />
            </Field>
          )}
          <Field label={t('billing.fields.reason')} required>
            <Input value={reason} onChange={(_, d) => setReason(d.value)} />
          </Field>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={!valid || actions.reconcile.isPending}>
            {t('common.save')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}

/** Adds to an exported line: a new charge the next run bills, with the reason; a credit is made in PowerOffice. */
function CorrectionForm({ basisId, line, onClose }: { basisId: string; line: BasisLine; onClose: () => void }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useBasisActions(basisId);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [description, setDescription] = useState(line.description);
  const parsed = parseDecimal(amount);
  const valid = parsed !== null && parsed > 0 && reason.trim().length > 0;

  const submit = async () => {
    try {
      await actions.addCorrection.mutateAsync({
        lineId: line.id,
        request: { amount: parsed!, reason: reason.trim(), description: description.trim() === line.description ? null : description.trim() || null },
      });
      notify(t('billing.correction.queued'));
      onClose();
    } catch {
      // Shown in the dialog.
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogBody>
        <DialogTitle>{t('billing.correction.title')}</DialogTitle>
        <DialogContent>
          {actions.addCorrection.error && (
            <MessageBar intent="error" style={{ marginBottom: 12 }}>
              <MessageBarBody>{errorMessage(actions.addCorrection.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <p style={{ marginTop: 0 }}>{t('billing.correction.body', { description: line.description })}</p>
          <Field label={t('billing.correction.amount')} required hint={t('billing.exVat')}>
            <Input inputMode="decimal" value={amount} onChange={(_, d) => setAmount(d.value)} />
          </Field>
          <Field label={t('billing.fields.description')}>
            <Input value={description} onChange={(_, d) => setDescription(d.value)} />
          </Field>
          <Field label={t('billing.fields.reason')} required>
            <Input value={reason} onChange={(_, d) => setReason(d.value)} />
          </Field>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={!valid || actions.addCorrection.isPending}>
            {t('billing.correction.submit')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}
