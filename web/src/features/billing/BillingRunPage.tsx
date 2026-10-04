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
import { Permissions, useCan, useCurrentUser } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDateTime, formatMoney, formatNumber } from '../../shared/utils/format';
import { Panel } from '../../shared/components/Panel';
import { NotFoundPage } from '../errors/NotFoundPage';
import { useCatalogStyles } from '../catalog/styles';
import { useBases, useBillingSettings, useRun, useRunActions } from './api';
import { BasisStatusBadge, RunStatusBadge } from './shared';
import { monthLabel } from './period';
import type { Approval, Run } from './types';

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
  approvals: { marginBottom: tokens.spacingVerticalL },
  approvalList: { margin: 0, paddingInlineStart: tokens.spacingHorizontalL, display: 'grid', rowGap: tokens.spacingVerticalXS },
  setAside: { color: tokens.colorNeutralForeground3 },
  subheading: { margin: `${tokens.spacingVerticalM} 0 ${tokens.spacingVerticalXS}`, fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold },
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
  const me = useCurrentUser();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const anomaliesOnly = params.get('anomalies') === 'true';
  const { data: run, error, isPending, isFetching, refetch } = useRun(id);
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

  // An approval may release the run or wait for the other one; the notice says which.
  const approveRun = async (mutation: typeof actions.approve) => {
    try {
      const response = await mutation.mutateAsync(run.etag);
      notify(response.data.status === 'Approved' ? t('billing.approved') : t('billing.approvalGiven'));
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
  // Approvals are about the revision on screen, and the two approvals of a run come from two people in either order: a user
  // who signed this revision is not offered the other approval (BR-BIL-04, ADR-012).
  const awaitingApproval = ['Collected', 'InReview'].includes(run.status);
  const current = run.approvals.filter((a) => a.valid);
  const signedByMe = current.some((a) => a.approvedBy.id === me.id);
  const firstMissing = !current.some((a) => a.kind === 'First');
  const secondMissing = run.requiresSecondApproval && !current.some((a) => a.kind === 'Second');
  const needsFirstApproval = canApprove && awaitingApproval && firstMissing && !signedByMe;
  const needsSecondApproval = canApproveSecond && awaitingApproval && secondMissing && !signedByMe;
  const otherPersonNeeded = awaitingApproval && signedByMe && (firstMissing || secondMissing);
  const lastReset = awaitingApproval && current.length === 0 ? latestSetAside(run.approvals) : undefined;
  // A command is about the revision on screen: while a newer one is loading (after a change on a basis page, say), the
  // buttons wait instead of sending an ETag the server will refuse.
  const refreshing = isFetching && !isPending;
  // The server refuses approval while a line waits for a decision; the button says so instead of failing.
  const blockedByConflicts = run.conflicts > 0;
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
            {run.kind === 'Supplementary' && (
              <Badge appearance="outline" color="informative">
                {t('billing.supplementary.badge')}
              </Badge>
            )}
            {run.notes && <Text className={styles.label}>{run.notes}</Text>}
          </>
        }
        actions={
          <>
            {canCollect && (
              <Button
                icon={<ArrowSyncCheckmark20Regular />}
                disabled={actions.collect.isPending || refreshing}
                onClick={() => void act(() => actions.collect.mutateAsync(run.etag), t('billing.collected'))}
              >
                {run.status === 'Draft' ? t('billing.collect') : t('billing.recollect')}
              </Button>
            )}
            {needsFirstApproval && (
              <Button
                appearance="primary"
                icon={<CheckmarkCircle20Regular />}
                disabled={actions.approve.isPending || blockedByConflicts || refreshing}
                onClick={() => void approveRun(actions.approve)}
              >
                {t('billing.approve')}
              </Button>
            )}
            {needsSecondApproval && (
              <Button
                appearance="primary"
                icon={<CheckmarkCircle20Regular />}
                disabled={actions.secondApprove.isPending || blockedByConflicts || refreshing}
                onClick={() => void approveRun(actions.secondApprove)}
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

      {blockedByConflicts && (
        <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>{t('billing.conflictsBanner', { count: run.conflicts })}</MessageBarBody>
        </MessageBar>
      )}
      {lastReset?.invalidationReason && (
        <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>
            {t('billing.approvals.resetBanner', { revision: run.contentRevision })} {t(`billing.approvals.reasons.${lastReset.invalidationReason}`)}
          </MessageBarBody>
        </MessageBar>
      )}
      {otherPersonNeeded && (
        <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>{t('billing.approvals.otherPerson')}</MessageBarBody>
        </MessageBar>
      )}
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

      {(run.approvals.length > 0 || awaitingApproval) && <ApprovalsPanel run={run} />}

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
                    {basis.conflicts > 0 && <div className={styles.anomaly}>{t('billing.conflictsCount', { count: basis.conflicts })}</div>}
                    {basis.anomalies.length === 0 ? (
                      basis.conflicts > 0 ? null : '—'
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

/** The approval that was set aside last; its reason explains why the run waits for approval again. */
function latestSetAside(approvals: Approval[]): Approval | undefined {
  return approvals
    .filter((a) => !a.valid && a.invalidatedAt)
    .reduce<Approval | undefined>((latest, a) => (!latest || a.invalidatedAt! > latest.invalidatedAt! ? a : latest), undefined);
}

/** Which revision waits for approval, who approved it and which earlier approvals were set aside, and why (ADR-012). */
function ApprovalsPanel({ run }: { run: Run }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const current = run.approvals.filter((a) => a.valid);
  const setAside = run.approvals.filter((a) => !a.valid);
  const released = !['Draft', 'Collected', 'InReview'].includes(run.status);
  // Revision 0 is how runs approved before DEV-02 were sealed: nobody approved a digest of their content.
  const legacy = released && (run.approvedRevision === null || run.approvedRevision === 0);
  const line = (approval: Approval) =>
    t('billing.approvals.entry', {
      kind: t(`billing.approvals.kind.${approval.kind}`),
      name: approval.approvedBy.name,
      date: formatDateTime(approval.approvedAt),
    });

  return (
    <div className={styles.approvals}>
      <Panel title={t('billing.approvals.title')}>
        <Text>
          {legacy
            ? t('billing.approvals.releasedLegacy')
            : released
              ? t('billing.approvals.released', { revision: run.approvedRevision })
              : `${t('billing.approvals.waiting', { revision: run.contentRevision })} ${
                  run.requiresSecondApproval ? t('billing.approvals.needsTwo') : t('billing.approvals.needsOne')
                }`}
        </Text>
        {current.length > 0 && (
          <ul className={styles.approvalList} style={{ marginTop: tokens.spacingVerticalS }}>
            {current.map((approval) => (
              <li key={`${approval.kind}-${approval.approvedAt}`}>{line(approval)}</li>
            ))}
          </ul>
        )}
        {setAside.length > 0 && (
          <>
            <h3 className={styles.subheading}>{t('billing.approvals.setAsideTitle')}</h3>
            <ul className={`${styles.approvalList} ${styles.setAside}`}>
              {setAside.map((approval) => (
                <li key={`${approval.kind}-${approval.approvedAt}-${approval.contentRevision}`}>
                  {t('billing.approvals.setAsideEntry', { entry: line(approval), revision: approval.contentRevision })}
                  {approval.invalidationReason && <> {t(`billing.approvals.reasons.${approval.invalidationReason}`)}</>}
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>
    </div>
  );
}
