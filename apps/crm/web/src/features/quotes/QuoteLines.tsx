import {
  Button,
  Dropdown,
  Input,
  Option,
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
} from '@fluentui/react-components';
import { Add20Regular, Delete20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { formatMoney, parseDecimal } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { ProductPicker } from '../catalog/ProductPicker';
import { emptyLine, lineAmount, type LineDraft } from './lineDraft';
import { recurrences, type QuoteLine, type QuoteLineRecurrence } from './types';
import { ScrollTable } from '../../shared/components/ScrollTable';

const useStyles = makeStyles({
  narrow: { width: '80px' },
  price: { width: '120px' },
  name: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: '240px' },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  add: { marginTop: tokens.spacingVerticalS },
  over: { color: tokens.colorPaletteDarkOrangeForeground1 },
});

interface EditorProps {
  lines: LineDraft[];
  onChange: (lines: LineDraft[]) => void;
  discountLimitPct: number;
  canSeeMoney: boolean;
}

/** The line editor of a draft quote: a product from the catalog or a free-text line, with its own price and discount. */
export function QuoteLinesEditor({ lines, onChange, discountLimitPct, canSeeMoney }: EditorProps) {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();

  const update = (key: string, changes: Partial<LineDraft>) =>
    onChange(lines.map((line) => (line.key === key ? { ...line, ...changes } : line)));

  return (
    <>
      <ScrollTable className={catalog.tableWrap}>
        <Table className={catalog.table} aria-label={t('quotes.lines')}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>{t('quotes.fields.lineName')}</TableHeaderCell>
              <TableHeaderCell>{t('quotes.fields.recurrence')}</TableHeaderCell>
              <TableHeaderCell className={catalog.number}>{t('quotes.fields.quantity')}</TableHeaderCell>
              {canSeeMoney && <TableHeaderCell className={catalog.number}>{t('quotes.fields.unitPrice')}</TableHeaderCell>}
              {canSeeMoney && <TableHeaderCell className={catalog.number}>{t('quotes.fields.discount')}</TableHeaderCell>}
              {canSeeMoney && <TableHeaderCell className={catalog.number}>{t('quotes.fields.amount')}</TableHeaderCell>}
              <TableHeaderCell />
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((line) => {
              const discount = parseDecimal(line.discountPct) ?? 0;
              return (
                <TableRow key={line.key}>
                  <TableCell>
                    <div className={styles.name}>
                      <ProductPicker
                        value={line.product}
                        onChange={(product) =>
                          update(line.key, {
                            product: product ? { id: product.id, sku: product.sku, name: product.name } : null,
                            productId: product?.id ?? null,
                            sku: product?.sku ?? null,
                            name: product?.name ?? line.name,
                            unitPrice: product ? '' : line.unitPrice,
                            recurrence: product ? (product.billingPeriod === 'OneTime' ? 'OneTime' : 'Monthly') : line.recurrence,
                          })
                        }
                      />
                      <Input
                        aria-label={t('quotes.fields.lineName')}
                        placeholder={t('quotes.fields.lineName')}
                        value={line.name}
                        onChange={(_, d) => update(line.key, { name: d.value })}
                      />
                      <Textarea
                        aria-label={t('quotes.fields.lineDescription')}
                        placeholder={t('quotes.fields.lineDescription')}
                        rows={2}
                        value={line.description}
                        onChange={(_, d) => update(line.key, { description: d.value })}
                      />
                    </div>
                  </TableCell>
                  <TableCell>
                    <Dropdown
                      aria-label={t('quotes.fields.recurrence')}
                      selectedOptions={[line.recurrence]}
                      value={t(`quotes.recurrence.${line.recurrence}`)}
                      onOptionSelect={(_, d) => update(line.key, { recurrence: (d.optionValue ?? 'Monthly') as QuoteLineRecurrence })}
                    >
                      {recurrences.map((value) => (
                        <Option key={value} value={value}>
                          {t(`quotes.recurrence.${value}`)}
                        </Option>
                      ))}
                    </Dropdown>
                  </TableCell>
                  <TableCell className={catalog.number}>
                    <Input
                      className={styles.narrow}
                      aria-label={t('quotes.fields.quantity')}
                      value={line.quantity}
                      onChange={(_, d) => update(line.key, { quantity: d.value })}
                    />
                  </TableCell>
                  {canSeeMoney && (
                    <TableCell className={catalog.number}>
                      <Input
                        className={styles.price}
                        aria-label={t('quotes.fields.unitPrice')}
                        placeholder={line.productId ? t('quotes.priceFromCatalog') : ''}
                        value={line.unitPrice}
                        onChange={(_, d) => update(line.key, { unitPrice: d.value })}
                      />
                    </TableCell>
                  )}
                  {canSeeMoney && (
                    <TableCell className={catalog.number}>
                      <Input
                        className={styles.narrow}
                        aria-label={t('quotes.fields.discount')}
                        value={line.discountPct}
                        onChange={(_, d) => update(line.key, { discountPct: d.value })}
                      />
                      {discount > discountLimitPct && <div className={styles.over}>{t('quotes.overLimit', { pct: discountLimitPct })}</div>}
                    </TableCell>
                  )}
                  {canSeeMoney && <TableCell className={catalog.number}>{formatMoney(lineAmount(line))}</TableCell>}
                  <TableCell>
                    <Button
                      appearance="subtle"
                      icon={<Delete20Regular />}
                      aria-label={t('quotes.removeLineNamed', { name: line.name || t('quotes.fields.lineName') })}
                      onClick={() => onChange(lines.filter((other) => other.key !== line.key))}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </ScrollTable>
      <Button className={styles.add} icon={<Add20Regular />} onClick={() => onChange([...lines, emptyLine()])}>
        {t('quotes.addLine')}
      </Button>
    </>
  );
}

/** The lines of a quote that is no longer a draft, grouped the way the PDF shows them. */
export function QuoteLinesTable({ lines, canSeeMoney }: { lines: QuoteLine[]; canSeeMoney: boolean }) {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const groups = recurrences.filter((recurrence) => lines.some((line) => line.recurrence === recurrence));

  return (
    <ScrollTable className={catalog.tableWrap}>
      <Table className={catalog.table} aria-label={t('quotes.lines')}>
        <TableHeader>
          <TableRow>
            <TableHeaderCell>{t('quotes.fields.lineName')}</TableHeaderCell>
            <TableHeaderCell className={catalog.number}>{t('quotes.fields.quantity')}</TableHeaderCell>
            {canSeeMoney && <TableHeaderCell className={catalog.number}>{t('quotes.fields.unitPrice')}</TableHeaderCell>}
            {canSeeMoney && <TableHeaderCell className={catalog.number}>{t('quotes.fields.discount')}</TableHeaderCell>}
            {canSeeMoney && <TableHeaderCell className={catalog.number}>{t('quotes.fields.amount')}</TableHeaderCell>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map((recurrence) => (
            <>
              <TableRow key={recurrence}>
                <TableCell colSpan={canSeeMoney ? 5 : 2}>
                  <Text weight="semibold">{t(`quotes.recurrence.${recurrence}`)}</Text>
                </TableCell>
              </TableRow>
              {lines
                .filter((line) => line.recurrence === recurrence)
                .map((line) => (
                  <TableRow key={line.id}>
                    <TableCell>
                      <span>{line.name}</span>
                      {line.description && <div className={styles.muted}>{line.description}</div>}
                    </TableCell>
                    <TableCell className={catalog.number}>{line.quantity}</TableCell>
                    {canSeeMoney && <TableCell className={catalog.number}>{formatMoney(line.unitPrice)}</TableCell>}
                    {canSeeMoney && <TableCell className={catalog.number}>{line.discountPct > 0 ? `${line.discountPct} %` : '—'}</TableCell>}
                    {canSeeMoney && <TableCell className={catalog.number}>{formatMoney(line.netAmount)}</TableCell>}
                  </TableRow>
                ))}
            </>
          ))}
        </TableBody>
      </Table>
    </ScrollTable>
  );
}
