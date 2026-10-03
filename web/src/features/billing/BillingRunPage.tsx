import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
  SearchBox,
  Spinner,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { ArrowSyncCheckmark20Regular, CheckmarkCircle20Regular, Send20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDateTime, formatMoney, formatNumber } from '../../shared/utils/format';
import { NotFoundPage } from '../errors/NotFoundPage';
import { useCatalogStyles } from '../catalog/styles';
import { useBases, useBillingSettings, useRun, useRunActions } from './api';
import { BasisStatusBadge, RunStatusBadge } from './shared';
import { monthLabel } from './period';

const useStyles = makeStyles({
  tiles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalL },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  value: { fontSize: tokens.fontSizeHero700, lineHeight: tokens.lineHeightHero700, fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums' },
  label: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  warn: { color: tokens.colorPaletteDarkOrangeForeground1 },
  anomaly: { color: tokens.colorPaletteDarkOrangeForeground1, fontSize: tokens.fontSizeBase200 },
  change: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
});

/** One run: what was collected, what needs a look and the way to approval and export. */
export function BillingRunPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t, i18n } = useTranslation();
  const { id = '' } = useParams();
  const notify = useNotify();
  const canManage = useCan(Permissions.billingManage);
  const canApprove = useCan(Permissions.billingApprove);
  const canApproveSecond = useCan(Permissions.billingApproveSecond);
  const canSeeMoney = useCan(Permissions.financeRead);
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const anomaliesOnly = params.get('anomalies') === 'true';
  const { data: run, error, isPending, refetch } = useRun(id);
  const settings = useBillingSettings();
  const bases = useBases(id, { anomaliesOnly, search: search.trim() });
  const actions = useRunActions(id);
  const [closing, setClosing] = useState(false);
  const restoreFocusTarget = useRestoreFocusTarget();

  if (isPending) return <Spinner label={t('common.loading')} />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  if (error || !run) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const act = async (action: () => Promise<unknown>, message: string) => {
    try {
      await action();
      notify(message);
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  const setFlag = (value: boolean) => {
    const next = new URLSearchParams(params);
    if (value) next.set('anomalies', 'true');
    else next.delete('anomalies');
    setParams(next, { replace: true });
  };

  const canCollect = canManage && ['Draft', 'Collected', 'InReview'].includes(run.status);
  const needsFirstApproval = canApprove && ['Collected', 'InReview'].includes(run.status) && !run.approvedBy;
  const needsSecondApproval = canApproveSecond && run.requiresSecondApproval && ['Collected', 'InReview'].includes(run.status) && !run.secondApprovedBy;
  const canExport = canManage && ['Approved', 'ExportedWithErrors'].includes(run.status);
  const canClose = canManage && ['Exported', 'ExportedWithErrors'].includes(run.status);

  return (
    <>
      <PageHeader
        back={{ to: '/billing', label: t('billing.title') }}
        title={monthLabel(run.periodStart, i18n.language)}
        meta={
          <>
            <RunStatusBadge status={run.status} requiresSecondApproval={run.requiresSecondApproval} />
            {run.notes && <Text className={styles.label}>{run.notes}</Text>}
          </>
        }
        actions={
          <>
            {canCollect && (
              <Button
                icon={<ArrowSyncCheckmark20Regular />}
                disabled={actions.collect.isPending}
                onClick={() => void act(() => actions.collect.mutateAsync(), t('billing.collected'))}
              >
                {run.status === 'Draft' ? t('billing.collect') : t('billing.recollect')}
              </Button>
            )}
            {needsFirstApproval && (
              <Button
                appearance="primary"
                icon={<CheckmarkCircle20Regular />}
                disabled={actions.approve.isPending}
                onClick={() => void act(() => actions.approve.mutateAsync(), t('billing.approved'))}
              >
                {t('billing.approve')}
              </Button>
            )}
            {needsSecondApproval && (
              <Button
                appearance="primary"
                icon={<CheckmarkCircle20Regular />}
                disabled={actions.secondApprove.isPending}
                onClick={() => void act(() => actions.secondApprove.mutateAsync(), t('billing.approved'))}
              >
                {t('billing.secondApprove')}
              </Button>
            )}
            {canExport && (
              <Button
                icon={<Send20Regular />}
                disabled={actions.exportRun.isPending}
                onClick={() => void act(() => actions.exportRun.mutateAsync(), t('billing.exportQueued'))}
              >
                {run.failed > 0 ? t('billing.retryFailed', { count: run.failed }) : t('billing.export')}
              </Button>
            )}
            {canClose && (
              <Button {...restoreFocusTarget} onClick={() => setClosing(true)}>
                {t('billing.close')}
              </Button>
            )}
          </>
        }
      />

      {run.requiresSecondApproval && run.status === 'InReview' && (
        <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>
            {t('billing.secondApprovalNeeded', { amount: formatMoney(settings.data?.secondApprovalThreshold ?? 0) })}
          </MessageBarBody>
        </MessageBar>
      )}
      {run.failed > 0 && (
        <MessageBar intent="error" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>{t('billing.failedBases', { count: run.failed })}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.tiles}>
        {canSeeMoney && (
          <div className={styles.tile}>
            <span className={styles.value}>{formatMoney(run.totalExVat)}</span>
            <span className={styles.label}>{t('billing.fields.total')}</span>
          </div>
        )}
        <div className={styles.tile}>
          <span className={styles.value}>{formatNumber(run.organizations, 0)}</span>
          <span className={styles.label}>{t('billing.fields.customers')}</span>
        </div>
        <div className={styles.tile}>
          <span className={`${styles.value} ${run.withAnomalies > 0 ? styles.warn : ''}`}>{run.withAnomalies}</span>
          <span className={styles.label}>{t('billing.fields.anomalies')}</span>
        </div>
        <div className={styles.tile}>
          <span className={styles.value}>{run.exported}</span>
          <span className={styles.label}>{t('billing.fields.exported')}</span>
        </div>
        {run.failed > 0 && (
          <div className={styles.tile}>
            <span className={`${styles.value} ${styles.warn}`}>{run.failed}</span>
            <span className={styles.label}>{t('billing.fields.failed')}</span>
          </div>
        )}
      </div>

      <div className={catalog.filters}>
        <SearchBox
          id="billing-search"
          className={catalog.search}
          value={search}
          onChange={(_, d) => setSearch(d.value)}
          placeholder={t('billing.searchCustomer')}
          aria-label={t('billing.searchCustomer')}
        />
        <Switch label={t('billing.anomaliesOnly')} checked={anomaliesOnly} onChange={(_, d) => setFlag(d.checked)} />
        {(run.approvedBy || run.secondApprovedBy) && (
          <Text className={styles.label}>
            {t('billing.approvedByNames', {
              names: [run.approvedBy?.name, run.secondApprovedBy?.name].filter(Boolean).join(', '),
            })}
          </Text>
        )}
      </div>

      {bases.error ? (
        <ErrorState error={bases.error} onRetry={() => void bases.refetch()} />
      ) : (
        <div className={catalog.tableWrap}>
          <Table className={catalog.table} aria-label={t('billing.bases')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('billing.fields.customer')}</TableHeaderCell>
                <TableHeaderCell>{t('common.status')}</TableHeaderCell>
                <TableHeaderCell className={catalog.number}>{t('billing.fields.lines')}</TableHeaderCell>
                {canSeeMoney && <TableHeaderCell className={catalog.number}>{t('billing.fields.total')}</TableHeaderCell>}
                <TableHeaderCell>{t('billing.fields.needsAttention')}</TableHeaderCell>
                <TableHeaderCell>{t('billing.fields.order')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(bases.data ?? []).map((basis) => (
                <TableRow key={basis.id}>
                  <TableCell>
                    <AppLink to={`/billing/bases/${basis.id}`}>{basis.organization.name}</AppLink>
                  </TableCell>
                  <TableCell>
                    <BasisStatusBadge status={basis.status} />
                  </TableCell>
                  <TableCell className={catalog.number}>{basis.lines}</TableCell>
                  {canSeeMoney && (
                    <TableCell className={catalog.number}>
                      {formatMoney(basis.totalExVat)}
                      {(basis.previousPeriodTotal ?? 0) > 0 && (
                        <div className={styles.change}>{t('billing.previousPeriod', { amount: formatMoney(basis.previousPeriodTotal) })}</div>
                      )}
                    </TableCell>
                  )}
                  <TableCell>
                    {basis.anomalies.length === 0 ? (
                      '—'
                    ) : (
                      <span className={styles.anomaly}>
                        {basis.anomalies
                          .slice(0, 2)
                          .map((a) => a.message)
                          .join(' ')}
                        {basis.anomalies.length > 2 ? ` +${basis.anomalies.length - 2}` : ''}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {basis.orderNo ? (
                      <span>
                        <Badge appearance="outline" color="success">
                          {basis.orderNo}
                        </Badge>
                        {basis.exportedAt && <div className={styles.change}>{formatDateTime(basis.exportedAt)}</div>}
                      </span>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!bases.isPending && (bases.data ?? []).length === 0 && <EmptyState message={t('billing.noBases')} />}
        </div>
      )}

      <Dialog open={closing} onOpenChange={(_, d) => !d.open && setClosing(false)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('billing.closeTitle')}</DialogTitle>
            <DialogContent>{t('billing.closeBody')}</DialogContent>
            <DialogActions>
              <Button onClick={() => setClosing(false)}>{t('common.cancel')}</Button>
              <Button
                appearance="primary"
                disabled={actions.close.isPending}
                onClick={() => {
                  setClosing(false);
                  void act(() => actions.close.mutateAsync(), t('billing.closed'));
                }}
              >
                {t('billing.close')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
