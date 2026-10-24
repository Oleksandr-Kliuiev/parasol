import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Badge,
  Button,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHeaderCell,
  TableHeader,
  TableRow,
  makeStyles,
  mergeClasses,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import { Add20Regular, History16Regular, ReceiptMoney24Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { ListFooter } from '../../shared/components/ListFooter';
import { PageHeader } from '../../shared/components/PageHeader';
import { useKeptWhileClosing } from '../../shared/components/useKeptWhileClosing';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatMoney } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { useLegacyCharges, useLegacyDecision, useRunActions, useRuns } from './api';
import { RunStatusBadge } from './shared';
import { monthLabel } from './period';
import { Panel } from '../../shared/components/Panel';
import type { LegacyCharge, RunListItem } from './types';
import { ScrollTable } from '../../shared/components/ScrollTable';
import { useFlushStyles } from './flushStyles';
import { h } from '../../app/hearth';

const useStyles = makeStyles({
  period: { fontWeight: tokens.fontWeightSemibold },
  // The new-run form: year and month side by side, then the notes and the kind of run, 14/16 px apart.
  form: { display: 'grid', gap: '14px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))', gap: '14px 16px' },
  intro: { marginTop: 0, marginBottom: 0, color: h.muted, fontSize: '13px', lineHeight: '20px' },
  // The period and, for a supplementary run, its pill: side by side, or the pill under it on the same left edge.
  periodCell: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px' },
  // The period opens the run: a 24 px tall target, also on a phone where the rows sit close to the tab bar (WCAG 2.5.8).
  periodLink: { display: 'inline-flex', alignItems: 'center', minHeight: '24px' },
  legacy: { marginBottom: '16px' },
  decisions: { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' },
  legacyTable: { minWidth: '820px' },
  // The wide table runs to the card edges: a line above it, no second frame; its hidden edge fades as it scrolls.
  flushTable: { borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: h.line, borderRightWidth: 0, borderBottomWidth: 0, borderLeftWidth: 0,
    borderRadius: 0, boxShadow: 'none', backgroundColor: 'transparent' },
  // Both decisions side by side: the two buttons are the row's action, not a stack.
  decisionColumn: { width: '252px' },
  // The way of a run in four steps (collected, approved, sent, closed): a short track and the step it reached.
  progress: { display: 'grid', gap: '4px', justifyItems: 'start' },
  track: { display: 'flex', gap: '3px' },
  step: { width: '18px', height: '4px', borderRadius: '999px', backgroundColor: h.line2 },
  stepOn: { backgroundColor: h.spruce },
  latest: { display: 'inline-block', color: h.text, fontSize: '13px', lineHeight: '18px', fontVariantNumeric: 'tabular-nums', '::first-letter': { textTransform: 'uppercase' } },
  hidden: { position: 'absolute', width: '1px', height: '1px', margin: '-1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0, padding: 0 },
});

/** Where a run stands: four steps as a track, the last step reached with its date; the earlier ones for screen readers. */
function RunProgress({ run }: { run: RunListItem }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const steps = [
    ['collected', run.collectedAt],
    ['approved', run.approvedAt],
    ['exported', run.exportedAt],
    ['closed', run.closedAt],
  ] as const;
  const reached = steps.filter(([, at]) => at).map(([step, at]) => t(`billing.milestones.${step}`, { date: formatDate(at) }));
  if (reached.length === 0) return <span>—</span>;
  return (
    <span className={styles.progress}>
      <span className={styles.track} aria-hidden>
        {steps.map(([step, at]) => <span key={step} className={mergeClasses(styles.step, at ? styles.stepOn : undefined)} />)}
      </span>
      <span className={styles.latest}>{reached.at(-1)}</span>
      {reached.length > 1 && <span className={styles.hidden}>{reached.slice(0, -1).join(', ')}</span>}
    </span>
  );
}

/** Billing runs, newest period first (docs/02 §4.9). */
export function BillingRunsPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const flush = useFlushStyles();
  const { t, i18n } = useTranslation();
  const canManage = useCan(Permissions.billingManage);
  const canSeeMoney = useCan(Permissions.financeRead);
  const runs = useRuns();
  const { items: data, error, isPending, refetch } = runs;
  const [creating, setCreating] = useState(false);
  const restoreFocusTarget = useRestoreFocusTarget();

  return (
    <>
      <PageHeader
        title={t('billing.title')}
        subtitle={t('billing.subtitle')}
        actions={
          canManage && (
            <Button {...restoreFocusTarget} appearance="primary" icon={<Add20Regular />} onClick={() => setCreating(true)}>
              {t('billing.newRun')}
            </Button>
          )
        }
      />

      {canManage && <LegacyChargesPanel />}

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : !isPending && data.length === 0 ? (
        <div className={catalog.tableWrap}>
          <EmptyState icon={<ReceiptMoney24Regular />} message={t('billing.empty')}
            action={canManage && <Button {...restoreFocusTarget} icon={<Add20Regular />} onClick={() => setCreating(true)}>{t('billing.newRun')}</Button>} />
        </div>
      ) : (
        <ScrollTable className={catalog.tableWrap}>
          <Table className={mergeClasses(catalog.table, flush.cells)} aria-label={t('billing.title')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('billing.fields.period')}</TableHeaderCell>
                <TableHeaderCell>{t('common.status')}</TableHeaderCell>
                <TableHeaderCell className={catalog.number}>{t('billing.fields.customers')}</TableHeaderCell>
                {canSeeMoney && <TableHeaderCell className={catalog.number}>{t('billing.fields.total')}</TableHeaderCell>}
                <TableHeaderCell className={catalog.number}>{t('billing.fields.anomalies')}</TableHeaderCell>
                <TableHeaderCell>{t('billing.fields.milestones')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((run) => (
                <TableRow key={run.id}>
                  <TableCell>
                    <span className={styles.periodCell}>
                      <AppLink to={`/billing/runs/${run.id}`} className={styles.periodLink}>
                        <span className={styles.period}>{monthLabel(run.periodStart, i18n.language)}</span>
                      </AppLink>
                      {run.kind === 'Supplementary' && (
                        <Badge appearance="tint" color="informative">
                          {t('billing.supplementary.badge')}
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    <RunStatusBadge status={run.status} requiresSecondApproval={run.requiresSecondApproval} />
                  </TableCell>
                  <TableCell className={catalog.number}>{run.organizations}</TableCell>
                  {canSeeMoney && <TableCell className={catalog.number}>{formatMoney(run.totalExVat)}</TableCell>}
                  <TableCell className={catalog.number}>
                    {run.withAnomalies > 0 ? (
                      <Badge appearance="tint" color="warning">
                        {run.withAnomalies}
                      </Badge>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    <RunProgress run={run} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <ListFooter shown={data.length} total={runs.total} hasMore={runs.hasNextPage} loading={runs.isFetchingNextPage} onMore={() => void runs.fetchNextPage()} />
        </ScrollTable>
      )}

      <Dialog open={creating} onOpenChange={(_, d) => !d.open && setCreating(false)}>
        <DialogSurface><NewRunForm onClose={() => setCreating(false)} /></DialogSurface>
      </Dialog>
    </>
  );
}

/** The wizard is one step: which period to bill. Everything else follows from the contracts. */
function NewRunForm({ onClose }: { onClose: () => void }) {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const notify = useNotify();
  const navigate = useNavigate();
  const actions = useRunActions();
  // The period just gone is the one Finance bills; hours and licences of the running month are not final yet.
  const previous = new Date();
  previous.setDate(1);
  previous.setMonth(previous.getMonth() - 1);
  const [year, setYear] = useState(String(previous.getFullYear()));
  const [month, setMonth] = useState(String(previous.getMonth() + 1));
  const [notes, setNotes] = useState('');
  const [supplementary, setSupplementary] = useState(false);

  const submit = async () => {
    try {
      const created = await actions.create.mutateAsync({ year: Number(year), month: Number(month), notes: notes.trim() || null, supplementary });
      notify(t('billing.runCreated', { period: monthLabel(created.data.periodStart, i18n.language) }));
      onClose();
      navigate(`/billing/runs/${created.data.id}`);
    } catch {
      // Shown in the dialog.
    }
  };

  const months = Array.from({ length: 12 }, (_, index) => index + 1);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogBody>
        <DialogTitle>{t('billing.newRun')}</DialogTitle>
        <DialogContent>
          <div className={styles.form}>
            {actions.create.error && (
              <MessageBar intent="error">
                <MessageBarBody>{errorMessage(actions.create.error, t)}</MessageBarBody>
              </MessageBar>
            )}
            <p className={styles.intro}>{t('billing.newRunBody')}</p>
            <div className={styles.grid}>
              <Field label={t('billing.fields.year')} required>
                <Input type="number" min={2020} max={2100} value={year} onChange={(_, d) => setYear(d.value)} />
              </Field>
              <Field label={t('billing.fields.month')} required>
                <Dropdown
                  value={monthLabel(`${year}-${month.padStart(2, '0')}-01`, i18n.language)}
                  selectedOptions={[month]}
                  onOptionSelect={(_, d) => setMonth(d.optionValue ?? month)}
                >
                  {months.map((value) => (
                    <Option key={value} value={String(value)} text={monthLabel(`${year}-${String(value).padStart(2, '0')}-01`, i18n.language)}>
                      {monthLabel(`${year}-${String(value).padStart(2, '0')}-01`, i18n.language)}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
            </div>
            <Field label={t('billing.fields.notes')}>
              <Input value={notes} onChange={(_, d) => setNotes(d.value)} />
            </Field>
            <Field hint={t('billing.supplementary.hint')}>
              <Switch label={t('billing.supplementary.label')} checked={supplementary} onChange={(_, d) => setSupplementary(d.checked)} />
            </Field>
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={actions.create.isPending}>
            {t('common.create')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}

/**
 * Lines billed before the charge register whose source could not be proven (ADR-013). Each holds the days it may cover
 * until Finance says whether it was billed back then; the decision and its reason are audited (EXT-01).
 */
function LegacyChargesPanel() {
  const styles = useStyles();
  const flush = useFlushStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const canSeeMoney = useCan(Permissions.financeRead);
  const { data } = useLegacyCharges(true);
  const [deciding, setDeciding] = useState<{ charge: LegacyCharge; billed: boolean } | null>(null);
  const shown = useKeptWhileClosing(deciding);
  const restoreFocusTarget = useRestoreFocusTarget();
  if (!data || data.count === 0) return null;

  return (
    <div className={styles.legacy}>
      <Panel title={t('billing.legacy.title')} icon={<History16Regular />} flush className={flush.panel}>
        <p className={mergeClasses(flush.body, flush.muted)}>
          {canSeeMoney ? t('billing.legacy.summaryAmount', { count: data.count, amount: formatMoney(data.amount) }) : t('billing.legacy.summary', { count: data.count })}
        </p>
        <ScrollTable className={styles.flushTable} label={t('billing.legacy.title')}>
          <Table aria-label={t('billing.legacy.title')} className={mergeClasses(flush.table, styles.legacyTable)}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('billing.fields.customer')}</TableHeaderCell>
                <TableHeaderCell>{t('billing.fields.period')}</TableHeaderCell>
                <TableHeaderCell>{t('billing.fields.description')}</TableHeaderCell>
                {canSeeMoney && <TableHeaderCell className={catalog.number}>{t('billing.fields.lineTotal')}</TableHeaderCell>}
                <TableHeaderCell>{t('billing.legacy.why')}</TableHeaderCell>
                <TableHeaderCell className={styles.decisionColumn} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((charge) => (
                <TableRow key={charge.id}>
                  <TableCell>{charge.organization.name}</TableCell>
                  <TableCell>{charge.periodStart ? formatDate(charge.periodStart) : '—'}</TableCell>
                  <TableCell>{charge.description ?? '—'}</TableCell>
                  {canSeeMoney && <TableCell className={catalog.number}>{formatMoney(charge.amount)}</TableCell>}
                  <TableCell>{charge.reason ?? '—'}</TableCell>
                  <TableCell>
                    <span className={styles.decisions}>
                      <Button {...restoreFocusTarget} size="small" onClick={() => setDeciding({ charge, billed: true })}>
                        {t('billing.legacy.billed')}
                      </Button>
                      <Button {...restoreFocusTarget} size="small" onClick={() => setDeciding({ charge, billed: false })}>
                        {t('billing.legacy.notBilled')}
                      </Button>
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollTable>
      </Panel>
      <Dialog open={deciding !== null} onOpenChange={(_, d) => !d.open && setDeciding(null)}>
        <DialogSurface>{shown && <LegacyDecisionForm charge={shown.charge} billed={shown.billed} onClose={() => setDeciding(null)} />}</DialogSurface>
      </Dialog>
    </div>
  );
}

function LegacyDecisionForm({ charge, billed, onClose }: { charge: LegacyCharge; billed: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const decide = useLegacyDecision();
  const [reason, setReason] = useState('');

  const submit = async () => {
    try {
      await decide.mutateAsync({ id: charge.id, billed, reason: reason.trim(), etag: charge.etag });
      notify(t('billing.legacy.decided'));
      onClose();
    } catch {
      // Shown in the dialog.
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogBody>
        <DialogTitle>{billed ? t('billing.legacy.billedTitle') : t('billing.legacy.notBilledTitle')}</DialogTitle>
        <DialogContent>
          {decide.error && (
            <MessageBar intent="error" style={{ marginBottom: 12 }}>
              <MessageBarBody>{errorMessage(decide.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <p style={{ marginTop: 0 }}>{billed ? t('billing.legacy.billedBody') : t('billing.legacy.notBilledBody')}</p>
          <Field label={t('billing.fields.reason')} required>
            <Input value={reason} onChange={(_, d) => setReason(d.value)} />
          </Field>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={!reason.trim() || decide.isPending}>
            {t('common.save')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}
