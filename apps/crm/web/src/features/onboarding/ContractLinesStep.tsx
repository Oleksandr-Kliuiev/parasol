import { Checkbox, Field, Input, Select, Spinner, Text, makeStyles } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { AppLink } from '../../shared/components/AppLink';
import { ErrorState } from '../../shared/components/ErrorState';
import { formatDate } from '../../shared/utils/format';
import { ProductPicker } from '../catalog/ProductPicker';
import type { ContractListItem, ContractLine } from '../contracts/types';
import { estimateValid, openContract, type LineChoice } from './connectServices';

const useStyles = makeStyles({
  content: { display: 'grid', gap: '14px', gridTemplateColumns: 'minmax(0, 1fr)' },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px' },
  line: { display: 'grid', gap: '8px', paddingTop: '12px', borderTop: `1px solid ${h.line}` },
  fields: {
    display: 'grid',
    gap: '12px',
    paddingLeft: '32px',
    gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
    alignItems: 'start',
    '@media (max-width: 560px)': { gridTemplateColumns: 'minmax(0, 1fr)', paddingLeft: 0 },
  },
});

/**
 * The second step of the wizard (M43): the services go into the customer's contract as lines billed by what the service counts
 * (per Atera device, per Huntress agent, per backup user). Each line needs a product; its quantity is billed until the service has
 * counted, and the price follows the price list. A contract that already bills a service per unit says so, and its box starts empty.
 */
export function ContractLinesStep({ contracts, loading, error, onRetry, contractId, onContract, lines, existing, from, onFrom, minFrom, touched, onLine, organizationId }: {
  contracts: ContractListItem[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  contractId: string | null;
  onContract: (id: string) => void;
  lines: LineChoice[];
  existing: ContractLine[];
  from: string;
  onFrom: (day: string) => void;
  minFrom: string | null;
  touched: boolean;
  onLine: (line: LineChoice) => void;
  organizationId: string;
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
        <>
          <Text block>{t('onboarding.contract.none')}</Text>
          <AppLink to={`/contracts/new?organizationId=${organizationId}`}>{t('onboarding.contract.newContract')}</AppLink>
        </>
      ) : (
        <>
          <Field label={t('onboarding.contract.contract')}>
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
            const already = existing.some((l) => l.isCurrent && l.quantityModel === line.model);
            const productId = `contract-line-${line.system}-product`;
            return (
              <div key={line.system} className={styles.line}>
                <Checkbox checked={line.add} label={t('onboarding.contract.add', { model })}
                  onChange={(_, d) => onLine({ ...line, add: d.checked === true, decided: true })} />
                {already && <Text className={styles.muted}>{t('onboarding.contract.already', { model })}</Text>}
                {line.add && (
                  <div className={styles.fields}>
                    <Field label={t('onboarding.contract.product')} required
                      validationMessage={touched && !line.product ? t('onboarding.contract.productRequired') : undefined}>
                      <ProductPicker id={productId} value={line.product} onChange={(product) => onLine({ ...line, product })} />
                    </Field>
                    <Field label={t('onboarding.contract.estimate')} required hint={t('onboarding.contract.estimateHint')}
                      validationMessage={touched && !estimateValid(line.estimate) ? t('onboarding.contract.estimateInvalid') : undefined}>
                      <Input inputMode="numeric" value={line.estimate} onChange={(_, d) => onLine({ ...line, estimate: d.value })} />
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
