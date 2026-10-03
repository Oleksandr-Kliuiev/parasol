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
import { PageHeader } from '../../shared/components/PageHeader';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatMoney } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { useRunActions, useRuns } from './api';
import { RunStatusBadge } from './shared';
import { monthLabel } from './period';

const useStyles = makeStyles({
  period: { fontWeight: tokens.fontWeightSemibold },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: tokens.spacingHorizontalM },
});

/** Billing runs, newest period first (docs/02 §4.9). */
export function BillingRunsPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t, i18n } = useTranslation();
  const canManage = useCan(Permissions.billingManage);
  const canSeeMoney = useCan(Permissions.financeRead);
  const { data = [], error, isPending, refetch } = useRuns();
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

  const submit = async () => {
    try {
      const created = await actions.create.mutateAsync({ year: Number(year), month: Number(month), notes: notes.trim() || null });
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
