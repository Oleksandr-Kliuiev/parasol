import { useState } from 'react';
import {
  Button,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { blankToNull, formatDate, formatMoney, parseDecimal, todayIso } from '../../shared/utils/format';
import { ProductPicker } from '../catalog/ProductPicker';
import type { ProductListItem } from '../catalog/types';
import { useContractActions, useHourBankActions } from './api';
import { useDialogStyles } from './dialogStyles';
import { deviceFilters, quantityModels, type Contract, type ContractLine, type DeviceFilter, type HourBankEntryKind, type QuantityModel } from './types';


function ServerError({ error }: { error: unknown }) {
  const styles = useDialogStyles();
  const { t } = useTranslation();
  if (!error) return null;
  return (
    <MessageBar intent="error" className={styles.error}>
      <MessageBarBody>{errorMessage(error, t)}</MessageBarBody>
    </MessageBar>
  );
}

const isNumber = (value: number | null): value is number => value !== null && !Number.isNaN(value);

export function LineForm({ contract, onClose }: { contract: Contract; onClose: () => void }) {
  const styles = useDialogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useContractActions(contract.id);
  const canSeePrices = useCan(Permissions.financeRead);
  const [product, setProduct] = useState<ProductListItem | null>(null);
  const [model, setModel] = useState<QuantityModel>('Fixed');
  const [filter, setFilter] = useState<DeviceFilter>('All');
  const [quantity, setQuantity] = useState('1');
  const [price, setPrice] = useState('');
  const [discount, setDiscount] = useState('');
  const [description, setDescription] = useState('');
  const [validFrom, setValidFrom] = useState(contract.status === 'Draft' ? contract.startDate : todayIso() < contract.startDate ? contract.startDate : todayIso());
  const q = parseDecimal(quantity);
  const p = parseDecimal(price);
  const d = parseDecimal(discount);
  const invalid = !product || !isNumber(q) || q < 0 || Number.isNaN(p) || Number.isNaN(d) || (d !== null && (d < 0 || d > 100));

  const submit = async () => {
    if (invalid) return;
    try {
      await actions.addLine.mutateAsync({
        productId: product.id,
        description: blankToNull(description),
        quantityModel: model,
        deviceFilter: model === 'PerAteraDevice' ? filter : null,
        quantity: q,
        unitPrice: p,
        discountPct: d,
        validFrom,
        validTo: null,
      });
      notify(t('contracts.lines.added'));
      onClose();
    } catch {
      // Shown in the dialog.
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{t('contracts.lines.add')}</DialogTitle>
        <DialogContent>
          <ServerError error={actions.addLine.error} />
          <div className={styles.grid}>
            <Field label={t('catalog.fields.product')} required className={styles.wide}>
              <ProductPicker value={product} onChange={setProduct} />
            </Field>
            <Field label={t('contracts.fields.quantityModel')} required hint={t(`contracts.quantityModelHints.${model}`)}>
              <Dropdown value={t(`contracts.quantityModels.${model}`)} selectedOptions={[model]} onOptionSelect={(_, o) => setModel(o.optionValue as QuantityModel)}>
                {quantityModels.map((m) => (
                  <Option key={m} value={m}>
                    {t(`contracts.quantityModels.${m}`)}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            {model === 'PerAteraDevice' && (
              <Field label={t('contracts.fields.deviceFilter')}>
                <Dropdown value={t(`contracts.deviceFilters.${filter}`)} selectedOptions={[filter]} onOptionSelect={(_, o) => setFilter(o.optionValue as DeviceFilter)}>
                  {deviceFilters.map((f) => (
                    <Option key={f} value={f}>
                      {t(`contracts.deviceFilters.${f}`)}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
            )}
            <Field label={model === 'Fixed' || model === 'Manual' ? t('contracts.fields.quantity') : t('contracts.fields.estimatedQuantity')} required>
              <Input inputMode="decimal" value={quantity} onChange={(_, o) => setQuantity(o.value)} />
            </Field>
            {canSeePrices && (
              <>
                <Field label={t('contracts.fields.unitPrice')} hint={product ? t('contracts.lines.priceHint', { price: formatMoney(product.listPrice) }) : t('contracts.lines.priceHintEmpty')}>
                  <Input inputMode="decimal" value={price} onChange={(_, o) => setPrice(o.value)} contentAfter="NOK" />
                </Field>
                <Field label={t('contracts.fields.discountPct')}>
                  <Input inputMode="decimal" value={discount} onChange={(_, o) => setDiscount(o.value)} contentAfter="%" />
                </Field>
              </>
            )}
            <Field label={t('contracts.fields.validFrom')} required>
              <Input type="date" value={validFrom} min={contract.startDate} onChange={(_, o) => setValidFrom(o.value)} />
            </Field>
            <Field label={t('contracts.fields.lineDescription')} className={styles.wide}>
              <Input value={description} onChange={(_, o) => setDescription(o.value)} />
            </Field>
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={invalid || actions.addLine.isPending}>
            {t('contracts.lines.add')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}

export function ReviseLineForm({ contract, line, onClose }: { contract: Contract; line: ContractLine; onClose: () => void }) {
  const styles = useDialogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useContractActions(contract.id);
  const canSeePrices = useCan(Permissions.financeRead);
  const draft = contract.status === 'Draft';
  const [quantity, setQuantity] = useState(String(line.quantity));
  const [price, setPrice] = useState(line.unitPrice != null ? String(line.unitPrice) : '');
  const [discount, setDiscount] = useState(line.discountPct ? String(line.discountPct) : '');
  const [effectiveFrom, setEffectiveFrom] = useState(() => {
    const firstOfNextMonth = new Date();
    firstOfNextMonth.setMonth(firstOfNextMonth.getMonth() + 1, 1);
    return new Intl.DateTimeFormat('sv-SE').format(firstOfNextMonth);
  });
  const q = parseDecimal(quantity);
  const p = parseDecimal(price);
  const d = parseDecimal(discount);
  const invalid = !isNumber(q) || q < 0 || Number.isNaN(p) || Number.isNaN(d) || (!draft && effectiveFrom <= line.validFrom);

  const submit = async () => {
    if (invalid) return;
    try {
      await actions.reviseLine.mutateAsync({
        lineId: line.id,
        quantity: q,
        // Users who cannot see prices keep the current price.
        unitPrice: canSeePrices ? p : (line.unitPrice ?? null),
        discountPct: canSeePrices ? d : (line.discountPct ?? null),
        description: line.description,
        effectiveFrom: draft ? line.validFrom : effectiveFrom,
      });
      notify(draft ? t('contracts.lines.updated') : t('contracts.lines.revised', { date: formatDate(effectiveFrom) }));
      onClose();
    } catch {
      // Shown in the dialog.
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{t('contracts.lines.changeTitle', { name: line.productName })}</DialogTitle>
        <DialogContent>
          <ServerError error={actions.reviseLine.error} />
          {!draft && (
            <MessageBar intent="info" className={styles.error}>
              <MessageBarBody>{t('contracts.lines.versionInfo')}</MessageBarBody>
            </MessageBar>
          )}
          <div className={styles.grid}>
            <Field label={t('contracts.fields.quantity')} required>
              <Input inputMode="decimal" value={quantity} onChange={(_, o) => setQuantity(o.value)} />
            </Field>
            {canSeePrices && (
              <>
                <Field label={t('contracts.fields.unitPrice')} hint={t('contracts.lines.priceHintEmpty')}>
                  <Input inputMode="decimal" value={price} onChange={(_, o) => setPrice(o.value)} contentAfter="NOK" />
                </Field>
                <Field label={t('contracts.fields.discountPct')}>
                  <Input inputMode="decimal" value={discount} onChange={(_, o) => setDiscount(o.value)} contentAfter="%" />
                </Field>
              </>
            )}
            {!draft && (
              <Field label={t('contracts.fields.effectiveFrom')} required validationMessage={effectiveFrom <= line.validFrom ? t('contracts.lines.effectiveAfterStart', { date: formatDate(line.validFrom) }) : undefined}>
                <Input type="date" value={effectiveFrom} onChange={(_, o) => setEffectiveFrom(o.value)} />
              </Field>
            )}
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={invalid || actions.reviseLine.isPending}>
            {t('common.save')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}

/** Ends a contract, gives notice or ends one line: all of them ask for a date. */
export function DateActionForm({
  contract,
  kind,
  line,
  onClose,
}: {
  contract: Contract;
  kind: 'notice' | 'end' | 'endLine';
  line?: ContractLine;
  onClose: () => void;
}) {
  const styles = useDialogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useContractActions(contract.id);
  const today = todayIso();
  const [noticeDate, setNoticeDate] = useState(today);
  const earliest = (() => {
    const d = new Date(`${noticeDate}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + contract.noticePeriodDays);
    return d.toISOString().slice(0, 10);
  })();
  const [date, setDate] = useState(kind === 'notice' ? (contract.endDate && contract.endDate >= earliest ? contract.endDate : earliest) : today);
  const mutation = kind === 'endLine' ? actions.endLine : actions.transition;
  const tooEarly = kind === 'notice' && date < earliest;

  const submit = async () => {
    try {
      if (kind === 'endLine') await actions.endLine.mutateAsync({ lineId: line!.id, endDate: date });
      else if (kind === 'notice') await actions.transition.mutateAsync({ action: 'notice', body: { noticeDate, endDate: date } });
      else await actions.transition.mutateAsync({ action: 'end', body: { endDate: date } });
      notify(t(`contracts.dateActions.${kind}.done`));
      onClose();
    } catch {
      // Shown in the dialog.
    }
  };

  const serverTooShort = mutation.error instanceof ApiError && mutation.error.code === 'CON_NOTICE_TOO_SHORT';

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{t(`contracts.dateActions.${kind}.title`, { name: line?.productName ?? contract.number })}</DialogTitle>
        <DialogContent>
          {!serverTooShort && <ServerError error={mutation.error} />}
          <p className={styles.lead}>{t(`contracts.dateActions.${kind}.body`, { days: contract.noticePeriodDays })}</p>
          <div className={styles.grid}>
            {kind === 'notice' && (
              <Field label={t('contracts.fields.noticeDate')} required>
                <Input type="date" value={noticeDate} onChange={(_, o) => setNoticeDate(o.value)} />
              </Field>
            )}
            <Field
              label={t('contracts.fields.endDate')}
              required
              validationState={tooEarly || serverTooShort ? 'error' : 'none'}
              validationMessage={tooEarly || serverTooShort ? t('contracts.dateActions.notice.earliest', { date: formatDate(earliest) }) : undefined}
            >
              <Input type="date" value={date} onChange={(_, o) => setDate(o.value)} />
            </Field>
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={!date || tooEarly || mutation.isPending}>
            {t(`contracts.dateActions.${kind}.confirm`)}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}

export function HourBankForm({ organizationId, contractId, onClose }: { organizationId: string; contractId: string | null; onClose: () => void }) {
  const styles = useDialogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useHourBankActions();
  const canSeePrices = useCan(Permissions.financeRead);
  const [name, setName] = useState(t('contracts.hourBanks.defaultName'));
  const [hours, setHours] = useState('20');
  const [validFrom, setValidFrom] = useState(todayIso());
  const [validTo, setValidTo] = useState('');
  const [rate, setRate] = useState('');
  const h = parseDecimal(hours);
  const r = parseDecimal(rate);
  const invalid = !name.trim() || !isNumber(h) || h <= 0 || Number.isNaN(r) || (validTo !== '' && validTo < validFrom);

  const submit = async () => {
    if (invalid) return;
    try {
      await actions.create.mutateAsync({ organizationId, contractId, name: name.trim(), hours: h, validFrom, validTo: validTo || null, overageRate: r });
      notify(t('contracts.hourBanks.created'));
      onClose();
    } catch {
      // Shown in the dialog.
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{t('contracts.hourBanks.new')}</DialogTitle>
        <DialogContent>
          <ServerError error={actions.create.error} />
          <div className={styles.grid}>
            <Field label={t('contracts.fields.name')} required className={styles.wide}>
              <Input value={name} onChange={(_, o) => setName(o.value)} />
            </Field>
            <Field label={t('contracts.fields.hours')} required>
              <Input inputMode="decimal" value={hours} onChange={(_, o) => setHours(o.value)} contentAfter={t('contracts.hoursShort')} />
            </Field>
            {canSeePrices && (
              <Field label={t('contracts.fields.overageRate')} hint={t('contracts.hourBanks.overageHint')}>
                <Input inputMode="decimal" value={rate} onChange={(_, o) => setRate(o.value)} contentAfter="NOK" />
              </Field>
            )}
            <Field label={t('contracts.fields.validFrom')} required>
              <Input type="date" value={validFrom} onChange={(_, o) => setValidFrom(o.value)} />
            </Field>
            <Field label={t('contracts.fields.validTo')}>
              <Input type="date" value={validTo} onChange={(_, o) => setValidTo(o.value)} />
            </Field>
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={invalid || actions.create.isPending}>
            {t('common.create')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}

export function HourBankEntryForm({ bankId, onClose }: { bankId: string; onClose: () => void }) {
  const styles = useDialogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useHourBankActions();
  const [kind, setKind] = useState<HourBankEntryKind>('Consumption');
  const [hours, setHours] = useState('');
  const [date, setDate] = useState(todayIso());
  const [description, setDescription] = useState('');
  const h = parseDecimal(hours);
  const invalid = !isNumber(h) || h === 0 || (kind !== 'Adjustment' && h < 0) || (kind === 'Adjustment' && !description.trim());

  const submit = async () => {
    if (invalid) return;
    try {
      const result = await actions.addEntry.mutateAsync({ id: bankId, kind, hours: h, date, description: blankToNull(description) });
      notify(t('contracts.hourBanks.entryAdded'), result.data.isLow ? 'warning' : 'success', result.data.isLow ? t('contracts.hourBanks.lowWarning') : undefined);
      onClose();
    } catch {
      // Shown in the dialog.
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{t('contracts.hourBanks.addEntry')}</DialogTitle>
        <DialogContent>
          <ServerError error={actions.addEntry.error} />
          <div className={styles.grid}>
            <Field label={t('contracts.fields.entryKind')} required>
              <Dropdown value={t(`contracts.entryKinds.${kind}`)} selectedOptions={[kind]} onOptionSelect={(_, o) => setKind(o.optionValue as HourBankEntryKind)}>
                {(['Consumption', 'Purchase', 'Adjustment'] as const).map((k) => (
                  <Option key={k} value={k}>
                    {t(`contracts.entryKinds.${k}`)}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label={t('contracts.fields.hours')} required hint={kind === 'Adjustment' ? t('contracts.hourBanks.adjustmentHint') : undefined}>
              <Input inputMode="decimal" value={hours} onChange={(_, o) => setHours(o.value)} contentAfter={t('contracts.hoursShort')} />
            </Field>
            <Field label={t('contracts.fields.date')} required>
              <Input type="date" value={date} onChange={(_, o) => setDate(o.value)} />
            </Field>
            <Field label={t('contracts.fields.entryDescription')} required={kind === 'Adjustment'} className={styles.wide}>
              <Input value={description} onChange={(_, o) => setDescription(o.value)} />
            </Field>
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={invalid || actions.addEntry.isPending}>
            {t('common.save')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}
