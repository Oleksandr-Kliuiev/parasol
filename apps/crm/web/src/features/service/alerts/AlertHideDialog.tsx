import { useState } from 'react';
import {
  Button, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, MessageBar, MessageBarBody, Spinner, Text,
  Textarea, ToggleButton, makeStyles,
} from '@fluentui/react-components';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../../api/client';
import { h } from '../../../app/hearth';
import { Dialog } from '../../../shared/components/Dialog';
import { useNotify } from '../../../shared/components/useNotify';
import { errorMessage } from '../../../shared/utils/errors';
import { formatDate } from '../../../shared/utils/format';
import { alertTitle, sourceName } from './alertText';
import { dayIn, hideAlert, hideMaxDays, hideShortcuts, validHideDay } from './alertHiding';
import { useAlert } from './useAlertQueue';

const useStyles = makeStyles({
  content: { display: 'grid', gap: '12px', gridTemplateColumns: 'minmax(0, 1fr)' },
  shortcuts: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px' },
});

const reasonLength = 500;

/**
 * Hides one alert in Parasoll until a day, with the reason (M40). The source cannot snooze an alert through its API, so the
 * dialog says the alert stays open there; here it leaves every open list until the start of the chosen day and comes back by
 * itself. The alert is read when the dialog opens: the change goes with the ETag of that read.
 */
export function AlertHideDialog({ alertId, onClose, onHidden }: { alertId: string; onClose: () => void; onHidden?: () => void }) {
  const { t } = useTranslation(); const styles = useStyles(); const client = useQueryClient(); const notify = useNotify();
  const read = useAlert(alertId);
  const alert = read.data;
  const [until, setUntil] = useState(() => dayIn(1));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const dayOk = validHideDay(until);
  const reasonOk = reason.trim().length > 0;

  const hide = async () => {
    setTouched(true);
    if (!alert?.etag || !dayOk || !reasonOk) return;
    setBusy(true); setError(null);
    try {
      await hideAlert(alert, alert.etag, until, reason.trim());
      void client.invalidateQueries({ queryKey: ['service', 'alerts'] });
      notify(t('alerts.hide.done', { date: formatDate(until) }));
      onClose();
      onHidden?.();
    } catch (failure) {
      // A read in between changed the alert: it is read again, and the person decides on what is there now.
      if (failure instanceof ApiError && failure.status === 412) { setError(t('alerts.hide.changed')); void read.refetch(); }
      else setError(errorMessage(failure, t));
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open onOpenChange={(_, d) => { if (!d.open && !busy) onClose(); }}>
    <DialogSurface><DialogBody>
      <DialogTitle>{t('alerts.hide.title')}</DialogTitle>
      <DialogContent className={styles.content}>
        {read.isFetching && !alert && <Spinner size="small" label={t('alerts.detail.loading')} />}
        {alert && <>
          <Text block weight="semibold">{alertTitle(t, alert)}</Text>
          <Text block className={styles.muted}>
            {alert.rule ? t('alerts.hide.gapStays') : t('alerts.hide.sourceStays', { source: sourceName(t, alert.system) })}</Text>
          <div>
            <Field required label={t('alerts.hide.until')} hint={t('alerts.hide.untilHint')}
              validationMessage={touched && !dayOk ? t('alerts.hide.invalidDay', { days: hideMaxDays }) : undefined}>
              <Input type="date" value={until} min={dayIn(1)} max={dayIn(hideMaxDays)} disabled={busy} onChange={(_, d) => setUntil(d.value)} />
            </Field>
            <div role="group" aria-label={t('alerts.hide.shortcuts')} className={styles.shortcuts}>
              {hideShortcuts.map(([key, days]) => <ToggleButton key={key} size="small" shape="circular" checked={until === dayIn(days)} disabled={busy}
                onClick={() => setUntil(dayIn(days))}>{t(`alerts.hide.in.${key}`)}</ToggleButton>)}
            </div>
          </div>
          <Field required label={t('alerts.hide.reason')} hint={t('alerts.hide.reasonHint')}
            validationMessage={touched && !reasonOk ? t('alerts.hide.reasonRequired') : undefined}>
            <Textarea value={reason} maxLength={reasonLength} disabled={busy} resize="vertical" onChange={(_, d) => setReason(d.value)} />
          </Field>
          {dayOk && <Text block role="status" className={styles.muted}>{t('alerts.hide.summary', { date: formatDate(until) })}</Text>}
        </>}
        {error && <MessageBar intent="warning"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
        {!read.isFetching && read.isError && <MessageBar intent="error"><MessageBarBody>{errorMessage(read.error, t)}</MessageBarBody></MessageBar>}
      </DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
        <Button appearance="primary" disabled={!alert?.etag} disabledFocusable={busy} onClick={() => void hide()}>
          {busy ? t('alerts.hide.hiding') : t('alerts.hide.confirm')}</Button>
      </DialogActions>
    </DialogBody></DialogSurface>
  </Dialog>;
}
