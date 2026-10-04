import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Badge,
  Button,
  Dialog,
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
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Add20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { ListFooter } from '../../shared/components/ListFooter';
import { PageHeader } from '../../shared/components/PageHeader';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatMoney } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { useLegacyCharges, useLegacyDecision, useRunActions, useRuns } from './api';
import { RunStatusBadge } from './shared';
import { monthLabel } from './period';
import { Panel } from '../../shared/components/Panel';
import type { LegacyCharge } from './types';

const useStyles = makeStyles({
  period: { fontWeight: tokens.fontWeightSemibold },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: tokens.spacingHorizontalM },
  kind: { marginInlineStart: tokens.spacingHorizontalS },
  legacy: { marginBottom: tokens.spacingVerticalL },
  hint: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, margin: `${tokens.spacingVerticalXS} 0 0` },
  decisions: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
});

/** Billing runs, newest period first (docs/02 §4.9). */
export function BillingRunsPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
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
      ) : (
        <div className={catalog.tableWrap}>
          <Table className={catalog.table} aria-label={t('billing.title')}>
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
                    <AppLink to={`/billing/runs/${run.id}`}>
                      <span className={styles.period}>{monthLabel(run.periodStart, i18n.language)}</span>
                    </AppLink>
                    {run.kind === 'Supplementary' && (
                      <Badge appearance="outline" color="informative" className={styles.kind}>
                        {t('billing.supplementary.badge')}
                      </Badge>
                    )}
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
                  <TableCell className={catalog.muted}>
                    {[
                      run.collectedAt && t('billing.milestones.collected', { date: formatDate(run.collectedAt) }),
                      run.approvedAt && t('billing.milestones.approved', { date: formatDate(run.approvedAt) }),
                      run.exportedAt && t('billing.milestones.exported', { date: formatDate(run.exportedAt) }),
                      run.closedAt && t('billing.milestones.closed', { date: formatDate(run.closedAt) }),
                    ]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!isPending && data.length === 0 && <EmptyState message={t('billing.empty')} />}
          <ListFooter shown={data.length} total={runs.total} hasMore={runs.hasNextPage} loading={runs.isFetchingNextPage} onMore={() => void runs.fetchNextPage()} />
        </div>
      )}

      <Dialog open={creating} onOpenChange={(_, d) => !d.open && setCreating(false)}>
        <DialogSurface>{creating && <NewRunForm onClose={() => setCreating(false)} />}</DialogSurface>
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
          {actions.create.error && (
            <MessageBar intent="error" style={{ marginBottom: 12 }}>
              <MessageBarBody>{errorMessage(actions.create.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <p style={{ marginTop: 0 }}>{t('billing.newRunBody')}</p>
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
          <Switch label={t('billing.supplementary.label')} checked={supplementary} onChange={(_, d) => setSupplementary(d.checked)} />
          <p className={styles.hint}>{t('billing.supplementary.hint')}</p>
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
  const { t } = useTranslation();
  const canSeeMoney = useCan(Permissions.financeRead);
  const { data } = useLegacyCharges(true);
  const [deciding, setDeciding] = useState<{ charge: LegacyCharge; billed: boolean } | null>(null);
  const restoreFocusTarget = useRestoreFocusTarget();
  if (!data || data.count === 0) return null;

  return (
    <div className={styles.legacy}>
      <Panel title={t('billing.legacy.title')}>
        <p style={{ marginTop: 0 }}>
          {canSeeMoney ? t('billing.legacy.summaryAmount', { count: data.count, amount: formatMoney(data.amount) }) : t('billing.legacy.summary', { count: data.count })}
        </p>
        <Table aria-label={t('billing.legacy.title')}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>{t('billing.fields.customer')}</TableHeaderCell>
              <TableHeaderCell>{t('billing.fields.period')}</TableHeaderCell>
              <TableHeaderCell>{t('billing.fields.description')}</TableHeaderCell>
              {canSeeMoney && <TableHeaderCell>{t('billing.fields.lineTotal')}</TableHeaderCell>}
              <TableHeaderCell>{t('billing.legacy.why')}</TableHeaderCell>
              <TableHeaderCell />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((charge) => (
              <TableRow key={charge.id}>
                <TableCell>{charge.organization.name}</TableCell>
                <TableCell>{charge.periodStart ? formatDate(charge.periodStart) : '—'}</TableCell>
                <TableCell>{charge.description ?? '—'}</TableCell>
                {canSeeMoney && <TableCell>{formatMoney(charge.amount)}</TableCell>}
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
      </Panel>
      <Dialog open={deciding !== null} onOpenChange={(_, d) => !d.open && setDeciding(null)}>
        <DialogSurface>{deciding && <LegacyDecisionForm charge={deciding.charge} billed={deciding.billed} onClose={() => setDeciding(null)} />}</DialogSurface>
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
