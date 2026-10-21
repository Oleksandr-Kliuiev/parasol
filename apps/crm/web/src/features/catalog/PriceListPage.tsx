import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  Button,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
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
  makeStyles,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import { Add20Regular, ArrowUpload20Regular, Copy20Regular, Delete20Regular, Edit20Regular, Box16Regular, Tag16Regular, Tag24Regular } from '@fluentui/react-icons';
import { RecordCell } from '../organizations/RecordCell';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { MetaLine } from '../organizations/RecordCell';
import { useRecordStyles } from '../organizations/recordStyles';
import { useKeptWhileClosing } from '../../shared/components/useKeptWhileClosing';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatMoney, formatNumber, parseDecimal } from '../../shared/utils/format';
import { NotFoundPage } from '../errors/NotFoundPage';
import { usePriceList, usePriceListActions } from './api';
import { PriceListDialog, PriceListStatusBadge } from './CatalogDialogs';
import { useCatalogStyles } from './styles';
import { useDialogStyles } from '../contracts/dialogStyles';
import { PriceSheetForm } from './PriceSheetForm';
import { ProductPicker } from './ProductPicker';
import type { PriceList, PriceListItem, ProductListItem } from './types';
import { ScrollTable } from '../../shared/components/ScrollTable';

const useStyles = makeStyles({
  productLink: { fontWeight: 700, color: 'inherit' },
  meta: { fontSize: '13px', lineHeight: '18px' },
});

export function PriceListPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const record = useRecordStyles();
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const notify = useNotify();
  const { data, error, isPending, refetch } = usePriceList(id);
  const actions = usePriceListActions(id);
  const canWrite = useCan(Permissions.catalogWrite);
  const canSeeCost = useCan(Permissions.financeCostRead);
  const [editing, setEditing] = useState(false);
  const [copying, setCopying] = useState(false);
  const [item, setItem] = useState<PriceListItem | 'new' | null>(null);
  const shownItem = useKeptWhileClosing(item);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [importing, setImporting] = useState(false);
  const restoreFocusTarget = useRestoreFocusTarget();

  if (isPending) return <Spinner label={t('common.loading')} />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const list = data.data;

  const run = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      notify(success);
    } catch (e) {
      const overlap = e instanceof ApiError && e.code === 'CAT_PRICE_LIST_OVERLAP';
      notify(overlap ? t('catalog.priceLists.overlap', { name: String(e.problem.name) }) : t('errors.generic'), 'error', overlap ? undefined : errorMessage(e, t));
    }
  };

  return (
    <>
      <PageHeader
        back={{ to: '/catalog?tab=price-lists', label: t('catalog.tabs.priceLists') }}
        title={list.name}
        meta={
          <>
            <PriceListStatusBadge status={list.status} />
            <MetaLine
              className={styles.meta}
              parts={[
                <span>{t('catalog.priceLists.forCategory', { category: list.customerCategory })}</span>,
                <span className="tabular">
                  {list.validTo ? `${formatDate(list.validFrom)} – ${formatDate(list.validTo)}` : t('catalog.from', { date: formatDate(list.validFrom) })}
                </span>,
              ]}
            />
          </>
        }
        actions={
          canWrite && (
            <>
              <Button {...restoreFocusTarget} icon={<Edit20Regular />} onClick={() => setEditing(true)}>
                {t('common.edit')}
              </Button>
              <Button {...restoreFocusTarget} icon={<Copy20Regular />} onClick={() => setCopying(true)}>
                {t('catalog.priceLists.copy')}
              </Button>
              {list.status !== 'Draft' && (
                <Button onClick={() => void run(() => actions.setActive.mutateAsync(false), t('catalog.priceLists.deactivated'))}>
                  {t('catalog.priceLists.deactivate')}
                </Button>
              )}
              {list.status === 'Draft' && (
                <Button {...restoreFocusTarget} appearance="subtle" icon={<Delete20Regular />} onClick={() => setConfirmDelete(true)}>
                  {t('common.delete')}
                </Button>
              )}
              {list.status === 'Draft' && (
                <Button appearance="primary" onClick={() => void run(() => actions.setActive.mutateAsync(true), t('catalog.priceLists.activated'))}>
                  {t('catalog.priceLists.activate')}
                </Button>
              )}
            </>
          )
        }
      />

      <Panel
        title={t('catalog.priceLists.items')}
        icon={<Tag16Regular />}
        actions={
          <>
            {/* FR-CAT-03: partner prices are cost data, and only a draft list may be re-priced. */}
            {canSeeCost && list.status === 'Draft' && (
              <Button {...restoreFocusTarget} size="small" icon={<ArrowUpload20Regular />} onClick={() => setImporting(true)}>
                {t('catalog.priceSheet.import')}
              </Button>
            )}
            {canWrite && (
              <Button {...restoreFocusTarget} size="small" icon={<Add20Regular />} onClick={() => setItem('new')}>
                {t('catalog.priceLists.addPrice')}
              </Button>
            )}
          </>
        }
      >
        <Text as="p" className={catalog.explainer}>{t('catalog.priceLists.itemsExplainer')}</Text>
        {list.items.length === 0 ? (
          <EmptyState icon={<Tag24Regular />} message={t('catalog.priceLists.noItems')} />
        ) : (
          <ScrollTable className={record.flatTable}>
            <Table className={catalog.table} style={{ minWidth: 920 }} aria-label={t('catalog.priceLists.items')}>
              <TableHeader>
                <TableRow>
                  {/* Content widths: every cell adds 12 px of padding on each side; the product takes the rest. */}
                  <TableHeaderCell>{t('catalog.fields.product')}</TableHeaderCell>
                  <TableHeaderCell className={catalog.number} style={{ width: 116 }}>{t('catalog.fields.listPrice')}</TableHeaderCell>
                  <TableHeaderCell className={catalog.number} style={{ width: 166 }}>{t('catalog.fields.unitPrice')}</TableHeaderCell>
                  {canSeeCost && <TableHeaderCell className={catalog.number} style={{ width: 106 }}>{t('catalog.fields.unitCost')}</TableHeaderCell>}
                  {canSeeCost && <TableHeaderCell className={catalog.number} style={{ width: 76 }}>{t('catalog.fields.margin')}</TableHeaderCell>}
                  {canWrite && <TableHeaderCell style={{ width: 132 }} />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.items.map((i) => (
                  <TableRow key={i.productId}>
                    <TableCell>
                      <RecordCell
                        icon={<Box16Regular />}
                        tone="spruce"
                        name={<AppLink to={`/catalog/products/${i.productId}`} className={styles.productLink}>{i.productName}</AppLink>}
                        meta={[<span className={catalog.sku}>{i.sku}</span>]}
                      />
                    </TableCell>
                    <TableCell className={catalog.number}>{formatMoney(i.listPrice, list.currency)}</TableCell>
                    <TableCell className={catalog.number}>
                      {formatMoney(i.unitPrice, list.currency)} <span className={catalog.muted}>/ {t(`catalog.units.${i.unit}`)}</span>
                      {canSeeCost && i.partnerPrice != null && (
                        <div className={catalog.muted}>
                          {t('catalog.priceLists.fromPartner', { price: formatMoney(i.partnerPrice, i.partnerCurrency ?? 'USD'), rate: formatNumber(i.exchangeRate, 4) })}
                        </div>
                      )}
                    </TableCell>
                    {canSeeCost && <TableCell className={catalog.number}>{formatMoney(i.unitCost, list.currency)}</TableCell>}
                    {canSeeCost && <TableCell className={catalog.number}>{i.marginPct != null ? `${formatNumber(i.marginPct, 1)} %` : '—'}</TableCell>}
                    {canWrite && (
                      <TableCell>
                        <span className={catalog.rowActions}>
                          <Button {...restoreFocusTarget} size="small" appearance="subtle" aria-label={t('catalog.priceLists.editPriceNamed', { name: i.productName })} onClick={() => setItem(i)}>
                            {t('common.edit')}
                          </Button>
                          <Button
                            size="small"
                            appearance="subtle"
                            icon={<Delete20Regular />}
                            aria-label={t('catalog.priceLists.removePriceNamed', { name: i.productName })}
                            onClick={() => void run(() => actions.removeItem.mutateAsync(i.productId), t('catalog.priceLists.priceRemoved'))}
                          />
                        </span>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollTable>
        )}
      </Panel>

      <PriceListDialog
        open={editing}
        onClose={() => setEditing(false)}
        existing={{ id: list.id, name: list.name, customerCategory: list.customerCategory, validFrom: list.validFrom, validTo: list.validTo, currency: list.currency, etag: data.etag }}
      />
      <Dialog open={copying} onOpenChange={(_, d) => !d.open && setCopying(false)}>
        <DialogSurface><CopyForm list={list} onClose={() => setCopying(false)} /></DialogSurface>
      </Dialog>
      <Dialog open={item !== null} onOpenChange={(_, d) => !d.open && setItem(null)}>
        <DialogSurface>{shownItem !== null && <PriceItemForm list={list} existing={shownItem === 'new' ? null : shownItem} onClose={() => setItem(null)} />}</DialogSurface>
      </Dialog>
      <Dialog open={importing} onOpenChange={(_, d) => !d.open && setImporting(false)}>
        <DialogSurface><PriceSheetForm list={list} onClose={() => setImporting(false)} /></DialogSurface>
      </Dialog>
      <Dialog open={confirmDelete} onOpenChange={(_, d) => setConfirmDelete(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('catalog.priceLists.deleteTitle', { name: list.name })}</DialogTitle>
            <DialogContent>{t('catalog.priceLists.deleteBody')}</DialogContent>
            <DialogActions>
              <Button onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
              <Button
                appearance="primary"
                onClick={() =>
                  void run(async () => {
                    await actions.remove.mutateAsync();
                    navigate('/catalog?tab=price-lists');
                  }, t('catalog.priceLists.deleted'))
                }
              >
                {t('common.delete')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

function CopyForm({ list, onClose }: { list: PriceList; onClose: () => void }) {
  const catalog = useCatalogStyles();
  const dialog = useDialogStyles();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const notify = useNotify();
  const actions = usePriceListActions(list.id);
  const nextYear = String(Number((list.validTo ?? list.validFrom).slice(0, 4)) + 1);
  const [name, setName] = useState(nextYear);
  const [validFrom, setValidFrom] = useState(`${nextYear}-01-01`);
  const [validTo, setValidTo] = useState('');
  const [adjust, setAdjust] = useState('');
  const adjustValue = parseDecimal(adjust);

  const submit = async () => {
    try {
      const response = await actions.copy.mutateAsync({ name: name.trim(), validFrom, validTo: validTo || null, adjustPct: adjustValue });
      notify(t('catalog.priceLists.copied'));
      onClose();
      navigate(`/catalog/price-lists/${response.data.id}`);
    } catch {
      // Shown below.
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{t('catalog.priceLists.copyTitle', { name: list.name })}</DialogTitle>
        <DialogContent>
          {actions.copy.error && (
            <MessageBar intent="error" className={dialog.error}>
              <MessageBarBody>{errorMessage(actions.copy.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <div className={catalog.grid}>
            <Field label={t('catalog.fields.name')} required className={catalog.wide}>
              <Input value={name} onChange={(_, d) => setName(d.value)} />
            </Field>
            <Field label={t('catalog.fields.validFrom')} required>
              <Input type="date" value={validFrom} onChange={(_, d) => setValidFrom(d.value)} />
            </Field>
            <Field label={t('catalog.fields.validTo')} hint={t('catalog.openEndedHint')}>
              <Input type="date" value={validTo} onChange={(_, d) => setValidTo(d.value)} />
            </Field>
            <Field label={t('catalog.priceLists.adjustPct')} hint={t('catalog.priceLists.adjustHint')} className={catalog.wide}>
              <Input inputMode="decimal" value={adjust} onChange={(_, d) => setAdjust(d.value)} contentAfter="%" />
            </Field>
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={!name.trim() || !validFrom || Number.isNaN(adjustValue) || actions.copy.isPending}>
            {t('catalog.priceLists.copy')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}

function PriceItemForm({ list, existing, onClose }: { list: PriceList; existing: PriceListItem | null; onClose: () => void }) {
  const catalog = useCatalogStyles();
  const dialog = useDialogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = usePriceListActions(list.id);
  const canSeeCost = useCan(Permissions.financeCostRead);
  const [product, setProduct] = useState<ProductListItem | null>(
    existing
      ? { id: existing.productId, sku: existing.sku, name: existing.productName, type: existing.productType, unit: existing.unit, listPrice: existing.listPrice, businessLine: 'Other', billingPeriod: 'Monthly', currency: list.currency, isActive: true }
      : null,
  );
  const [mode, setMode] = useState<'sales' | 'partner'>(existing?.partnerPrice != null ? 'partner' : 'sales');
  const [unitPrice, setUnitPrice] = useState(existing ? String(existing.unitPrice) : '');
  const [unitCost, setUnitCost] = useState(existing?.unitCost != null ? String(existing.unitCost) : '');
  const [partnerPrice, setPartnerPrice] = useState(existing?.partnerPrice != null ? String(existing.partnerPrice) : '');
  const [partnerCurrency, setPartnerCurrency] = useState(existing?.partnerCurrency ?? 'USD');
  const [exchangeRate, setExchangeRate] = useState(existing?.exchangeRate != null ? String(existing.exchangeRate) : '');

  const numbers = mode === 'sales'
    ? { unitPrice: parseDecimal(unitPrice), unitCost: parseDecimal(unitCost), partnerPrice: null, exchangeRate: null }
    : { unitPrice: null, unitCost: null, partnerPrice: parseDecimal(partnerPrice), exchangeRate: parseDecimal(exchangeRate) };
  const invalid =
    !product ||
    Object.values(numbers).some((n) => Number.isNaN(n)) ||
    (mode === 'sales' ? numbers.unitPrice === null : numbers.partnerPrice === null || numbers.exchangeRate === null || partnerCurrency.trim().length !== 3);

  const submit = async () => {
    if (invalid) return;
    try {
      await actions.setItem.mutateAsync({
        productId: product.id,
        request: { ...numbers, partnerCurrency: mode === 'partner' ? partnerCurrency.trim().toUpperCase() : null },
      });
      notify(t('catalog.priceLists.priceSaved'));
      onClose();
    } catch {
      // Shown below.
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{existing ? t('catalog.priceLists.editPriceNamed', { name: existing.productName }) : t('catalog.priceLists.addPrice')}</DialogTitle>
        <DialogContent>
          {actions.setItem.error && (
            <MessageBar intent="error" className={dialog.error}>
              <MessageBarBody>{errorMessage(actions.setItem.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <div className={catalog.grid}>
            <Field label={t('catalog.fields.product')} required className={catalog.wide} hint={product ? t('catalog.priceLists.listPriceIs', { price: formatMoney(product.listPrice, list.currency) }) : undefined}>
              {existing ? <Input value={`${existing.sku} ${existing.productName}`} disabled /> : <ProductPicker value={product} onChange={setProduct} exclude={list.items.map((i) => i.productId)} />}
            </Field>
            {canSeeCost && (
              <RadioGroup className={catalog.wide} layout="horizontal" value={mode} onChange={(_, d) => setMode(d.value as 'sales' | 'partner')} aria-label={t('catalog.priceLists.priceMode')}>
                <Radio value="sales" label={t('catalog.priceLists.modeSales')} />
                <Radio value="partner" label={t('catalog.priceLists.modePartner')} />
              </RadioGroup>
            )}
            {mode === 'sales' ? (
              <>
                <Field label={t('catalog.fields.unitPrice')} required>
                  <Input inputMode="decimal" value={unitPrice} onChange={(_, d) => setUnitPrice(d.value)} contentAfter={list.currency} />
                </Field>
                {canSeeCost && (
                  <Field label={t('catalog.fields.unitCost')}>
                    <Input inputMode="decimal" value={unitCost} onChange={(_, d) => setUnitCost(d.value)} contentAfter={list.currency} />
                  </Field>
                )}
              </>
            ) : (
              <>
                <Field label={t('catalog.fields.partnerPrice')} required>
                  <Input inputMode="decimal" value={partnerPrice} onChange={(_, d) => setPartnerPrice(d.value)} />
                </Field>
                <Field label={t('catalog.fields.partnerCurrency')} required>
                  <Input value={partnerCurrency} maxLength={3} onChange={(_, d) => setPartnerCurrency(d.value)} />
                </Field>
                <Field label={t('catalog.fields.exchangeRate')} required hint={t('catalog.priceLists.partnerHint')} className={catalog.wide}>
                  <Input inputMode="decimal" value={exchangeRate} onChange={(_, d) => setExchangeRate(d.value)} />
                </Field>
              </>
            )}
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={invalid || actions.setItem.isPending}>
            {t('common.save')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}
