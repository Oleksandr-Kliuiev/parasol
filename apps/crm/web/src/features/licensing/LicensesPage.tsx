import { useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Button,
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
  Textarea,
  makeStyles,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import {
  ArrowRepeatAll16Regular,
  ArrowUpload20Regular,
  CalendarCancel16Regular,
  Key16Regular,
  KeyMultiple16Regular,
  KeyMultiple24Regular,
  LinkDismiss16Regular,
  Receipt16Regular,
} from '@fluentui/react-icons';
import { StatGrid, StatTile } from '../../shared/components/KpiTile';
import { useStatFitStyles } from '../billing/flushStyles';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { EmptyState } from '../../shared/components/EmptyState';
import { ListFooter } from '../../shared/components/ListFooter';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { FilterField, Toolbar } from '../../shared/components/Toolbar';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatNumber } from '../../shared/utils/format';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import { useCatalogStyles } from '../catalog/styles';
import { useDialogStyles } from '../contracts/dialogStyles';
import { LicenseUsageView, ReconciliationView } from './LicenseUsageViews';
import { useImportSubscriptions, useLicensingAttention, useSubscriptions } from './api';
import { LicenceReadAt } from './LicenceReadAt';
import { SubscriptionTable } from './SubscriptionTable';
import type { ImportResult } from './types';
import { SavedViews } from '../../shared/views/SavedViews';
import { ScrollTabList } from '../../shared/components/ScrollTabList';

const useStyles = makeStyles({
  tabs: { marginBottom: '16px', overflowX: 'auto', overflowY: 'hidden', scrollPaddingInline: '16px' },
});

/** CSP subscriptions across customers, with the two things that cost money if missed: cancellation windows and renewals. */
export function LicensesPage() {
  const styles = useStyles();
  const stat = useStatFitStyles();
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
  const subscriptions = useSubscriptions(filters, onSubscriptions);
  const { items: data, error, isPending, refetch } = subscriptions;
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
          <>
            <SavedViews scope="licenses" keys={['view', 'renewing', 'window', 'notBilled', 'unlinked']} />
            {canManage && onSubscriptions && (
              <Button {...restoreFocusTarget} appearance="primary" icon={<ArrowUpload20Regular />} onClick={() => setImporting(true)}>
                {t('licenses.import')}
              </Button>
            )}
          </>
        }
      />

      <ScrollTabList
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
      </ScrollTabList>

      {view === 'usage' && <LicenseUsageView />}
      {view === 'reconciliation' && canSeeCost && <ReconciliationView />}

      {onSubscriptions && (
        <>
          <StatGrid className={stat.fit} label={t('licenses.tiles.label')}>
            <StatTile
              icon={<Key16Regular />}
              tone="iris"
              label={t('licenses.tiles.licenses')}
              value={formatNumber(summary?.licenses ?? 0, 0)}
              note={t('licenses.tiles.licensesNote', { count: summary?.subscriptions ?? 0 })}
            />
            <StatTile
              icon={<CalendarCancel16Regular />}
              tone="ember"
              label={t('licenses.tiles.cancellationWindow')}
              value={summary?.cancellationWindowOpen ?? 0}
              status={(summary?.cancellationWindowOpen ?? 0) > 0 ? 'bad' : undefined}
              note={t('licenses.tiles.cancellationWindowNote')}
            />
            <StatTile
              icon={<ArrowRepeatAll16Regular />}
              tone="spruce"
              label={t('licenses.tiles.renewingSoon')}
              value={summary?.renewingSoon ?? 0}
              note={t('licenses.tiles.renewingSoonNote')}
            />
            <StatTile
              icon={<Receipt16Regular />}
              tone="saffron"
              label={t('licenses.tiles.notBilled')}
              value={summary?.notBilled ?? 0}
              status={(summary?.notBilled ?? 0) > 0 ? 'bad' : undefined}
              note={t('licenses.tiles.notBilledNote')}
            />
            <StatTile
              icon={<LinkDismiss16Regular />}
              label={t('licenses.tiles.withoutOrganization')}
              value={summary?.withoutOrganization ?? 0}
              note={t('licenses.notLinked')}
            />
          </StatGrid>

          <Toolbar label={t('licenses.filterLabel')}>
            <FilterField kind="search" label={t('licenses.search')}>
              <SearchBox id="licenses-search" value={search} onChange={(_, d) => setSearch(d.value)} placeholder={t('licenses.search')} />
            </FilterField>
            <Switch className={catalog.toggle} label={t('licenses.filters.window')} checked={filters.cancellationWindowOpen} onChange={(_, d) => setFlag('window', d.checked)} />
            <Switch className={catalog.toggle} label={t('licenses.filters.renewing')} checked={filters.renewingSoon} onChange={(_, d) => setFlag('renewing', d.checked)} />
            <Switch className={catalog.toggle} label={t('licenses.filters.notBilled')} checked={filters.notBilled} onChange={(_, d) => setFlag('notBilled', d.checked)} />
            <Switch className={catalog.toggle} label={t('licenses.filters.unlinked')} checked={filters.withoutOrganization} onChange={(_, d) => setFlag('unlinked', d.checked)} />
          </Toolbar>

          {error ? (
            <ErrorState error={error} onRetry={() => void refetch()} />
          ) : (
            <>
            <LicenceReadAt rows={data} />
            <SubscriptionTable
              rows={data}
              showCustomer
              canSeeCost={canSeeCost}
              empty={!isPending && <EmptyState icon={<KeyMultiple24Regular />} message={t('licenses.empty')} />}
              footer={<ListFooter shown={data.length} total={subscriptions.total} hasMore={subscriptions.hasNextPage} loading={subscriptions.isFetchingNextPage} onMore={() => void subscriptions.fetchNextPage()} />}
            />
            </>
          )}
        </>
      )}

      <Dialog open={importing} onOpenChange={(_, d) => !d.open && setImporting(false)}>
        <DialogSurface><ImportForm onClose={() => setImporting(false)} /></DialogSurface>
      </Dialog>
    </>
  );
}

function ImportForm({ onClose }: { onClose: () => void }) {
  const dialog = useDialogStyles();
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
        <p className={dialog.lead}>{t('licenses.importBody')}</p>
        <div className={dialog.grid}>
          <Field label={t('licenses.importFile')} className={dialog.wide}>
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
          <Field className={dialog.wide} label={t('licenses.importPaste')} hint={t('licenses.importHint')}>
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
        </div>
        {preview && (
          <MessageBar intent={preview.warnings.length > 0 ? 'warning' : 'info'} className={dialog.after}>
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
          <MessageBar intent="error" className={dialog.after}>
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

/** CSP subscriptions of one customer (docs/02 §4.2, tab "Licenses"), in the card every list of the customer's tabs has. */
export function OrganizationLicensesTab({ organizationId }: { organizationId: string }) {
  const { t } = useTranslation();
  const canSeeCost = useCan(Permissions.financeCostRead);
  const subscriptions = useSubscriptions({ organizationId });
  const { items: data, error, isPending, refetch } = subscriptions;

  return (
    <Panel title={t('licenses.title')} icon={<KeyMultiple16Regular />} actions={<LicenceReadAt rows={data} />}>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isPending ? null : data.length === 0 ? (
        <EmptyState icon={<KeyMultiple24Regular />} message={t('licenses.emptyForOrganization')} />
      ) : (
        <SubscriptionTable
          rows={data}
          showCustomer={false}
          canSeeCost={canSeeCost}
          inPanel
          footer={<ListFooter shown={data.length} total={subscriptions.total} hasMore={subscriptions.hasNextPage} loading={subscriptions.isFetchingNextPage} onMore={() => void subscriptions.fetchNextPage()} />}
        />
      )}
    </Panel>
  );
}
