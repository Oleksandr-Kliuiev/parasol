import { useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  MessageBar,
  MessageBarBody,
  SearchBox,
  Switch,
  Tab,
  TabList,
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
import { ArrowUpload20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatDateTime, formatMoney, formatNumber } from '../../shared/utils/format';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import { useCatalogStyles } from '../catalog/styles';
import { LicenseUsageView, ReconciliationView } from './LicenseUsageViews';
import { useImportSubscriptions, useLicensingAttention, useSubscriptions } from './api';
import type { ImportResult, Subscription } from './types';

const useStyles = makeStyles({
  tiles: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalL,
  },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  value: {
    fontSize: tokens.fontSizeHero700,
    lineHeight: tokens.lineHeightHero700,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
  },
  label: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  warn: { color: tokens.colorPaletteDarkOrangeForeground1 },
  tabs: { marginBottom: tokens.spacingVerticalM },
});

/** CSP subscriptions across customers, with the two things that cost money if missed: cancellation windows and renewals. */
export function LicensesPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const canManage = useCan(Permissions.licensingManage);
  const canSeeCost = useCan(Permissions.financeCostRead);
  const [params, setParams] = useSearchParams();
  const view = params.get('view') ?? 'subscriptions';
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search.trim());
  const filters = {
    search: debounced,
    renewingSoon: params.get('renewing') === 'true',
    cancellationWindowOpen: params.get('window') === 'true',
    notBilled: params.get('notBilled') === 'true',
    withoutOrganization: params.get('unlinked') === 'true',
  };
  const onSubscriptions = view === 'subscriptions';
  const { data = [], error, isPending, refetch } = useSubscriptions(filters, onSubscriptions);
  const attention = useLicensingAttention(onSubscriptions);
  const [importing, setImporting] = useState(false);
  const restoreFocusTarget = useRestoreFocusTarget();
  const summary = attention.data?.summary;

  const setFlag = (key: string, value: boolean) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, 'true');
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title={t('licenses.title')}
        subtitle={t('licenses.subtitle')}
        actions={
          canManage &&
          onSubscriptions && (
            <Button {...restoreFocusTarget} appearance="primary" icon={<ArrowUpload20Regular />} onClick={() => setImporting(true)}>
              {t('licenses.import')}
            </Button>
          )
        }
      />

      <TabList
        className={styles.tabs}
        selectedValue={view}
        onTabSelect={(_, d) => {
          const next = new URLSearchParams(params);
          if (d.value === 'subscriptions') next.delete('view');
          else next.set('view', String(d.value));
          setParams(next, { replace: true });
        }}
      >
        <Tab value="subscriptions">{t('licenses.tabs.subscriptions')}</Tab>
        <Tab value="usage">{t('licenses.tabs.usage')}</Tab>
        {canSeeCost && <Tab value="reconciliation">{t('licenses.tabs.reconciliation')}</Tab>}
      </TabList>

      {view === 'usage' && <LicenseUsageView />}
      {view === 'reconciliation' && canSeeCost && <ReconciliationView />}

      {onSubscriptions && (
        <>
          <div className={styles.tiles}>
            <div className={styles.tile}>
              <span className={styles.value}>{formatNumber(summary?.licenses ?? 0, 0)}</span>
              <span className={styles.label}>
                {t('licenses.tiles.licenses', {
                  subscriptions: summary?.subscriptions ?? 0,
                })}
              </span>
            </div>
            <div className={styles.tile}>
              <span className={`${styles.value} ${(summary?.cancellationWindowOpen ?? 0) > 0 ? styles.warn : ''}`}>{summary?.cancellationWindowOpen ?? 0}</span>
              <span className={styles.label}>{t('licenses.tiles.cancellationWindow')}</span>
            </div>
            <div className={styles.tile}>
              <span className={styles.value}>{summary?.renewingSoon ?? 0}</span>
              <span className={styles.label}>{t('licenses.tiles.renewingSoon')}</span>
            </div>
            <div className={styles.tile}>
              <span className={`${styles.value} ${(summary?.notBilled ?? 0) > 0 ? styles.warn : ''}`}>{summary?.notBilled ?? 0}</span>
              <span className={styles.label}>{t('licenses.tiles.notBilled')}</span>
            </div>
            <div className={styles.tile}>
              <span className={styles.value}>{summary?.withoutOrganization ?? 0}</span>
              <span className={styles.label}>{t('licenses.tiles.withoutOrganization')}</span>
            </div>
          </div>

          <div className={catalog.filters}>
            <SearchBox
              id="licenses-search"
              className={catalog.search}
              value={search}
              onChange={(_, d) => setSearch(d.value)}
              placeholder={t('licenses.search')}
              aria-label={t('licenses.search')}
            />
            <Switch label={t('licenses.filters.window')} checked={filters.cancellationWindowOpen} onChange={(_, d) => setFlag('window', d.checked)} />
            <Switch label={t('licenses.filters.renewing')} checked={filters.renewingSoon} onChange={(_, d) => setFlag('renewing', d.checked)} />
            <Switch label={t('licenses.filters.notBilled')} checked={filters.notBilled} onChange={(_, d) => setFlag('notBilled', d.checked)} />
            <Switch label={t('licenses.filters.unlinked')} checked={filters.withoutOrganization} onChange={(_, d) => setFlag('unlinked', d.checked)} />
          </div>

          {error ? (
            <ErrorState error={error} onRetry={() => void refetch()} />
          ) : (
            <div className={catalog.tableWrap}>
              <Table className={catalog.table} aria-label={t('licenses.title')}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>{t('licenses.fields.offer')}</TableHeaderCell>
                    <TableHeaderCell>{t('licenses.fields.customer')}</TableHeaderCell>
                    <TableHeaderCell className={catalog.number}>{t('licenses.fields.quantity')}</TableHeaderCell>
                    <TableHeaderCell>{t('licenses.fields.term')}</TableHeaderCell>
                    <TableHeaderCell>{t('licenses.fields.renewal')}</TableHeaderCell>
                    {canSeeCost && <TableHeaderCell className={catalog.number}>{t('licenses.fields.partnerPrice')}</TableHeaderCell>}
                    <TableHeaderCell>{t('licenses.fields.billing')}</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((subscription) => (
                    <TableRow key={subscription.id}>
                      <TableCell>
                        <span className={catalog.name}>{subscription.offerName ?? subscription.offerId}</span>
                        <div className={catalog.sku}>
                          {subscription.offerId}
                          {subscription.source === 'Distributor' ? ` · ${t('licenses.sources.Distributor')}` : ''}
                        </div>
                      </TableCell>
                      <TableCell>
                        {subscription.organizationId ? (
                          <AppLink to={`/organizations/${subscription.organizationId}?tab=licenses`}>{subscription.organizationName}</AppLink>
                        ) : (
                          <span>
                            {subscription.cspCustomerName}
                            <div className={catalog.sku}>{t('licenses.notLinked')}</div>
                          </span>
                        )}
                      </TableCell>
                      <TableCell className={catalog.number}>{subscription.quantity}</TableCell>
                      <TableCell>
                        {subscription.term === 'Unknown' ? '—' : t(`licenses.terms.${subscription.term}`)}
                        <div className={catalog.sku}>{subscription.autoRenew ? t('licenses.autoRenews') : t('licenses.noAutoRenew')}</div>
                      </TableCell>
                      <TableCell className="tabular">
                        {subscription.renewalDate
                          ? formatDate(subscription.renewalDate)
                          : subscription.commitmentEndDate
                            ? formatDate(subscription.commitmentEndDate)
                            : '—'}
                        {subscription.cancellationWindowOpen && subscription.cancellationWindowEndsAt && (
                          <div>
                            <Badge appearance="tint" color="warning">
                              {t('licenses.windowUntil', {
                                at: formatDateTime(subscription.cancellationWindowEndsAt),
                              })}
                            </Badge>
                          </div>
                        )}
                      </TableCell>
                      {canSeeCost && <TableCell className={catalog.number}>{formatMoney(subscription.partnerUnitPrice)}</TableCell>}
                      <TableCell>
                        {subscription.isBilled ? (
                          <Badge appearance="tint" color="success">
                            {t('licenses.billed')}
                          </Badge>
                        ) : (
                          <Badge appearance="tint" color="warning">
                            {subscription.productId ? t('licenses.noContractLine') : t('licenses.noProduct')}
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {!isPending && data.length === 0 && <EmptyState message={t('licenses.empty')} />}
            </div>
          )}
        </>
      )}

      <Dialog open={importing} onOpenChange={(_, d) => !d.open && setImporting(false)}>
        <DialogSurface>{importing && <ImportForm onClose={() => setImporting(false)} />}</DialogSurface>
      </Dialog>
    </>
  );
}

function ImportForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const importSubscriptions = useImportSubscriptions();
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<ImportResult | null>(null);

  const run = async (dryRun: boolean) => {
    try {
      const result = await importSubscriptions.mutateAsync({ csv, dryRun });
      if (dryRun) {
        setPreview(result);
      } else {
        notify(
          t('licenses.imported', {
            created: result.created,
            updated: result.updated,
          }),
        );
        onClose();
      }
    } catch (e) {
      notify(t('licenses.importFailed'), 'error', errorMessage(e, t));
    }
  };

  const onFile = async (file: File) => {
    setCsv(await file.text());
    setPreview(null);
  };

  return (
    <DialogBody>
      <DialogTitle>{t('licenses.importTitle')}</DialogTitle>
      <DialogContent>
        <p style={{ marginTop: 0 }}>{t('licenses.importBody')}</p>
        <Field label={t('licenses.importFile')}>
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            aria-label={t('licenses.importFile')}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onFile(file);
            }}
          />
        </Field>
        <Field label={t('licenses.importPaste')} hint={t('licenses.importHint')}>
          <Textarea
            value={csv}
            onChange={(_, d) => {
              setCsv(d.value);
              setPreview(null);
            }}
            resize="vertical"
            rows={6}
          />
        </Field>
        {preview && (
          <MessageBar intent={preview.warnings.length > 0 ? 'warning' : 'info'} style={{ marginTop: 12 }}>
            <MessageBarBody>
              {t('licenses.previewResult', {
                created: preview.created,
                updated: preview.updated,
                unchanged: preview.unchanged,
              })}
              {preview.warnings.length > 0 ? ` ${preview.warnings.join(' ')}` : ''}
            </MessageBarBody>
          </MessageBar>
        )}
        {importSubscriptions.error && (
          <MessageBar intent="error" style={{ marginTop: 12 }}>
            <MessageBarBody>{errorMessage(importSubscriptions.error, t)}</MessageBarBody>
          </MessageBar>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button onClick={() => void run(true)} disabled={!csv.trim() || importSubscriptions.isPending}>
          {t('licenses.preview')}
        </Button>
        <Button appearance="primary" onClick={() => void run(false)} disabled={!csv.trim() || importSubscriptions.isPending}>
          {t('licenses.importNow')}
        </Button>
      </DialogActions>
    </DialogBody>
  );
}

/** CSP subscriptions of one customer (docs/02 §4.2, tab "Licenses"). */
export function OrganizationLicensesTab({ organizationId }: { organizationId: string }) {
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const canSeeCost = useCan(Permissions.financeCostRead);
  const { data = [], error, isPending, refetch } = useSubscriptions({ organizationId });

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  return (
    <div className={catalog.tableWrap}>
      <Table className={catalog.table} aria-label={t('licenses.title')}>
        <TableHeader>
          <TableRow>
            <TableHeaderCell>{t('licenses.fields.offer')}</TableHeaderCell>
            <TableHeaderCell className={catalog.number}>{t('licenses.fields.quantity')}</TableHeaderCell>
            <TableHeaderCell>{t('licenses.fields.term')}</TableHeaderCell>
            <TableHeaderCell>{t('licenses.fields.renewal')}</TableHeaderCell>
            {canSeeCost && <TableHeaderCell className={catalog.number}>{t('licenses.fields.partnerPrice')}</TableHeaderCell>}
            <TableHeaderCell>{t('licenses.fields.billing')}</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((subscription: Subscription) => (
            <TableRow key={subscription.id}>
              <TableCell>
                <span className={catalog.name}>{subscription.offerName ?? subscription.offerId}</span>
                <div className={catalog.sku}>{subscription.productName ?? subscription.offerId}</div>
              </TableCell>
              <TableCell className={catalog.number}>{subscription.quantity}</TableCell>
              <TableCell>{subscription.term === 'Unknown' ? '—' : t(`licenses.terms.${subscription.term}`)}</TableCell>
              <TableCell className="tabular">
                {subscription.renewalDate ? formatDate(subscription.renewalDate) : subscription.commitmentEndDate ? formatDate(subscription.commitmentEndDate) : '—'}
                {subscription.cancellationWindowOpen && subscription.cancellationWindowEndsAt && (
                  <div>
                    <Badge appearance="tint" color="warning">
                      {t('licenses.windowUntil', {
                        at: formatDateTime(subscription.cancellationWindowEndsAt),
                      })}
                    </Badge>
                  </div>
                )}
              </TableCell>
              {canSeeCost && <TableCell className={catalog.number}>{formatMoney(subscription.partnerUnitPrice)}</TableCell>}
              <TableCell>
                {subscription.isBilled ? (
                  <Text>{t('licenses.billed')}</Text>
                ) : (
                  <Badge appearance="tint" color="warning">
                    {subscription.productId ? t('licenses.noContractLine') : t('licenses.noProduct')}
                  </Badge>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!isPending && data.length === 0 && <EmptyState message={t('licenses.emptyForOrganization')} />}
    </div>
  );
}
