import { useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
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
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { DetailList, Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDateTime } from '../../shared/utils/format';
import {
  useMaintenanceStatus,
  useReconcile,
  useRestoreReport,
  useRestoreReports,
  useSetMaintenance,
  type MaintenanceMode,
  type MaintenanceStatus,
  type RestoreLine,
  type RestoreReport,
} from './api';
import { ScrollTable } from '../../shared/components/ScrollTable';

const MIN_REASON = 10;
const MAX_REASON = 500;

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, maxWidth: '640px' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, alignItems: 'center' },
  readOnly: { color: tokens.colorPaletteDarkOrangeForeground1, fontWeight: tokens.fontWeightSemibold },
  needsPerson: { color: tokens.colorPaletteDarkOrangeForeground1, fontWeight: tokens.fontWeightSemibold },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  tableWrap: { overflowX: 'auto' },
  table: { minWidth: '640px' },
  number: { textAlign: 'end', fontVariantNumeric: 'tabular-nums' },
  nowrap: { whiteSpace: 'nowrap' },
  section: { marginTop: tokens.spacingVerticalL },
});

/**
 * The operator's page of DEV-13 (ADR-021, runbook 03): the maintenance switch, what is still under way, and the restore
 * reconciliation with its reports. Behind operations.maintenance; it keeps working while the CRM is read-only.
 */
export function MaintenancePage() {
  const styles = useStyles();
  const { t } = useTranslation();
  const status = useMaintenanceStatus();
  const [reportId, setReportId] = useState<string | null>(null);

  return (
    <>
      <PageHeader title={t('maintenance.title')} subtitle={t('maintenance.subtitle')} />
      {status.error && <ErrorState error={status.error} onRetry={() => void status.refetch()} />}
      {status.data && (
        <div className={styles.stack}>
          <StatePanel status={status.data} />
          <SwitchPanel status={status.data} />
          <ReconcilePanel readOnly={status.data.mode === 'ReadOnly'} />
          <ReportsPanel selected={reportId} onSelect={setReportId} />
        </div>
      )}
    </>
  );
}

function StatePanel({ status }: { status: MaintenanceStatus }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const underWay = status.inFlight.reduce((sum, c) => sum + c.count, 0);

  return (
    <Panel title={t('maintenance.state.title')}>
      {status.forced && (
        <MessageBar intent="warning" style={{ marginBottom: 12 }}>
          <MessageBarBody>{t('maintenance.state.forced')}</MessageBarBody>
        </MessageBar>
      )}
      <DetailList
        items={[
          {
            label: t('maintenance.state.mode'),
            value: <span className={status.mode === 'ReadOnly' ? styles.readOnly : undefined}>{t(`maintenance.state.modes.${status.mode}`)}</span>,
          },
          { label: t('maintenance.state.since'), value: formatDateTime(status.since) },
          { label: t('maintenance.state.setBy'), value: status.setBy },
          { label: t('maintenance.state.reason'), value: status.reason },
          { label: t('maintenance.state.reference'), value: status.reference },
        ]}
      />
      <h3 className={styles.section}>{t('maintenance.inFlight.title')}</h3>
      <Text block className={styles.muted}>
        {t('maintenance.inFlight.hint')}
      </Text>
      {underWay === 0 ? (
        <Text block>{t('maintenance.inFlight.clear')}</Text>
      ) : (
        <Table size="small" aria-label={t('maintenance.inFlight.title')} style={{ maxWidth: 480 }}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>{t('maintenance.inFlight.area')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('maintenance.inFlight.count')}</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {status.inFlight.map((c) => (
              <TableRow key={c.area}>
                <TableCell>{t(`maintenance.areas.${c.area}`, { defaultValue: c.area })}</TableCell>
                <TableCell className={styles.number}>{c.count}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

function SwitchPanel({ status }: { status: MaintenanceStatus }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const setMaintenance = useSetMaintenance();
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [confirming, setConfirming] = useState(false);
  const target: MaintenanceMode = status.mode === 'ReadOnly' ? 'Normal' : 'ReadOnly';
  const valid = reason.trim().length >= MIN_REASON && reason.trim().length <= MAX_REASON;

  const submit = async () => {
    try {
      await setMaintenance.mutateAsync({ mode: target, reason: reason.trim(), reference: reference.trim() || null, expectedKey: status.key });
      notify(t('maintenance.switch.done'));
      setReason('');
      setReference('');
    } catch {
      // Shown below; the state reloads so the operator sees the decision that stands.
    }
    setConfirming(false);
  };

  return (
    <Panel title={t('maintenance.switch.title')}>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) setConfirming(true);
        }}
      >
        {setMaintenance.error && (
          <MessageBar intent="error">
            <MessageBarBody>{errorMessage(setMaintenance.error, t)}</MessageBarBody>
          </MessageBar>
        )}
        <Field label={t('maintenance.switch.reason')} hint={t('maintenance.switch.reasonHint', { min: MIN_REASON, max: MAX_REASON })} required>
          <Textarea value={reason} maxLength={MAX_REASON} onChange={(_, d) => setReason(d.value)} disabled={status.forced} />
        </Field>
        <Field label={t('maintenance.switch.reference')} hint={t('maintenance.switch.referenceHint')}>
          <Input value={reference} maxLength={100} onChange={(_, d) => setReference(d.value)} disabled={status.forced} />
        </Field>
        <div className={styles.actions}>
          <Button appearance="primary" type="submit" disabled={!valid || status.forced || setMaintenance.isPending}>
            {target === 'ReadOnly' ? t('maintenance.switch.toReadOnly') : t('maintenance.switch.toNormal')}
          </Button>
        </div>
      </form>
      <Dialog open={confirming} onOpenChange={(_, d) => !d.open && setConfirming(false)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{target === 'ReadOnly' ? t('maintenance.switch.confirmReadOnlyTitle') : t('maintenance.switch.confirmNormalTitle')}</DialogTitle>
            <DialogContent>{target === 'ReadOnly' ? t('maintenance.switch.confirmReadOnlyBody') : t('maintenance.switch.confirmNormalBody')}</DialogContent>
            <DialogActions>
              <Button onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
              <Button appearance="primary" disabled={setMaintenance.isPending} onClick={() => void submit()}>
                {t('maintenance.switch.confirm')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </Panel>
  );
}

/** "2026-10-04T06:30" or with seconds, as a datetime-local input gives it, read as UTC; null when empty or invalid. */
function utcInstant(value: string): string | null {
  if (!value) return null;
  const instant = new Date(`${value.length === 16 ? `${value}:00` : value}Z`);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

function ReconcilePanel({ readOnly }: { readOnly: boolean }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const reconcile = useReconcile();
  const [point, setPoint] = useState('');
  const [future, setFuture] = useState(false);
  const [report, setReport] = useState<RestoreReport | null>(null);
  const [confirming, setConfirming] = useState(false);
  const restorePoint = utcInstant(point);
  const inPast = restorePoint !== null && !future;
  const previewed = report !== null && !report.applied && restorePoint !== null && new Date(report.restorePoint).getTime() === new Date(restorePoint).getTime();

  const run = async (apply: boolean) => {
    if (!restorePoint) return;
    try {
      setReport(await reconcile.mutateAsync({ restorePoint, apply }));
    } catch {
      // Shown below.
    }
    setConfirming(false);
  };

  return (
    <Panel title={t('maintenance.reconcile.title')}>
      <div className={styles.form}>
        <Text block>{t('maintenance.reconcile.intro')}</Text>
        {!readOnly && (
          <MessageBar intent="info">
            <MessageBarBody>{t('maintenance.reconcile.needsReadOnly')}</MessageBarBody>
          </MessageBar>
        )}
        <Field
          label={t('maintenance.reconcile.restorePoint')}
          hint={t('maintenance.reconcile.restorePointHint')}
          validationMessage={point && !inPast ? t('maintenance.reconcile.invalidPoint') : undefined}
        >
          <Input
            type="datetime-local"
            step={1}
            value={point}
            onChange={(_, d) => {
              const instant = utcInstant(d.value);
              setPoint(d.value);
              setFuture(instant !== null && new Date(instant).getTime() > Date.now());
            }}
          />
        </Field>
        {reconcile.error && (
          <MessageBar intent="error">
            <MessageBarBody>{errorMessage(reconcile.error, t)}</MessageBarBody>
          </MessageBar>
        )}
        <div className={styles.actions}>
          <Button disabled={!readOnly || !inPast || reconcile.isPending} onClick={() => void run(false)}>
            {t('maintenance.reconcile.dryRun')}
          </Button>
          <Button appearance="primary" disabled={!readOnly || !previewed || reconcile.isPending} onClick={() => setConfirming(true)}>
            {t('maintenance.reconcile.apply')}
          </Button>
          <Text className={styles.muted}>{t('maintenance.reconcile.applyHint')}</Text>
        </div>
      </div>
      {report && <ReportView report={report} />}
      <Dialog open={confirming} onOpenChange={(_, d) => !d.open && setConfirming(false)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('maintenance.reconcile.confirmTitle')}</DialogTitle>
            <DialogContent>{t('maintenance.reconcile.confirmBody')}</DialogContent>
            <DialogActions>
              <Button onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
              <Button appearance="primary" disabled={reconcile.isPending} onClick={() => void run(true)}>
                {t('maintenance.reconcile.apply')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </Panel>
  );
}

function ReportView({ report }: { report: RestoreReport }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const needsPerson = report.checks.concat(report.reconciliation).filter((l) => l.needsPerson).length;

  return (
    <section className={styles.section} aria-label={t('maintenance.report.title', { at: formatDateTime(report.at) })}>
      <h3>{t('maintenance.report.title', { at: formatDateTime(report.at) })}</h3>
      <DetailList
        items={[
          { label: t('maintenance.report.kind'), value: report.applied ? t('maintenance.report.applied') : t('maintenance.report.dryRun') },
          { label: t('maintenance.report.restorePoint'), value: formatDateTime(report.restorePoint) },
          { label: t('maintenance.report.by'), value: report.by },
          { label: t('maintenance.report.effects'), value: String(report.effects) },
          { label: t('maintenance.report.needsPerson'), value: <span className={needsPerson > 0 ? styles.needsPerson : undefined}>{needsPerson}</span> },
        ]}
      />
      <h4>{t('maintenance.report.reconciliation')}</h4>
      {report.reconciliation.length === 0 ? <EmptyState message={t('maintenance.report.nothing')} /> : <Lines lines={report.reconciliation} />}
      <h4>{t('maintenance.report.checks')}</h4>
      <Lines lines={report.checks} />
    </section>
  );
}

function Lines({ lines }: { lines: RestoreLine[] }) {
  const styles = useStyles();
  const { t } = useTranslation();
  return (
    <ScrollTable className={styles.tableWrap}>
      <Table size="small" className={styles.table}>
        <TableHeader>
          <TableRow>
            <TableHeaderCell>{t('maintenance.report.area')}</TableHeaderCell>
            <TableHeaderCell>{t('maintenance.report.subject')}</TableHeaderCell>
            <TableHeaderCell>{t('maintenance.report.finding')}</TableHeaderCell>
            <TableHeaderCell>{t('maintenance.report.action')}</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((line, index) => (
            <TableRow key={`${line.area}-${line.subject}-${index}`}>
              <TableCell className={styles.nowrap}>{t(`maintenance.areas.${line.area}`, { defaultValue: line.area })}</TableCell>
              <TableCell>{line.subject}</TableCell>
              <TableCell>
                {line.needsPerson && <span className={styles.needsPerson}>{t('maintenance.report.needsPersonMark')} </span>}
                {line.finding}
              </TableCell>
              <TableCell className={styles.muted}>{line.action ?? '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ScrollTable>
  );
}

function ReportsPanel({ selected, onSelect }: { selected: string | null; onSelect: (id: string | null) => void }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const reports = useRestoreReports();
  const report = useRestoreReport(selected);

  return (
    <Panel title={t('maintenance.reports.title')}>
      {reports.error && <ErrorState error={reports.error} onRetry={() => void reports.refetch()} />}
      {reports.data && reports.data.length === 0 && <EmptyState message={t('maintenance.reports.empty')} />}
      {reports.data && reports.data.length > 0 && (
        <ScrollTable className={styles.tableWrap}>
          <Table size="small" className={styles.table} aria-label={t('maintenance.reports.title')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('maintenance.reports.at')}</TableHeaderCell>
                <TableHeaderCell>{t('maintenance.reports.restorePoint')}</TableHeaderCell>
                <TableHeaderCell>{t('maintenance.reports.kind')}</TableHeaderCell>
                <TableHeaderCell>{t('maintenance.reports.by')}</TableHeaderCell>
                <TableHeaderCell className={styles.number}>{t('maintenance.reports.effects')}</TableHeaderCell>
                <TableHeaderCell className={styles.number}>{t('maintenance.reports.needsPerson')}</TableHeaderCell>
                <TableHeaderCell aria-label={t('maintenance.reports.open')} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.data.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className={styles.nowrap}>{formatDateTime(r.at)}</TableCell>
                  <TableCell className={styles.nowrap}>{formatDateTime(r.restorePoint)}</TableCell>
                  <TableCell>{r.applied ? t('maintenance.report.applied') : t('maintenance.report.dryRun')}</TableCell>
                  <TableCell>{r.by}</TableCell>
                  <TableCell className={styles.number}>{r.effects}</TableCell>
                  <TableCell className={styles.number}>
                    <span className={r.needsPerson > 0 ? styles.needsPerson : undefined}>{r.needsPerson}</span>
                  </TableCell>
                  <TableCell>
                    <Button size="small" onClick={() => onSelect(selected === r.id ? null : r.id)}>
                      {selected === r.id ? t('maintenance.reports.hide') : t('maintenance.reports.open')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollTable>
      )}
      {report.error && <ErrorState error={report.error} />}
      {report.data && <ReportView report={report.data} />}
    </Panel>
  );
}
