import { Checkbox, Field, Input, Select, Spinner, Text, makeStyles } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { ErrorState } from '../../shared/components/ErrorState';
import { formatDate } from '../../shared/utils/format';
import { ProductPicker } from '../catalog/ProductPicker';
import type { ContractListItem } from '../contracts/types';
import { billedBy, estimateValid, openContract, type BilledLine, type LineChoice } from './connectServices';

const useStyles = makeStyles({
  content: { display: 'grid', gap: '14px', gridTemplateColumns: 'minmax(0, 1fr)' },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px' },
  line: { display: 'grid', gap: '8px', paddingTop: '12px', borderTop: `1px solid ${h.line}` },
  // One field under the other: a product's name (SKU and name) needs the width, and two labels side by side wrap unevenly and put
  // their inputs out of line.
  fields: {
    display: 'grid',
    gap: '12px',
    paddingLeft: '32px',
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (max-width: 560px)': { paddingLeft: 0 },
  },
  quantity: { maxWidth: '160px' },
  // A native select is as wide as its longest option ("K-2026-0011 Fjord IT Drift (Active)"): the field's own grid column must
  // not grow with it, or the dialog's body scrolls sideways on a narrow phone.
  shrink: { gridTemplateColumns: 'minmax(0, 1fr)' },
});

/**
 * The second step of the wizard (M43): the services go into the customer's contract as lines billed by what the service counts
 * (per Atera device, per Huntress agent, per backup user). Each line needs a product; its quantity is billed until the service has
 * counted, and the price follows the price list. A service one of the customer's open contracts already bills from the line's day on
 * says which contract, and its box starts empty: a second line would bill the same agents or users twice.
 */
export function ContractLinesStep({ contracts, loading, error, onRetry, contractId, onContract, lines, billed, from, onFrom, minFrom, touched, onLine }: {
  contracts: ContractListItem[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  contractId: string | null;
  onContract: (id: string) => void;
  lines: LineChoice[];
  billed: BilledLine[];
  from: string;
  onFrom: (day: string) => void;
  minFrom: string | null;
  touched: boolean;
  onLine: (line: LineChoice) => void;
}) {
  const { t } = useTranslation();
  const styles = useStyles();
  const open = contracts.filter(openContract);
  if (loading) return <Spinner size="small" label={t('common.loading')} />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;

  return (
    <div className={styles.content}>
      <Text block className={styles.muted}>{t('onboarding.contract.intro')}</Text>
      {open.length === 0 ? (
        <Text block>{t('onboarding.contract.none')}</Text>
      ) : (
        <>
          <Field label={t('onboarding.contract.contract')} className={styles.shrink}>
            <Select value={contractId ?? ''} onChange={(_, d) => onContract(d.value)}>
              {open.map((c) => (
                <option key={c.id} value={c.id}>
                  {t('onboarding.contract.option', { number: c.number, title: c.title, status: t(`contracts.statuses.${c.status}`, { defaultValue: c.status }) })}
                </option>
              ))}
            </Select>
          </Field>
          {lines.map((line) => {
            const name = t(`contracts.quantityModels.${line.model}`);
            const model = name.charAt(0).toLowerCase() + name.slice(1);
            const already = billedBy(billed, line.model, from);
            const noteId = `contract-line-${line.system}-already`;
            const productId = `contract-line-${line.system}-product`;
            // Each line is a named group: its fields share their labels (Product, Quantity) with the other lines' fields.
            return (
              <div key={line.system} className={styles.line} role="group" aria-label={name}>
                <Checkbox checked={line.add} label={t('onboarding.contract.add', { model })} aria-describedby={already ? noteId : undefined}
                  onChange={(_, d) => onLine({ ...line, add: d.checked === true, decided: true })} />
                {already && (
                  <Text id={noteId} className={styles.muted}>
                    {already.contractId === contractId
                      ? t('onboarding.contract.already', { model })
                      : t('onboarding.contract.alreadyIn', { model, number: already.contractNumber })}
                  </Text>
                )}
                {line.add && (
                  <div className={styles.fields}>
                    <Field label={t('onboarding.contract.product')} required
                      validationMessage={touched && !line.product ? t('onboarding.contract.productRequired') : undefined}>
                      <ProductPicker id={productId} value={line.product} onChange={(product) => onLine({ ...line, product })} />
                    </Field>
                    <Field label={t('onboarding.contract.estimate')} required hint={t('onboarding.contract.estimateHint')}
                      validationMessage={touched && !estimateValid(line.estimate) ? t('onboarding.contract.estimateInvalid') : undefined}>
                      <Input className={styles.quantity} inputMode="numeric" value={line.estimate} onChange={(_, d) => onLine({ ...line, estimate: d.value })} />
                    </Field>
                  </div>
                )}
              </div>
            );
          })}
          {/* The day comes after the other fields: WebKit gives no focusin to a date field that opens a dialog step (M42). */}
          {lines.some((l) => l.add) && (
            <Field label={t('onboarding.contract.from')} required
              validationMessage={touched && minFrom !== null && from < minFrom ? t('onboarding.contract.fromInvalid', { date: formatDate(minFrom) }) : undefined}>
              <Input type="date" value={from} min={minFrom ?? undefined} onChange={(_, d) => onFrom(d.value)} />
            </Field>
          )}
          <Text block className={styles.muted}>{t('onboarding.contract.priceNote')}</Text>
        </>
      )}
    </div>
  );
}
