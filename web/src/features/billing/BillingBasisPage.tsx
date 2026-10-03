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
import { Add20Regular, ArrowRepeatAll20Regular, Delete20Regular, Edit20Regular, Warning20Filled } from '@fluentui/react-icons';
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
});

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
  const [dialog, setDialog] = useState<{ kind: 'add' } | { kind: 'edit'; line: BasisLine } | { kind: 'cancel' } | null>(null);
  const restoreFocusTarget = useRestoreFocusTarget();

  if (isPending) return <Spinner label={t('common.loading')} />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  if (error || !basis) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const editable = canManage && basis.status === 'Draft';
  const groups = [...new Set(basis.lines.map((line) => line.group))];

  const remove = async (line: BasisLine) => {
    try {
      await actions.removeLine.mutateAsync({ lineId: line.id, etag: basis.etag });
      notify(t('billing.lineRemoved'));
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
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
            {canManage && basis.status !== 'Exported' && basis.status !== 'Cancelled' && (
              <Button {...restoreFocusTarget} appearance="subtle" onClick={() => setDialog({ kind: 'cancel' })}>
                {t('billing.cancelBasis')}
              </Button>
            )}
          </>
        }
      />

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
                {editable && <TableHeaderCell />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <>
                  <TableRow key={group} className={styles.group}>
                    <TableCell colSpan={canSeeMoney ? (editable ? 6 : 5) : editable ? 4 : 3}>{t(`billing.groups.${group}`)}</TableCell>
                  </TableRow>
                  {basis.lines
                    .filter((line) => line.group === group)
                    .map((line) => (
                      <TableRow key={line.id}>
                        <TableCell>
                          <span>{line.description}</span>
                          <div className={styles.muted}>
                            {[line.productName, line.manuallyAdjusted ? t('billing.manual') : null].filter(Boolean).join(' · ')}
                          </div>
                        </TableCell>
                        <TableCell className={catalog.number}>{line.quantity}</TableCell>
                        {canSeeMoney && <TableCell className={catalog.number}>{formatMoney(line.unitPrice)}</TableCell>}
                        {canSeeMoney && (
                          <TableCell className={catalog.number}>
                            {formatMoney(line.lineTotal)}
                            {(line.discountPct ?? 0) > 0 && <div className={styles.muted}>{t('billing.discount', { pct: line.discountPct })}</div>}
                          </TableCell>
                        )}
                        <TableCell className={catalog.number}>{line.vatRate} %</TableCell>
                        {editable && (
                          <TableCell>
                            <span className={styles.actions}>
                              <Button
                                {...restoreFocusTarget}
                                size="small"
                                appearance="subtle"
                                icon={<Edit20Regular />}
                                aria-label={t('billing.editLineNamed', { description: line.description })}
                                onClick={() => setDialog({ kind: 'edit', line })}
                              />
                              <Button
                                size="small"
                                appearance="subtle"
                                icon={<Delete20Regular />}
                                aria-label={t('billing.removeLineNamed', { description: line.description })}
                                onClick={() => void remove(line)}
                              />
                            </span>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
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
          {dialog?.kind === 'cancel' && <CancelForm basisId={id} onClose={() => setDialog(null)} />}
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
  const mutation = line ? actions.adjustLine : actions.addLine;

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
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={!description.trim() || mutation.isPending}>
            {line ? t('common.save') : t('common.create')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}

function CancelForm({ basisId, onClose }: { basisId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useBasisActions(basisId);
  const [reason, setReason] = useState('');

  const submit = async () => {
    try {
      await actions.cancel.mutateAsync(reason.trim());
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
