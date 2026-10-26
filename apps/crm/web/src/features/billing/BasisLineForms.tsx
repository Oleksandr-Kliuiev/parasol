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
  Radio,
  RadioGroup,
  Textarea,
  makeStyles,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatMoney, parseDecimal } from '../../shared/utils/format';
import { ProductPicker } from '../catalog/ProductPicker';
import type { ProductListItem } from '../catalog/types';
import { h } from '../../app/hearth';
import { useBasisActions } from './api';
import type { BasisLine } from './types';

/** The dialogs of a billing basis: add or edit a line, leave one out, cancel, reconcile and correct after export. */
const useStyles = makeStyles({
  // Every basis dialog: what it does in one line, then its fields, 14 px apart.
  form: { display: 'grid', gap: '14px' },
  dialogGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))', gap: '14px 16px' },
  wide: { gridColumn: '1 / -1' },
  intro: { margin: 0, maxWidth: '75ch', fontSize: '14px', lineHeight: '20px' },
  // The line a decision is about, quoted in a well above the reason.
  subject: { margin: 0, paddingTop: '10px', paddingBottom: '10px', paddingLeft: '12px', paddingRight: '12px', borderRadius: '12px', backgroundColor: h.well, fontWeight: 600, overflowWrap: 'anywhere' },
});

export function LineForm({ basisId, etag, line, onClose }: { basisId: string; etag: string; line?: BasisLine; onClose: () => void }) {
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
        <DialogContent className={styles.form}>
          {mutation.error && (
            <MessageBar intent="error">
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
export function DecisionForm({
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
  const styles = useStyles();
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
        <DialogContent className={styles.form}>
          {mutation.error && (
            <MessageBar intent="error">
              <MessageBarBody>{errorMessage(mutation.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <p className={styles.subject}>{line.description}</p>
          <p className={styles.intro}>{kind === 'exclude' ? t('billing.excludeBody') : t('billing.keepBody')}</p>
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

export function CancelForm({ basisId, etag, onClose }: { basisId: string; etag: string; onClose: () => void }) {
  const styles = useStyles();
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
        <DialogContent className={styles.form}>
          {actions.cancel.error && (
            <MessageBar intent="error">
              <MessageBarBody>{errorMessage(actions.cancel.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <p className={styles.intro}>{t('billing.cancelBody')}</p>
          <Field label={t('billing.fields.reason')} required>
            <Input value={reason} onChange={(_, d) => setReason(d.value)} />
          </Field>
        </DialogContent>
        <DialogActions>
          {/* "Cancel" beside "Cancel basis" reads as the same act: the way out says what it keeps. */}
          <Button onClick={onClose}>{t('billing.keepBasis')}</Button>
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
export function ReconcileForm({ basisId, etag, manual, onClose }: { basisId: string; etag: string; manual: boolean; onClose: () => void }) {
  const styles = useStyles();
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
        <DialogContent className={styles.form}>
          {actions.reconcile.error && (
            <MessageBar intent="error">
              <MessageBarBody>{errorMessage(actions.reconcile.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <p className={styles.intro}>{manual ? t('billing.reconcile.manualBody') : t('billing.reconcile.body')}</p>
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
export function CorrectionForm({ basisId, line, onClose }: { basisId: string; line: BasisLine; onClose: () => void }) {
  const styles = useStyles();
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
        <DialogContent className={styles.form}>
          {actions.addCorrection.error && (
            <MessageBar intent="error">
              <MessageBarBody>{errorMessage(actions.addCorrection.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <p className={styles.intro}>{t('billing.correction.body', { description: line.description })}</p>
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
