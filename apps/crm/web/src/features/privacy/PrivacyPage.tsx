import { useState } from 'react';
import {
  Badge,
  Button,
  MessageBar,
  MessageBarBody,
  Spinner,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { Gavel16Regular, Gavel24Regular, PersonInfo16Regular, PersonInfo24Regular, PersonProhibited16Regular, PersonProhibited24Regular, Timer16Regular, Timer24Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { ListFooter } from '../../shared/components/ListFooter';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatDateTime, formatNumber } from '../../shared/utils/format';
import { ForbiddenPage } from '../errors/ForbiddenPage';
import { ReasonDialog } from './ReasonDialog';
import { recordLabel } from './recordLabel';
import { type LegalHold, type Suppression, useHoldActions, useLegalHolds, usePrivacyCases, useRetention, useSuppressions } from './api';
import { ScrollTable } from '../../shared/components/ScrollTable';
import { useSettingsStyles } from '../admin/settingsUi';
import { useTableCardStyles } from '../admin/tableCard';
import { CaseStatusBadge, OverdueBadge } from './privacyUi';

const useStyles = makeStyles({
  header: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
  warning: { color: h.emberT, fontSize: '13px' },
  muted: { color: h.muted, fontSize: '13px' },
  number: { textAlign: 'right', fontVariantNumeric: 'tabular-nums', '& .fui-TableHeaderCell__button': { justifyContent: 'flex-end' } },
  link: { fontWeight: tokens.fontWeightSemibold, whiteSpace: 'nowrap' },
  date: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', fontVariantNumeric: 'tabular-nums' },
  // Fluent tables share the width equally between columns, so each table keeps room for its widest cells and scrolls on a phone.
  table: { minWidth: '760px' },
  smallTable: { minWidth: '560px' },
  // Retention: the two counts get a fixed width, so the data class and its period share the rest of the row; at 640 px
  // a period's note ("Proposal, not approved") keeps to one line.
  retentionTable: { minWidth: '640px' },
  countCol: { width: '112px' },
  // A data class the interface has no name for falls back to its code, which breaks inside its column rather than run
  // into the period next to it.
  dataClass: { overflowWrap: 'break-word' },
  explanation: { color: h.muted, fontSize: '13px', overflowWrap: 'anywhere', minWidth: '180px' },
  mode: { marginBottom: '12px' },
});

/** The count of a list in the card header, as the reference does next to "Open files". */
function CountPill({ count }: { count: number | null | undefined }) {
  if (count == null) return null;
  return <Badge appearance="outline" color="subtle">{count}</Badge>;
}

/**
 * Personal data (DEV-11, runbook 13): the requests of the people the CRM keeps data on, the legal holds that keep single
 * records through an erasure, the suppressions that keep erased people from coming back, and what retention would remove.
 */
export function PrivacyPage() {
  const settings = useSettingsStyles();
  const { t } = useTranslation();
  const allowed = useCan(Permissions.privacyManage);
  if (!allowed) return <ForbiddenPage />;
  return (
    <>
      <PageHeader title={t('privacy.title')} subtitle={t('privacy.subtitle')} />
      <div className={settings.stack}>
        <CasesPanel />
        <HoldsPanel />
        <SuppressionsPanel />
        <RetentionPanel />
      </div>
    </>
  );
}

function CasesPanel() {
  const styles = useStyles();
  const table = useTableCardStyles();
  const { t } = useTranslation();
  const [includeClosed, setIncludeClosed] = useState(false);
  const cases = usePrivacyCases(includeClosed);
  const { items: data, error, isPending, refetch } = cases;
  return (
    <Panel
      title={t('privacy.cases.title')}
      icon={<PersonInfo16Regular />}
      actions={
        <span className={styles.header}>
          {!isPending && !error && <CountPill count={cases.total} />}
          <Switch label={t('privacy.cases.showClosed')} checked={includeClosed} onChange={(_, d) => setIncludeClosed(d.checked)} />
        </span>
      }
    >
      {isPending ? (
        <Spinner label={t('common.loading')} />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data.length === 0 ? (
        <EmptyState message={t('privacy.cases.empty')} icon={<PersonInfo24Regular />} />
      ) : (
        <ScrollTable className={table.inset}>
          <Table className={styles.table} aria-label={t('privacy.cases.tableLabel')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('privacy.cases.columns.number')}</TableHeaderCell>
                <TableHeaderCell>{t('privacy.cases.columns.kind')}</TableHeaderCell>
                <TableHeaderCell>{t('privacy.cases.columns.subject')}</TableHeaderCell>
                <TableHeaderCell>{t('privacy.cases.columns.status')}</TableHeaderCell>
                <TableHeaderCell>{t('privacy.cases.columns.received')}</TableHeaderCell>
                <TableHeaderCell>{t('privacy.cases.columns.due')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <AppLink to={`/admin/privacy/cases/${c.id}`} className={styles.link}>{c.number}</AppLink>
                  </TableCell>
                  <TableCell>{t(`privacy.kinds.${c.kind}`)}</TableCell>
                  <TableCell>{t(`privacy.subjects.${c.subjectKind}`)}</TableCell>
                  <TableCell><CaseStatusBadge status={c.status} /></TableCell>
                  <TableCell className="tabular">{formatDate(c.receivedAt)}</TableCell>
                  <TableCell>
                    <span className={styles.date}>
                      {formatDate(c.dueOn)}
                      {c.overdue && <OverdueBadge />}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <ListFooter shown={data.length} total={cases.total} hasMore={cases.hasNextPage} loading={cases.isFetchingNextPage} onMore={() => void cases.fetchNextPage()} />
        </ScrollTable>
      )}
    </Panel>
  );
}

function HoldsPanel() {
  const styles = useStyles();
  const table = useTableCardStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const [includeEnded, setIncludeEnded] = useState(false);
  const [releasing, setReleasing] = useState<LegalHold | null>(null);
  const holds = useLegalHolds(includeEnded);
  const { items: data, error, isPending, refetch } = holds;
  const actions = useHoldActions();
  return (
    <Panel
      title={t('privacy.holds.title')}
      icon={<Gavel16Regular />}
      actions={
        <span className={styles.header}>
          {!isPending && !error && <CountPill count={holds.total} />}
          <Switch label={t('privacy.holds.showEnded')} checked={includeEnded} onChange={(_, d) => setIncludeEnded(d.checked)} />
        </span>
      }
    >
      {isPending ? (
        <Spinner label={t('common.loading')} />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data.length === 0 ? (
        <EmptyState message={t('privacy.holds.empty')} icon={<Gavel24Regular />} />
      ) : (
        <ScrollTable className={table.inset}>
          <Table className={styles.table} aria-label={t('privacy.holds.tableLabel')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('privacy.holds.record')}</TableHeaderCell>
                <TableHeaderCell>{t('privacy.holds.reason')}</TableHeaderCell>
                <TableHeaderCell>{t('privacy.holds.explanation')}</TableHeaderCell>
                <TableHeaderCell>{t('privacy.holds.until')}</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((hold) => (
                <TableRow key={hold.id}>
                  <TableCell>{recordLabel(t, hold.module, hold.entityType, hold.entityId)}</TableCell>
                  <TableCell>{t(`privacy.holds.reasons.${hold.reason}`)}</TableCell>
                  <TableCell className={styles.explanation}>{hold.explanation}</TableCell>
                  <TableCell>
                    <span className={styles.date}>
                      {formatDate(hold.until)}
                      {!hold.active && (
                        <Badge appearance="tint" color="subtle">
                          {hold.releasedAt ? t('privacy.holds.released') : t('privacy.holds.ended')}
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    {hold.active && (
                      <Button size="small" onClick={() => setReleasing(hold)} aria-label={t('privacy.holds.releaseNamed', { record: recordLabel(t, hold.module, hold.entityType, hold.entityId) })}>
                        {t('privacy.holds.release')}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <ListFooter shown={data.length} total={holds.total} hasMore={holds.hasNextPage} loading={holds.isFetchingNextPage} onMore={() => void holds.fetchNextPage()} />
        </ScrollTable>
      )}
      <ReasonDialog
        open={releasing !== null}
        title={t('privacy.holds.releaseTitle')}
        submit={t('privacy.holds.release')}
        pending={actions.release.isPending}
        onClose={() => setReleasing(null)}
        onSubmit={(reason) =>
          releasing &&
          actions.release.mutate(
            { hold: releasing, reason },
            {
              onSuccess: () => setReleasing(null),
              onError: (e) => notify(t('errors.generic'), 'error', errorMessage(e, t)),
            },
          )
        }
      />
    </Panel>
  );
}

function SuppressionsPanel() {
  const styles = useStyles();
  const table = useTableCardStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const [lifting, setLifting] = useState<Suppression | null>(null);
  const suppressions = useSuppressions();
  const { items: data, error, isPending, refetch } = suppressions;
  const actions = useHoldActions();
  return (
    <Panel
      title={t('privacy.suppressions.title')}
      icon={<PersonProhibited16Regular />}
      actions={!isPending && !error ? <CountPill count={suppressions.total} /> : undefined}
    >
      {isPending ? (
        <Spinner label={t('common.loading')} />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data.length === 0 ? (
        <EmptyState message={t('privacy.suppressions.empty')} icon={<PersonProhibited24Regular />} />
      ) : (
        <ScrollTable className={table.inset}>
          <Table className={styles.smallTable} aria-label={t('privacy.suppressions.tableLabel')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('privacy.suppressions.kind')}</TableHeaderCell>
                <TableHeaderCell>{t('privacy.suppressions.case')}</TableHeaderCell>
                <TableHeaderCell>{t('privacy.suppressions.created')}</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>{t(`privacy.suppressions.kinds.${s.kind}`)}</TableCell>
                  <TableCell>{s.caseNumber ? <AppLink to={`/admin/privacy/cases/${s.caseId}`} className={styles.link}>{s.caseNumber}</AppLink> : '—'}</TableCell>
                  <TableCell>
                    <span className={styles.date}>
                      {formatDate(s.createdAt)}
                      {s.liftedAt && (
                        <Badge appearance="tint" color="subtle">
                          {t('privacy.suppressions.lifted', { date: formatDate(s.liftedAt) })}
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    {!s.liftedAt && (
                      <Button size="small" onClick={() => setLifting(s)}>
                        {t('privacy.suppressions.lift')}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <ListFooter shown={data.length} total={suppressions.total} hasMore={suppressions.hasNextPage} loading={suppressions.isFetchingNextPage} onMore={() => void suppressions.fetchNextPage()} />
        </ScrollTable>
      )}
      <ReasonDialog
        open={lifting !== null}
        title={t('privacy.suppressions.liftTitle')}
        hint={t('privacy.suppressions.liftHint')}
        submit={t('privacy.suppressions.lift')}
        pending={actions.lift.isPending}
        onClose={() => setLifting(null)}
        onSubmit={(reason) =>
          lifting &&
          actions.lift.mutate(
            { suppression: lifting, reason },
            {
              onSuccess: () => setLifting(null),
              onError: (e) => notify(t('errors.generic'), 'error', errorMessage(e, t)),
            },
          )
        }
      />
    </Panel>
  );
}

function RetentionPanel() {
  const styles = useStyles();
  const table = useTableCardStyles();
  const settings = useSettingsStyles();
  const { t } = useTranslation();
  const { data, error, isPending, refetch } = useRetention();
  const icon = <Timer16Regular />;
  if (isPending) return <Panel title={t('privacy.retention.title')} icon={icon}><Spinner label={t('common.loading')} /></Panel>;
  if (error) return <Panel title={t('privacy.retention.title')} icon={icon}><ErrorState error={error} onRetry={() => void refetch()} /></Panel>;
  return (
    <Panel title={t('privacy.retention.title')} icon={icon}>
      <MessageBar intent={data.mode === 'Apply' ? 'warning' : 'info'} className={styles.mode}>
        <MessageBarBody>{t(`privacy.retention.mode.${data.mode}`)}</MessageBarBody>
      </MessageBar>
      {data.lastRun === null ? (
        <EmptyState message={t('privacy.retention.never')} icon={<Timer24Regular />} />
      ) : (
        <>
          <p className={mergeClasses(settings.note, styles.mode)}>{t('privacy.retention.lastRun', { at: formatDateTime(data.lastRun.startedAt) })}</p>
          <ScrollTable className={table.inset}>
            <Table className={mergeClasses(styles.retentionTable, table.roomy)} aria-label={t('privacy.retention.tableLabel')}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{t('privacy.retention.class')}</TableHeaderCell>
                  <TableHeaderCell>{t('privacy.retention.period')}</TableHeaderCell>
                  <TableHeaderCell className={mergeClasses(styles.number, styles.countCol)}>{t('privacy.retention.due')}</TableHeaderCell>
                  <TableHeaderCell className={mergeClasses(styles.number, styles.countCol)}>{t('privacy.retention.removed')}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.lastRun.classes.map((c) => (
                  <TableRow key={c.dataClass}>
                    <TableCell className={styles.dataClass}>
                      {t(`privacy.retention.classes.${c.dataClass}`, { defaultValue: c.dataClass })}
                      {c.error && <div className={styles.warning}>{t('privacy.retention.error', { error: c.error })}</div>}
                    </TableCell>
                    {/* A class with neither an approved nor a proposed period is not counted: no proposal, and no zero. */}
                    <TableCell>
                      {c.days === null ? t('privacy.retention.noPeriod') : t('privacy.retention.days', { count: c.days })}
                      <div className={styles.muted}>
                        {c.approved
                          ? t('privacy.retention.approved', { reference: c.reference })
                          : c.days === null
                            ? t('privacy.retention.noProposal')
                            : t('privacy.retention.proposal')}
                      </div>
                    </TableCell>
                    <TableCell className={styles.number}>
                      {c.days === null ? <span className={styles.muted}>{t('privacy.retention.notCounted')}</span> : formatNumber(c.due, 0)}
                    </TableCell>
                    <TableCell className={styles.number}>{formatNumber(c.removed, 0)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollTable>
        </>
      )}
    </Panel>
  );
}
