import { useState } from 'react';
import {
  Badge,
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
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Textarea,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import { ArrowSync16Regular, CheckmarkCircle16Regular, CheckmarkCircle24Regular, Gauge16Regular, History16Regular, History24Regular, Info16Regular, LockClosed16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { DetailList, FactGrid, Panel } from '../../shared/components/Panel';
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
import { PersonCell, useSettingsStyles } from '../admin/settingsUi';
import { useTableCardStyles } from '../admin/tableCard';

const MIN_REASON = 10;
const MAX_REASON = 500;

const useStyles = makeStyles({
  // The state and the switch side by side on a wide screen; reconciliation and its reports below at full width.
  top: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))',
    gap: '16px',
    alignItems: 'start',
    minWidth: 0,
  },
  form: { display: 'flex', flexDirection: 'column', gap: '16px', minWidth: 0 },
  // The fields of a card's form: up to three columns on a wide card, one on a phone.
  fields: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))', columnGap: '16px', rowGap: '14px', minWidth: 0 },
  // The one explaining line under a card title.
  lead: { margin: '-6px 0 0', color: h.muted, fontSize: '13px', lineHeight: '20px', maxWidth: '75ch' },
  // The foot of a form: why its button cannot be used yet on the left, the buttons in the order of the work on the right.
  footer: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: '16px',
    rowGap: '12px',
    paddingTop: '16px',
    borderTop: `1px solid ${h.line}`,
  },
  reason: { display: 'flex', alignItems: 'flex-start', gap: '8px', flex: '1 1 240px', minWidth: 0, margin: 0, color: h.muted, fontSize: '13px', lineHeight: '20px', maxWidth: '75ch' },
  reasonIcon: { display: 'inline-flex', flexShrink: 0, marginTop: '2px', color: h.faint, '& svg': { width: '16px', height: '16px' } },
  ready: { color: h.spruceT },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '10px',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginLeft: 'auto',
    '@media (max-width: 560px)': { width: '100%', '& > .fui-Button': { flex: '1 1 0' } },
  },
  needsPerson: { color: h.saffronT, fontWeight: tokens.fontWeightSemibold },
  table: { minWidth: '640px' },
  reportsTable: { minWidth: '900px' },
  // The header's sort button is a flex box, so its label is pushed to the end like the numbers below it.
  number: { textAlign: 'end', fontVariantNumeric: 'tabular-nums', '& .fui-TableHeaderCell__button': { justifyContent: 'flex-end' } },
  nowrap: { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
  muted: { color: h.muted, fontSize: '13px' },
  // A titled part inside a card: display type, a hairline above it.
  part: { display: 'grid', gap: '8px', marginTop: '20px', paddingTop: '16px', borderTop: `1px solid ${h.line}`, minWidth: 0 },
  subhead: { margin: 0, fontFamily: h.display, fontSize: '15px', lineHeight: '20px', fontWeight: 600, letterSpacing: '-0.01em' },
  minor: { margin: 0, marginTop: '8px', fontSize: '13px', lineHeight: '18px', fontWeight: 600, color: h.muted },
  clear: { display: 'flex', alignItems: 'center', gap: '8px', color: h.spruceT, fontSize: '14px' },
  forced: { marginBottom: '12px' },
});

/**
 * The operator's page of DEV-13 (ADR-021, runbook 03): the maintenance switch, what is still under way, and the restore
 * reconciliation with its reports. Behind operations.maintenance; it keeps working while the CRM is read-only.
 */
export function MaintenancePage() {
  const styles = useStyles();
  const settings = useSettingsStyles();
  const { t } = useTranslation();
  const status = useMaintenanceStatus();
  const [reportId, setReportId] = useState<string | null>(null);

  return (
    <>
      <PageHeader title={t('maintenance.title')} subtitle={t('maintenance.subtitle')} />
      {status.error && <ErrorState error={status.error} onRetry={() => void status.refetch()} />}
      {status.data && (
        <div className={settings.stack}>
          <div className={styles.top}>
            <StatePanel status={status.data} />
            <SwitchPanel status={status.data} />
          </div>
          <ReconcilePanel readOnly={status.data.mode === 'ReadOnly'} />
          <ReportsPanel selected={reportId} onSelect={setReportId} />
        </div>
      )}
    </>
  );
}

function StatePanel({ status }: { status: MaintenanceStatus }) {
  const styles = useStyles();
  const settings = useSettingsStyles();
  const { t } = useTranslation();
  const underWay = status.inFlight.reduce((sum, c) => sum + c.count, 0);

  return (
    <Panel title={t('maintenance.state.title')} icon={<Gauge16Regular />}>
      {status.forced && (
        <MessageBar intent="warning" className={styles.forced}>
          <MessageBarBody>{t('maintenance.state.forced')}</MessageBarBody>
        </MessageBar>
      )}
      <DetailList
        items={[
          {
            label: t('maintenance.state.mode'),
            value: (
              <Badge appearance="tint" color={status.mode === 'ReadOnly' ? 'warning' : 'success'}>
                {t(`maintenance.state.modes.${status.mode}`)}
              </Badge>
            ),
          },
          { label: t('maintenance.state.since'), value: formatDateTime(status.since) },
          { label: t('maintenance.state.setBy'), value: status.setBy && <PersonCell name={status.setBy} size={24} /> },
          { label: t('maintenance.state.reason'), value: status.reason },
          { label: t('maintenance.state.reference'), value: status.reference },
        ]}
      />
      <section className={styles.part} aria-label={t('maintenance.inFlight.title')}>
        <h3 className={styles.subhead}>{t('maintenance.inFlight.title')}</h3>
        <p className={settings.note}>{t('maintenance.inFlight.hint')}</p>
        {underWay === 0 ? (
          <span className={styles.clear}>
            <CheckmarkCircle16Regular aria-hidden />
            <Text>{t('maintenance.inFlight.clear')}</Text>
          </span>
        ) : (
          // Counts are read at a glance: every one must be 0 before the restore point is taken.
          <FactGrid items={status.inFlight.map((c) => ({ label: t(`maintenance.areas.${c.area}`, { defaultValue: c.area }), value: String(c.count) }))} />
        )}
      </section>
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
    <Panel title={t('maintenance.switch.title')} icon={<LockClosed16Regular />}>
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
        <div className={styles.footer}>
          {/* Why the switch cannot be used yet: a forced deployment, or a reason still to write. */}
          {(status.forced || !valid) && (
            <p className={styles.reason}>
              <span className={styles.reasonIcon} aria-hidden>
                <Info16Regular />
              </span>
              {status.forced ? t('maintenance.switch.forcedShort') : t('maintenance.switch.needsReason', { min: MIN_REASON, max: MAX_REASON })}
            </p>
          )}
          <div className={styles.actions}>
            {/* One primary step on the page at a time: switching to read-only first; once read-only, the reconciliation below
                leads, and returning to normal is the quiet last step. */}
            <Button appearance={target === 'ReadOnly' ? 'primary' : 'secondary'} type="submit" disabled={!valid || status.forced || setMaintenance.isPending}>
              {target === 'ReadOnly' ? t('maintenance.switch.toReadOnly') : t('maintenance.switch.toNormal')}
            </Button>
          </div>
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
    <Panel title={t('maintenance.reconcile.title')} icon={<ArrowSync16Regular />}>
      <div className={styles.form}>
        <p className={styles.lead}>{t('maintenance.reconcile.intro')}</p>
        {!readOnly && (
          <MessageBar intent="info">
            <MessageBarBody>{t('maintenance.reconcile.needsReadOnly')}</MessageBarBody>
          </MessageBar>
        )}
        <div className={styles.fields}>
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
        </div>
        {reconcile.error && (
          <MessageBar intent="error">
            <MessageBarBody>{errorMessage(reconcile.error, t)}</MessageBarBody>
          </MessageBar>
        )}
        <div className={styles.footer}>
          {/* In normal operation the notice above says why; in read-only mode the next step is named here. */}
          {readOnly && (
            <p className={mergeClasses(styles.reason, previewed && styles.ready)}>
              <span className={mergeClasses(styles.reasonIcon, previewed && styles.ready)} aria-hidden>
                {previewed ? <CheckmarkCircle16Regular /> : <Info16Regular />}
              </span>
              {!point
                ? t('maintenance.reconcile.needsPoint')
                : !inPast
                  ? t('maintenance.reconcile.invalidPoint')
                  : previewed
                    ? t('maintenance.reconcile.readyToApply')
                    : t('maintenance.reconcile.applyHint')}
            </p>
          )}
          <div className={styles.actions}>
            <Button appearance={readOnly && !previewed ? 'primary' : 'secondary'} disabled={!readOnly || !inPast || reconcile.isPending} onClick={() => void run(false)}>
              {t('maintenance.reconcile.dryRun')}
            </Button>
            <Button appearance={readOnly && previewed ? 'primary' : 'secondary'} disabled={!readOnly || !previewed || reconcile.isPending} onClick={() => setConfirming(true)}>
              {t('maintenance.reconcile.apply')}
            </Button>
          </div>
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
    <section className={styles.part} aria-label={t('maintenance.report.title', { at: formatDateTime(report.at) })}>
      <h3 className={styles.subhead}>{t('maintenance.report.title', { at: formatDateTime(report.at) })}</h3>
      <DetailList
        items={[
          { label: t('maintenance.report.kind'), value: <KindBadge applied={report.applied} /> },
          { label: t('maintenance.report.restorePoint'), value: formatDateTime(report.restorePoint) },
          { label: t('maintenance.report.by'), value: <PersonCell name={report.by} size={24} /> },
          { label: t('maintenance.report.effects'), value: String(report.effects) },
          { label: t('maintenance.report.needsPerson'), value: <span className={needsPerson > 0 ? styles.needsPerson : undefined}>{needsPerson}</span> },
        ]}
      />
      <h4 className={styles.minor}>{t('maintenance.report.reconciliation')}</h4>
      {report.reconciliation.length === 0 ? <EmptyState message={t('maintenance.report.nothing')} icon={<CheckmarkCircle24Regular />} /> : <Lines lines={report.reconciliation} />}
      <h4 className={styles.minor}>{t('maintenance.report.checks')}</h4>
      <Lines lines={report.checks} />
    </section>
  );
}

function Lines({ lines }: { lines: RestoreLine[] }) {
  const styles = useStyles();
  const table = useTableCardStyles();
  const { t } = useTranslation();
  return (
    <ScrollTable className={table.inset}>
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
  const table = useTableCardStyles();
  const reports = useRestoreReports();
  const report = useRestoreReport(selected);

  return (
    <Panel title={t('maintenance.reports.title')} icon={<History16Regular />}>
      {reports.error && <ErrorState error={reports.error} onRetry={() => void reports.refetch()} />}
      {reports.data && reports.data.length === 0 && <EmptyState message={t('maintenance.reports.empty')} icon={<History24Regular />} />}
      {reports.data && reports.data.length > 0 && (
        <ScrollTable className={table.inset}>
          <Table size="small" className={styles.reportsTable} aria-label={t('maintenance.reports.title')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell className={table.dateTimeCol}>{t('maintenance.reports.at')}</TableHeaderCell>
                <TableHeaderCell className={table.dateTimeCol}>{t('maintenance.reports.restorePoint')}</TableHeaderCell>
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
                  <TableCell><KindBadge applied={r.applied} /></TableCell>
                  <TableCell className={styles.nowrap}><PersonCell name={r.by} size={24} /></TableCell>
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

/** A dry run only reads; an applied reconciliation changed the restored copy. */
function KindBadge({ applied }: { applied: boolean }) {
  const { t } = useTranslation();
  return (
    <Badge appearance="tint" color={applied ? 'success' : 'subtle'}>
      {applied ? t('maintenance.report.applied') : t('maintenance.report.dryRun')}
    </Badge>
  );
}
