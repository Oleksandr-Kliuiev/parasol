import { useState } from 'react';
import {
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
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatDateTime, formatNumber } from '../../shared/utils/format';
import { NotFoundPage } from '../errors/NotFoundPage';
import { ReasonDialog } from './ReasonDialog';
import { recordLabel } from './recordLabel';
import { type LegalHold, type Suppression, useHoldActions, useLegalHolds, usePrivacyCases, useRetention, useSuppressions } from './api';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  tableWrap: { overflowX: 'auto' },
  toolbar: { display: 'flex', justifyContent: 'flex-end', marginBottom: tokens.spacingVerticalS },
  warning: { color: tokens.colorPaletteDarkOrangeForeground1 },
  muted: { color: tokens.colorNeutralForeground3 },
  number: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
});

/**
 * Personal data (DEV-11, runbook 13): the requests of the people the CRM keeps data on, the legal holds that keep single
 * records through an erasure, the suppressions that keep erased people from coming back, and what retention would remove.
 */
export function PrivacyPage() {
  const styles = useStyles();
  const { t } = useTranslation();
  const allowed = useCan(Permissions.privacyManage);
  if (!allowed) return <NotFoundPage />;
  return (
    <>
      <PageHeader title={t('privacy.title')} subtitle={t('privacy.subtitle')} />
      <div className={styles.stack}>
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
  const { t } = useTranslation();
  const [includeClosed, setIncludeClosed] = useState(false);
  const { data, error, isPending, refetch } = usePrivacyCases(includeClosed);
  return (
    <Panel title={t('privacy.cases.title')}>
      <div className={styles.toolbar}>
        <Switch label={t('privacy.cases.showClosed')} checked={includeClosed} onChange={(_, d) => setIncludeClosed(d.checked)} />
      </div>
      {isPending ? (
        <Spinner label={t('common.loading')} />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data.length === 0 ? (
        <EmptyState message={t('privacy.cases.empty')} />
      ) : (
        <div className={styles.tableWrap}>
          <Table size="small" aria-label={t('privacy.cases.tableLabel')}>
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
                    <AppLink to={`/admin/privacy/cases/${c.id}`}>{c.number}</AppLink>
                  </TableCell>
                  <TableCell>{t(`privacy.kinds.${c.kind}`)}</TableCell>
                  <TableCell>{t(`privacy.subjects.${c.subjectKind}`)}</TableCell>
                  <TableCell>{t(`privacy.statuses.${c.status}`)}</TableCell>
                  <TableCell className="tabular">{formatDate(c.receivedAt)}</TableCell>
                  <TableCell className="tabular">
                    {formatDate(c.dueOn)}
                    {c.overdue && <Text className={styles.warning}> · {t('privacy.cases.overdue')}</Text>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Panel>
  );
}

function HoldsPanel() {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const [includeEnded, setIncludeEnded] = useState(false);
  const [releasing, setReleasing] = useState<LegalHold | null>(null);
  const { data, error, isPending, refetch } = useLegalHolds(includeEnded);
  const actions = useHoldActions();
  return (
    <Panel title={t('privacy.holds.title')}>
      <div className={styles.toolbar}>
        <Switch label={t('privacy.holds.showEnded')} checked={includeEnded} onChange={(_, d) => setIncludeEnded(d.checked)} />
      </div>
      {isPending ? (
        <Spinner label={t('common.loading')} />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data.length === 0 ? (
        <EmptyState message={t('privacy.holds.empty')} />
      ) : (
        <div className={styles.tableWrap}>
          <Table size="small" aria-label={t('privacy.holds.tableLabel')}>
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
              {data.map((h) => (
                <TableRow key={h.id}>
                  <TableCell>{recordLabel(t, h.module, h.entityType, h.entityId)}</TableCell>
                  <TableCell>{t(`privacy.holds.reasons.${h.reason}`)}</TableCell>
                  <TableCell>{h.explanation}</TableCell>
                  <TableCell className="tabular">
                    {formatDate(h.until)}
                    {!h.active && <Text className={styles.muted}> · {h.releasedAt ? t('privacy.holds.released') : t('privacy.holds.ended')}</Text>}
                  </TableCell>
                  <TableCell>
                    {h.active && (
                      <Button size="small" onClick={() => setReleasing(h)} aria-label={t('privacy.holds.releaseNamed', { record: recordLabel(t, h.module, h.entityType, h.entityId) })}>
                        {t('privacy.holds.release')}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
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
  const { t } = useTranslation();
  const notify = useNotify();
  const [lifting, setLifting] = useState<Suppression | null>(null);
  const { data, error, isPending, refetch } = useSuppressions();
  const actions = useHoldActions();
  return (
    <Panel title={t('privacy.suppressions.title')}>
      {isPending ? (
        <Spinner label={t('common.loading')} />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data.length === 0 ? (
        <EmptyState message={t('privacy.suppressions.empty')} />
      ) : (
        <div className={styles.tableWrap}>
          <Table size="small" aria-label={t('privacy.suppressions.tableLabel')}>
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
                  <TableCell>{s.caseNumber ? <AppLink to={`/admin/privacy/cases/${s.caseId}`}>{s.caseNumber}</AppLink> : '—'}</TableCell>
                  <TableCell className="tabular">
                    {formatDate(s.createdAt)}
                    {s.liftedAt && <Text className={styles.muted}> · {t('privacy.suppressions.lifted', { date: formatDate(s.liftedAt) })}</Text>}
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
        </div>
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
  const { t } = useTranslation();
  const { data, error, isPending, refetch } = useRetention();
  if (isPending) return <Panel title={t('privacy.retention.title')}><Spinner label={t('common.loading')} /></Panel>;
  if (error) return <Panel title={t('privacy.retention.title')}><ErrorState error={error} onRetry={() => void refetch()} /></Panel>;
  return (
    <Panel title={t('privacy.retention.title')}>
      <MessageBar intent={data.mode === 'Apply' ? 'warning' : 'info'} style={{ marginBottom: tokens.spacingVerticalM }}>
        <MessageBarBody>{t(`privacy.retention.mode.${data.mode}`)}</MessageBarBody>
      </MessageBar>
      {data.lastRun === null ? (
        <EmptyState message={t('privacy.retention.never')} />
      ) : (
        <>
          <Text className={styles.muted}>{t('privacy.retention.lastRun', { at: formatDateTime(data.lastRun.startedAt) })}</Text>
          <div className={styles.tableWrap}>
            <Table size="small" aria-label={t('privacy.retention.tableLabel')}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{t('privacy.retention.class')}</TableHeaderCell>
                  <TableHeaderCell>{t('privacy.retention.period')}</TableHeaderCell>
                  <TableHeaderCell className={styles.number}>{t('privacy.retention.due')}</TableHeaderCell>
                  <TableHeaderCell className={styles.number}>{t('privacy.retention.removed')}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.lastRun.classes.map((c) => (
                  <TableRow key={c.dataClass}>
                    <TableCell>
                      {t(`privacy.retention.classes.${c.dataClass}`, { defaultValue: c.dataClass })}
                      {c.error && <div className={styles.warning}>{t('privacy.retention.error', { error: c.error })}</div>}
                    </TableCell>
                    <TableCell>
                      {c.days === null ? '—' : t('privacy.retention.days', { count: c.days })}
                      <div className={styles.muted}>{c.approved ? t('privacy.retention.approved', { reference: c.reference }) : t('privacy.retention.proposal')}</div>
                    </TableCell>
                    <TableCell className={styles.number}>{formatNumber(c.due, 0)}</TableCell>
                    <TableCell className={styles.number}>{formatNumber(c.removed, 0)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </Panel>
  );
}
