import { Fragment } from 'react';
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
  mergeClasses,
} from '@fluentui/react-components';
import { Add20Regular, Delete20Regular, TextBulletListLtr16Regular, TextBulletListLtr24Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../../shared/components/EmptyState';
import { Panel } from '../../shared/components/Panel';
import { formatMoney, formatNumber, parseDecimal } from '../../shared/utils/format';
import { useRecordStyles } from '../organizations/recordStyles';
import { useCatalogStyles } from '../catalog/styles';
import { ProductPicker } from '../catalog/ProductPicker';
import { emptyLine, lineAmount, type LineDraft, pricedOnSave } from './lineDraft';
import { recurrences, type QuoteLine, type QuoteLineRecurrence } from './types';
import { ScrollTable } from '../../shared/components/ScrollTable';
import { h } from '../../app/hearth';

const useStyles = makeStyles({
  // The editor's columns get fixed widths so a field never spills into its neighbour (Fluent tables lay out fixed).
  editor: { minWidth: '1040px' },
  narrow: { width: '80px', maxWidth: '100%' },
  price: { width: '120px', maxWidth: '100%' },
  name: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0, '& .fui-Combobox': { minWidth: 0, width: '100%' } },
  fill: { minWidth: 0, width: '100%' },
  muted: { color: h.muted, fontSize: '12px' },
  over: { color: h.saffronT, fontSize: '12px', lineHeight: '16px', marginTop: '4px' },
  // The heading row of a group of lines (monthly, one-time), as the PDF groups them.
  group: { color: h.muted, fontSize: '12px', fontWeight: 700, letterSpacing: '0.02em', textTransform: 'uppercase' },
  lineName: { fontWeight: 600 },
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

  const record = useRecordStyles();
  const update = (key: string, changes: Partial<LineDraft>) =>
    onChange(lines.map((line) => (line.key === key ? { ...line, ...changes } : line)));

  return (
    <Panel
      title={t('quotes.lines')}
      icon={<TextBulletListLtr16Regular />}
      actions={
        <Button size="small" icon={<Add20Regular />} onClick={() => onChange([...lines, emptyLine()])}>
          {t('quotes.addLine')}
        </Button>
      }
    >
      <ScrollTable className={record.flatTable}>
        <Table className={mergeClasses(catalog.table, styles.editor)} aria-label={t('quotes.lines')}>
          <TableHeader>
            <TableRow>
              {/* Content widths: every cell adds 12 px of padding on each side; the description takes the rest. */}
              <TableHeaderCell>{t('quotes.fields.lineName')}</TableHeaderCell>
              <TableHeaderCell style={{ width: 156 }}>{t('quotes.fields.recurrence')}</TableHeaderCell>
              <TableHeaderCell className={catalog.number} style={{ width: 80 }}>{t('quotes.fields.quantity')}</TableHeaderCell>
              {canSeeMoney && <TableHeaderCell className={catalog.number} style={{ width: 120 }}>{t('quotes.fields.unitPrice')}</TableHeaderCell>}
              {canSeeMoney && <TableHeaderCell className={catalog.number} style={{ width: 96 }}>{t('quotes.fields.discount')}</TableHeaderCell>}
              {canSeeMoney && <TableHeaderCell className={catalog.number} style={{ width: 116 }}>{t('quotes.fields.amount')}</TableHeaderCell>}
              <TableHeaderCell style={{ width: 40 }} />
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
                      className={styles.fill}
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
                  {/* Not "NOK 0.00" for a line whose price the price list gives on saving: it says so. */}
                  {canSeeMoney && <TableCell className={catalog.number}>{pricedOnSave(line)
                    ? <span className={catalog.muted}>{t('quotes.pricedOnSave')}</span> : formatMoney(lineAmount(line))}</TableCell>}
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
      {lines.length === 0 && <EmptyState icon={<TextBulletListLtr24Regular />} message={t('quotes.noLines')} />}
    </Panel>
  );
}

/** The lines of a quote that is no longer a draft, grouped the way the PDF shows them. */
export function QuoteLinesTable({ lines, canSeeMoney }: { lines: QuoteLine[]; canSeeMoney: boolean }) {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const record = useRecordStyles();
  const { t } = useTranslation();
  const groups = recurrences.filter((recurrence) => lines.some((line) => line.recurrence === recurrence));

  return (
    <Panel title={t('quotes.lines')} icon={<TextBulletListLtr16Regular />}>
      {lines.length === 0 ? (
        <EmptyState icon={<TextBulletListLtr24Regular />} message={t('quotes.noLines')} />
      ) : (
        <ScrollTable className={record.flatTable}>
          <Table className={catalog.table} style={{ minWidth: 770 }} aria-label={t('quotes.lines')}>
            <TableHeader>
              <TableRow>
                {/* Content widths: every cell adds 12 px of padding on each side; the description takes the rest. */}
                <TableHeaderCell>{t('quotes.fields.lineName')}</TableHeaderCell>
                <TableHeaderCell className={catalog.number} style={{ width: 76 }}>{t('quotes.fields.quantity')}</TableHeaderCell>
                {canSeeMoney && <TableHeaderCell className={catalog.number} style={{ width: 126 }}>{t('quotes.fields.unitPrice')}</TableHeaderCell>}
                {canSeeMoney && <TableHeaderCell className={catalog.number} style={{ width: 86 }}>{t('quotes.fields.discount')}</TableHeaderCell>}
                {canSeeMoney && <TableHeaderCell className={catalog.number} style={{ width: 126 }}>{t('quotes.fields.amount')}</TableHeaderCell>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((recurrence) => (
                <Fragment key={recurrence}>
                  <TableRow>
                    <TableCell colSpan={canSeeMoney ? 5 : 2}>
                      <Text className={styles.group}>{t(`quotes.recurrence.${recurrence}`)}</Text>
                    </TableCell>
                  </TableRow>
                  {lines
                    .filter((line) => line.recurrence === recurrence)
                    .map((line) => (
                      <TableRow key={line.id}>
                        <TableCell>
                          <span className={styles.lineName}>{line.name}</span>
                          {line.description && <div className={styles.muted}>{line.description}</div>}
                        </TableCell>
                        <TableCell className={catalog.number}>{formatNumber(line.quantity)}</TableCell>
                        {canSeeMoney && <TableCell className={catalog.number}>{formatMoney(line.unitPrice)}</TableCell>}
                        {canSeeMoney && <TableCell className={catalog.number}>{line.discountPct > 0 ? `${formatNumber(line.discountPct)} %` : '—'}</TableCell>}
                        {canSeeMoney && <TableCell className={catalog.number}>{formatMoney(line.netAmount)}</TableCell>}
                      </TableRow>
                    ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </ScrollTable>
      )}
    </Panel>
  );
}
