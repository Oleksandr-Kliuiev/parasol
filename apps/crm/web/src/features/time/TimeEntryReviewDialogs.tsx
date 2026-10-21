import { useState } from 'react';
import { Button, DialogActions, DialogBody, DialogContent, DialogTitle, Field, Input, MessageBar, MessageBarBody, Switch, makeStyles } from '@fluentui/react-components';
import { h } from '../../app/hearth';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatNumber } from '../../shared/utils/format';
import { usePeriodActions, useTimeActions } from './api';
import { monthName } from './monthName';
import type { Period, TimeEntry } from './types';

const useStyles = makeStyles({
  form: { display: 'grid', gap: '14px' },
  intro: { margin: 0, maxWidth: '75ch', color: h.muted, fontSize: '13px', lineHeight: '20px' },
  // The two yes/no facts on one row, as in the time form.
  flags: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '24px', rowGap: '4px', minHeight: '42px' },
});

/** Correct an entry before approval (FR-TIM-03). */
export function AdjustDialog({ entry, onClose }: { entry: TimeEntry; onClose: () => void }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useTimeActions();
  const [billable, setBillable] = useState(entry.billable);
  const [afterHours, setAfterHours] = useState(entry.afterHours);
  const [workType, setWorkType] = useState(entry.workType ?? '');

  const submit = async () => {
    try {
      await actions.adjust.mutateAsync({ id: entry.id, billable, workType: workType.trim() || null, afterHours });
      notify(t('time.adjusted'));
      onClose();
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{t('time.adjustTitle')}</DialogTitle>
        <DialogContent>
          <div className={styles.form}>
            {actions.adjust.error && (
              <MessageBar intent="error">
                <MessageBarBody>{errorMessage(actions.adjust.error, t)}</MessageBarBody>
              </MessageBar>
            )}
            {/* The dialog names the entry it changes: the table row it came from is behind the dialog. */}
            <p className={styles.intro}><strong>{t('time.adjustEntry', { hours: formatNumber(entry.hours), organization: entry.organizationName ?? '—',
              date: formatDate(entry.workDate), technician: entry.technicianName ?? '' }).replace(/ · $/u, '')}</strong></p>
            <p className={styles.intro}>{t('time.adjustBody')}</p>
            <Field label={t('time.fields.workType')}>
              <Input value={workType} onChange={(_, d) => setWorkType(d.value)} />
            </Field>
            <div className={styles.flags}>
              <Switch label={t('time.fields.billable')} checked={billable} onChange={(_, d) => setBillable(d.checked)} />
              <Switch label={t('time.fields.afterHours')} checked={afterHours} onChange={(_, d) => setAfterHours(d.checked)} />
            </div>
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={actions.adjust.isPending}>
            {t('common.save')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}

/** Reopen a closed month; the reason goes to the audit log (BR-TIM-05). */
export function ReopenDialog({ period, onClose }: { period: Period; onClose: () => void }) {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const notify = useNotify();
  const actions = usePeriodActions();
  const [reason, setReason] = useState('');

  const submit = async () => {
    try {
      await actions.reopen.mutateAsync({ year: period.year, month: period.month, reason: reason.trim() });
      notify(t('time.periodReopened'));
      onClose();
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{t('time.reopenTitle', { period: monthName(period.year, period.month, i18n.language) })}</DialogTitle>
        <DialogContent>
          <div className={styles.form}>
            {actions.reopen.error instanceof ApiError && (
              <MessageBar intent="error">
                <MessageBarBody>{errorMessage(actions.reopen.error, t)}</MessageBarBody>
              </MessageBar>
            )}
            <Field label={t('time.reopenReason')} required hint={t('time.reopenHint')}>
              <Input value={reason} onChange={(_, d) => setReason(d.value)} />
            </Field>
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={!reason.trim() || actions.reopen.isPending}>
            {t('time.reopenPeriod')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}
