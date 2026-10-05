import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Spinner,
  Tab,
  TabList,
  Text,
  makeStyles,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Delete20Regular, Edit20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { DetailList, Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDateTime, formatMoney, formatNumber } from '../../shared/utils/format';
import { HistoryList } from '../audit/HistoryList';
import { NotFoundPage } from '../errors/NotFoundPage';
import { LinkedSystemsPanel } from '../integrations/LinkedSystemsPanel';
import { useProduct, useProductActions } from './api';

const useStyles = makeStyles({
  tabs: { marginBottom: tokens.spacingVerticalL, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: tokens.spacingHorizontalL, alignItems: 'start' },
  sku: { fontFamily: tokens.fontFamilyMonospace, color: tokens.colorNeutralForeground3 },
  components: { margin: 0, paddingInlineStart: tokens.spacingHorizontalL },
});

export function ProductDetailPage() {
  const styles = useStyles();
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const notify = useNotify();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'history' ? 'history' : 'overview';
  const { data, error, isPending, refetch } = useProduct(id);
  const canWrite = useCan(Permissions.catalogWrite);
  const canSeeCost = useCan(Permissions.financeCostRead);
  const actions = useProductActions(id);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const restoreFocusTarget = useRestoreFocusTarget();

  if (isPending) return <Spinner label={t('common.loading')} />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const p = data.data;

  const toggleActive = async () => {
    try {
      await actions.setActive.mutateAsync(!p.isActive);
      notify(p.isActive ? t('catalog.detail.deactivated') : t('catalog.detail.activated'));
      await refetch();
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  const remove = async () => {
    try {
      await actions.remove.mutateAsync();
      notify(t('catalog.detail.deleted'));
      navigate('/catalog');
    } catch {
      // The dialog explains why (usually: the product is in use).
    }
  };

  const inUse = actions.remove.error instanceof ApiError && actions.remove.error.code === 'CAT_PRODUCT_IN_USE';

  return (
    <>
      <PageHeader
        back={{ to: '/catalog', label: t('catalog.title') }}
        title={p.name}
        meta={
          <>
            <Text className={styles.sku}>{p.sku}</Text>
            <Badge appearance="tint" color="brand">{t(`catalog.types.${p.type}`)}</Badge>
            {!p.isActive && <Badge appearance="outline" color="subtle">{t('catalog.inactive')}</Badge>}
          </>
        }
        actions={
          canWrite && (
            <>
              <Button icon={<Edit20Regular />} onClick={() => navigate(`/catalog/products/${p.id}/edit`)}>
                {t('common.edit')}
              </Button>
              <Button onClick={() => void toggleActive()} disabled={actions.setActive.isPending}>
                {p.isActive ? t('catalog.detail.deactivate') : t('catalog.detail.activate')}
              </Button>
              <Button {...restoreFocusTarget} appearance="subtle" icon={<Delete20Regular />} onClick={() => { actions.remove.reset(); setConfirmDelete(true); }}>
                {t('common.delete')}
              </Button>
            </>
          )
        }
      />
      <TabList className={styles.tabs} selectedValue={tab} onTabSelect={(_, d) => setParams(d.value === 'overview' ? {} : { tab: String(d.value) }, { replace: true })}>
        <Tab value="overview">{t('organizations.tabs.overview')}</Tab>
        <Tab value="history">{t('organizations.tabs.history')}</Tab>
      </TabList>

      {tab === 'history' ? (
        <HistoryList module="catalog" entityType="Product" entityId={p.id} />
      ) : (
        <div className={styles.grid}>
          <Panel title={t('catalog.sections.pricing')}>
            <DetailList
              items={[
                { label: t('catalog.fields.listPrice'), value: `${formatMoney(p.listPrice, p.currency)} / ${t(`catalog.units.${p.unit}`)}` },
                ...(canSeeCost
                  ? [
                      { label: t('catalog.fields.unitCost'), value: formatMoney(p.unitCost, p.currency) },
                      { label: t('catalog.fields.margin'), value: p.marginPct != null ? `${formatNumber(p.marginPct, 1)} %` : null },
                    ]
                  : []),
                { label: t('catalog.fields.billingPeriod'), value: t(`catalog.periods.${p.billingPeriod}`) },
                { label: t('catalog.fields.vatRate'), value: `${p.vatRate} %` },
              ]}
            />
          </Panel>
          <Panel title={t('catalog.sections.product')}>
            <DetailList
              items={[
                { label: t('catalog.fields.businessLine'), value: t(`catalog.businessLines.${p.businessLine}`) },
                { label: t('catalog.fields.nameEn'), value: p.nameEn },
                { label: t('catalog.fields.description'), value: p.description },
                ...(p.type === 'MicrosoftLicense'
                  ? [
                      { label: t('catalog.fields.microsoftOfferId'), value: p.microsoftOfferId },
                      { label: t('catalog.fields.commitmentTerm'), value: t(`catalog.terms.${p.commitmentTerm}`) },
                    ]
                  : []),
              ]}
            />
          </Panel>
          {p.type === 'Bundle' && (
            <Panel title={t('catalog.sections.bundle')}>
              <ul className={styles.components}>
                {p.components.map((c) => (
                  <li key={c.productId}>
                    {formatNumber(c.quantity)} × <AppLink to={`/catalog/products/${c.productId}`}>{c.name ?? c.productId}</AppLink>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          <Panel title={t('catalog.sections.mapping')}>
            <DetailList
              items={[
                { label: t('catalog.fields.ateraWorkType'), value: p.ateraWorkType },
                { label: t('catalog.fields.revenueAccount'), value: p.revenueAccount },
              ]}
            />
          </Panel>
          <LinkedSystemsPanel entityType="Product" entityId={p.id} emptyHint={t('catalog.detail.notLinked')} />
          <Panel title={t('organizations.sections.record')}>
            <DetailList
              items={[
                { label: t('organizations.fields.createdAt'), value: formatDateTime(p.createdAt) },
                { label: t('organizations.fields.modifiedAt'), value: formatDateTime(p.modifiedAt) },
              ]}
            />
          </Panel>
        </div>
      )}

      <Dialog open={confirmDelete} onOpenChange={(_, d) => setConfirmDelete(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('catalog.detail.deleteTitle', { name: p.name })}</DialogTitle>
            <DialogContent>
              {inUse ? t('catalog.detail.inUse') : t('catalog.detail.deleteBody')}
              {actions.remove.error && !inUse && <Text block style={{ color: tokens.colorPaletteRedForeground1, marginTop: 8 }}>{errorMessage(actions.remove.error, t)}</Text>}
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setConfirmDelete(false)}>{inUse ? t('common.close') : t('common.cancel')}</Button>
              {inUse ? (
                p.isActive && (
                  <Button appearance="primary" onClick={() => { setConfirmDelete(false); void toggleActive(); }}>
                    {t('catalog.detail.deactivate')}
                  </Button>
                )
              ) : (
                <Button appearance="primary" onClick={() => void remove()} disabled={actions.remove.isPending}>
                  {t('common.delete')}
                </Button>
              )}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
