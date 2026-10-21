import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import {
  Avatar,
  Badge,
  Button,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  SearchBox,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import {
  ArrowSyncCheckmark20Regular,
  Building16Regular,
  BuildingMultiple24Regular,
  CheckmarkCircle16Regular,
  CheckmarkCircle20Regular,
  ClipboardTaskListLtr20Regular,
  Money16Regular,
  PersonAvailable16Regular,
  Send16Regular,
  Send20Regular,
  Warning16Regular,
} from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Permissions, useCan, useCurrentUser } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { FilterChips, FilterField, Toolbar } from '../../shared/components/Toolbar';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDateTime, formatMoney, formatNumber } from '../../shared/utils/format';
import { Panel } from '../../shared/components/Panel';
import { NotFoundPage } from '../errors/NotFoundPage';
import { useCatalogStyles } from '../catalog/styles';
import { useBases, useBillingSettings, useRun, useRunActions } from './api';
import { anomalyText } from './anomalyText';
import { BasisStatusBadge, RunStatusBadge } from './shared';
import { monthLabel } from './period';
import type { Approval, Run } from './types';
import { ScrollTable } from '../../shared/components/ScrollTable';
import { StatGrid, StatTile } from '../../shared/components/KpiTile';
import { h } from '../../app/hearth';
import { useFlushStyles, useStatFitStyles } from './flushStyles';
import { RecordRow, RowMeta } from './RecordRow';

const useStyles = makeStyles({
  label: { color: h.muted, fontSize: '13px' },
  anomaly: { color: h.saffronT, fontSize: '12.5px', lineHeight: '18px' },
  change: { fontSize: '12.5px', lineHeight: '18px', color: h.muted },
  approvals: { marginBottom: '16px' },
  // What the approval is about, then what it still needs: two short lines under the card title.
  status: { display: 'grid', gap: '2px', marginTop: 0, marginBottom: '16px', paddingLeft: '20px', paddingRight: '20px', '@media (max-width: 600px)': { paddingLeft: '16px', paddingRight: '16px' } },
  statusLead: { fontWeight: 600 },
  statusNote: { color: h.muted, fontSize: '13px', lineHeight: '20px', maxWidth: '75ch' },
  person: { display: 'inline-flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  setAside: { color: h.muted },
  approvedMark: { display: 'inline-flex', alignItems: 'center', gap: '6px', color: h.spruceT, fontSize: '12.5px', fontWeight: 600 },
  customer: { fontWeight: 600 },
  failed: { color: h.emberT, fontWeight: 600 },
  subheading: {
    margin: 0,
    paddingTop: '16px',
    paddingBottom: '8px',
    paddingLeft: '20px',
    paddingRight: '20px',
    borderTop: `1px solid ${h.line}`,
    color: h.muted,
    fontSize: '12px',
    lineHeight: '16px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    '@media (max-width: 600px)': { paddingLeft: '16px', paddingRight: '16px' },
  },
});

/** One run: what was collected, what needs a look and the way to approval and export. */
export function BillingRunPage() {
  const styles = useStyles();
  const stat = useStatFitStyles();
  const catalog = useCatalogStyles();
  const flush = useFlushStyles();
  const { t, i18n } = useTranslation();
  const { id = '' } = useParams();
  const notify = useNotify();
  const canManage = useCan(Permissions.billingManage);
  const canReconcile = useCan(Permissions.billingReconcile);
  const navigate = useNavigate();
  const canApprove = useCan(Permissions.billingApprove);
  const canApproveSecond = useCan(Permissions.billingApproveSecond);
  const canSeeMoney = useCan(Permissions.financeRead);
  const me = useCurrentUser();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const anomaliesOnly = params.get('anomalies') === 'true';
  const { data: run, error, isPending, isFetching, refetch, dataUpdatedAt } = useRun(id);
  const settings = useBillingSettings();
  const bases = useBases(id, { anomaliesOnly, search: search.trim() });
  const actions = useRunActions(id);
  const [closing, setClosing] = useState(false);
  const restoreFocusTarget = useRestoreFocusTarget();

  if (isPending) return <Spinner label={t('common.loading')} />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  // A failed refresh keeps the run on screen: a long export must not turn into an error page because one poll failed.
  if (!run) return <ErrorState error={error} onRetry={() => void refetch()} />;

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

  const setFilter = (value: 'all' | 'anomalies') => {
    const next = new URLSearchParams(params);
    if (value === 'anomalies') next.set('anomalies', 'true');
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
              <Badge appearance="tint" color="informative">
                {t('billing.supplementary.badge')}
              </Badge>
            )}
            {run.notes && <Text className={styles.label}>{run.notes}</Text>}
          </>
        }
        actions={
          <>
            {canReconcile && (
              <Button icon={<ClipboardTaskListLtr20Regular />} onClick={() => navigate(`/billing/runs/${run.id}/pilot`)}>
                {t('pilot.open')}
              </Button>
            )}
            {canCollect && (
              <Button
                icon={<ArrowSyncCheckmark20Regular />}
                disabled={actions.collect.isPending || refreshing}
                onClick={() => void act(() => actions.collect.mutateAsync(run.etag), t('billing.collected'))}
              >
                {run.status === 'Draft' ? t('billing.collect') : t('billing.recollect')}
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
          </>
        }
      />

      {run.status === 'Exporting' && (
        <MessageBar intent="info" layout="multiline" role="status" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>
            <MessageBarTitle>{t('billing.exportProgress.title')}</MessageBarTitle>
            {t('billing.exportProgress.body', { exported: run.exported, failed: run.failed, total: run.organizations })}{' '}
            {t('billing.exportProgress.updated', { time: new Date(dataUpdatedAt).toLocaleTimeString(i18n.language, { timeZone: 'Europe/Oslo' }) })}
          </MessageBarBody>
          <MessageBarActions>
            <Button size="small" disabled={isFetching} onClick={() => void refetch()}>
              {t('billing.exportProgress.refresh')}
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}
      {error && (
        <MessageBar intent="warning" layout="multiline" role="status" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>
            {t('billing.refreshFailed', { time: new Date(dataUpdatedAt).toLocaleTimeString(i18n.language, { timeZone: 'Europe/Oslo' }), reason: errorMessage(error, t) })}
          </MessageBarBody>
          <MessageBarActions>
            <Button size="small" onClick={() => void refetch()}>
              {t('common.retry')}
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}
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

      <StatGrid className={stat.fit}>
        {canSeeMoney && <StatTile className={stat.money} icon={<Money16Regular />} tone="spruce" label={t('billing.fields.total')} value={formatMoney(run.totalExVat)} />}
        <StatTile icon={<Building16Regular />} tone="iris" label={t('billing.fields.customers')} value={formatNumber(run.organizations, 0)} />
        <StatTile
          icon={<Warning16Regular />}
          tone="saffron"
          label={t('billing.fields.anomalies')}
          value={run.withAnomalies}
          status={run.withAnomalies > 0 ? 'bad' : undefined}
        />
        {/* What failed belongs to what was sent: one tile, the failures in its note (and in the banner above). */}
        <StatTile icon={<Send16Regular />} label={t('billing.fields.exported')} value={run.exported}
          note={run.failed > 0 ? <span className={styles.failed}>{t('billing.failedCount', { count: run.failed })}</span> : undefined} />
      </StatGrid>

      {(run.approvals.length > 0 || awaitingApproval) && <ApprovalsPanel run={run} />}

      <Toolbar>
        <FilterField label={t('billing.searchCustomer')} kind="search">
          <SearchBox id="billing-search" value={search} onChange={(_, d) => setSearch(d.value)} placeholder={t('billing.searchCustomer')} />
        </FilterField>
        <FilterChips<'all' | 'anomalies'>
          label={t('billing.basesFilter')}
          value={anomaliesOnly ? 'anomalies' : 'all'}
          options={[
            { value: 'all', label: t('common.all'), count: run.organizations },
            { value: 'anomalies', label: t('billing.fields.anomalies'), count: run.withAnomalies, dot: h.saffron },
          ]}
          onChange={setFilter}
        />
      </Toolbar>

      {bases.error ? (
        <ErrorState error={bases.error} onRetry={() => void bases.refetch()} />
      ) : !bases.isPending && (bases.data ?? []).length === 0 ? (
        <div className={catalog.tableWrap}>
          <EmptyState icon={<BuildingMultiple24Regular />} message={t('billing.noBases')} />
        </div>
      ) : (
        <ScrollTable className={catalog.tableWrap}>
          <Table className={mergeClasses(catalog.table, flush.cells)} aria-label={t('billing.bases')}>
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
                    <AppLink to={`/billing/bases/${basis.id}`} className={styles.customer}>{basis.organization.name}</AppLink>
                  </TableCell>
                  <TableCell>
                    <BasisStatusBadge status={basis.status} />
                  </TableCell>
                  <TableCell className={catalog.number}>{basis.lines}</TableCell>
                  {canSeeMoney && (
                    <TableCell className={catalog.number}>
                      {formatMoney(basis.totalExVat)}
                      {(basis.previousPeriodTotal ?? 0) > 0 && (
                        <div className={styles.change}>{t('billing.previousPeriodShort', { amount: formatMoney(basis.previousPeriodTotal) })}</div>
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
                          .map((a) => anomalyText(t, a))
                          .join(' ')}
                        {basis.anomalies.length > 2 ? ` +${basis.anomalies.length - 2}` : ''}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {basis.orderNo ? (
                      <span>
                        <Badge appearance="tint" color="success">
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
        </ScrollTable>
      )}

      <Dialog open={closing} onOpenChange={(_, d) => !d.open && setClosing(false)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('billing.closeTitle')}</DialogTitle>
            <DialogContent>
              {t('billing.closeBody')}
              {/* Closing is final: customers this run never sent are named before it, not discovered after. */}
              {run.failed > 0 && <MessageBar intent="warning" style={{ marginTop: 12 }}><MessageBarBody>{t('billing.closeUnsent', { count: run.failed })}</MessageBarBody></MessageBar>}
            </DialogContent>
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
  const flush = useFlushStyles();
  const { t } = useTranslation();
  const current = run.approvals.filter((a) => a.valid);
  const setAside = run.approvals.filter((a) => !a.valid);
  const released = !['Draft', 'Collected', 'InReview'].includes(run.status);
  // Revision 0 is how runs approved before DEV-02 were sealed: nobody approved a digest of their content.
  const legacy = released && (run.approvedRevision === null || run.approvedRevision === 0);
  // Who approved in which role: the person, the role as a pill, the time under it.
  const person = (approval: Approval) => (
    <span className={styles.person}>
      {approval.approvedBy.name}
      <Badge appearance="tint" color={approval.kind === 'Second' ? 'important' : 'informative'}>{t(`billing.approvals.kind.${approval.kind}`)}</Badge>
    </span>
  );

  return (
    <div className={styles.approvals}>
      <Panel title={t('billing.approvals.title')} icon={<PersonAvailable16Regular />} flush className={flush.panel}>
        <p className={styles.status}>
          {legacy ? (
            <span className={styles.statusLead}>{t('billing.approvals.releasedLegacy')}</span>
          ) : released ? (
            <span className={styles.statusLead}>{t('billing.approvals.released', { revision: run.approvedRevision })}</span>
          ) : (
            <>
              <span className={styles.statusLead}>{t('billing.approvals.waiting', { revision: run.contentRevision })}</span>
              <span className={styles.statusNote}>{run.requiresSecondApproval ? t('billing.approvals.needsTwo') : t('billing.approvals.needsOne')}</span>
            </>
          )}
        </p>
        {current.length > 0 && (
          <ul className={flush.list}>
            {current.map((approval) => (
              <RecordRow
                key={`${approval.kind}-${approval.approvedAt}`}
                avatar={<Avatar name={approval.approvedBy.name} size={32} color="colorful" aria-hidden />}
                title={person(approval)}
                meta={<RowMeta>{t('billing.approvals.approvedAt', { date: formatDateTime(approval.approvedAt) })}</RowMeta>}
                end={<span className={styles.approvedMark}><CheckmarkCircle16Regular aria-hidden />{t('billing.approvals.approvedMark')}</span>}
              />
            ))}
          </ul>
        )}
        {setAside.length > 0 && (
          <>
            <h3 className={styles.subheading}>{t('billing.approvals.setAsideTitle')}</h3>
            <ul className={mergeClasses(flush.list, styles.setAside)}>
              {setAside.map((approval) => (
                <RecordRow
                  key={`${approval.kind}-${approval.approvedAt}-${approval.contentRevision}`}
                  avatar={<Avatar name={approval.approvedBy.name} size={32} color="colorful" aria-hidden />}
                  title={person(approval)}
                  meta={
                    <RowMeta>
                      {[
                        t('billing.approvals.revisionShort', { revision: approval.contentRevision }),
                        formatDateTime(approval.approvedAt),
                        approval.invalidationReason ? t(`billing.approvals.reasons.${approval.invalidationReason}`) : null,
                      ].filter(Boolean).join(' · ')}
                    </RowMeta>
                  }
                />
              ))}
            </ul>
          </>
        )}
      </Panel>
    </div>
  );
}
