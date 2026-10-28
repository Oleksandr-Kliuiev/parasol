import { useEffect, useState } from 'react';
import { Button, MessageBar, MessageBarActions, MessageBarBody, makeStyles, useRestoreFocusTarget } from '@fluentui/react-components';
import { Dismiss16Regular } from '@fluentui/react-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../../../shared/utils/errors';
import { formatDate } from '../../../shared/utils/format';
import { useActionBatch } from '../../actions/batch';
import type { ActionBatchResult } from '../../actions/types';
import { showAlerts, type ChosenAlert, type HiddenTogether } from './alertBulk';

const useStyles = makeStyles({ notice: { marginBottom: '12px' } });

/** The last bulk action of this page (M45): a batch asked of Atera, or alerts hidden together. */
export type RecentBulk =
  | { kind: 'close'; alerts: ChosenAlert[]; result: ActionBatchResult }
  | ({ kind: 'hide' } & HiddenTogether);

/**
 * What became of the last bulk action, above the list until the person dismisses it (M45). A batch asked of Atera is followed here
 * once its dialog is closed: how far it has come, then whether anything needs a look, with the way back to its result per alert; the
 * queue is read again when the batch has its outcomes, so alerts Atera closed leave it without a reload. Alerts hidden together can be
 * shown again with one press, as long as the notice is there: no time limit runs out on the way back, and it shows each alert as the
 * hide left it, so one someone decided about since stays as it is and the notice says how many did.
 */
export function AlertBulkNotice({ recent, onShow, onDismiss }: { recent: RecentBulk; onShow: () => void; onDismiss: () => void }) {
  return recent.kind === 'close'
    ? <CloseNotice key={recent.result.batchId} recent={recent} onShow={onShow} onDismiss={onDismiss} />
    : <HideNotice key={recent.alerts.map((alert) => alert.id).join()} recent={recent} onDismiss={onDismiss} />;
}

function CloseNotice({ recent, onShow, onDismiss }: { recent: Extract<RecentBulk, { kind: 'close' }>; onShow: () => void; onDismiss: () => void }) {
  const { t } = useTranslation(); const styles = useStyles(); const client = useQueryClient(); const restore = useRestoreFocusTarget();
  const batch = useActionBatch(recent.result.batchId);
  const state = batch.state;
  const total = state?.total ?? recent.result.asked;
  const issues = state ? state.failed + state.uncertain : 0;
  useEffect(() => { if (batch.finished) void client.invalidateQueries({ queryKey: ['service', 'alerts'] }); }, [batch.finished, client]);
  return <MessageBar className={styles.notice} politeness="polite" intent={!batch.finished ? 'info' : issues > 0 ? 'warning' : 'success'} layout="multiline">
    <MessageBarBody>{!batch.finished
      ? t('alerts.bulk.notice.closing', { done: state ? state.total - state.waiting : 0, count: total })
      : issues > 0 ? t('alerts.bulk.notice.closedSome', { issues, count: total }) : t('alerts.bulk.notice.closedAll', { count: total })}</MessageBarBody>
    <MessageBarActions containerAction={<Dismiss onDismiss={onDismiss} />}>
      <Button {...restore} size="small" onClick={onShow}>{t(batch.finished ? 'alerts.bulk.notice.showResults' : 'alerts.bulk.notice.show')}</Button>
    </MessageBarActions>
  </MessageBar>;
}

function HideNotice({ recent, onDismiss }: { recent: Extract<RecentBulk, { kind: 'hide' }>; onDismiss: () => void }) {
  const { t } = useTranslation(); const styles = useStyles(); const client = useQueryClient();
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [undone, setUndone] = useState<{ shown: number; left: number } | null>(null);
  // The way back: each alert shown again as the hide left it; one changed since (hidden for longer, shown, resolved) stays as it is.
  const undo = async () => {
    setBusy(true); setError(null);
    try {
      const answer = await showAlerts(recent.alerts);
      void client.invalidateQueries({ queryKey: ['service', 'alerts'] });
      setUndone({ shown: answer.applied, left: answer.items.length - answer.applied });
    } catch (failure) {
      setError(errorMessage(failure, t));
    } finally {
      setBusy(false);
    }
  };
  const said = undone === null
    ? t('alerts.bulk.hide.done', { count: recent.alerts.length, date: formatDate(recent.until) })
    : [t('alerts.bulk.show.done', { count: undone.shown }), undone.left > 0 && t('alerts.bulk.notice.undoLeft', { count: undone.left })].filter(Boolean).join(' ');
  return <MessageBar className={styles.notice} politeness="polite" intent={error ? 'error' : undone && undone.left > 0 ? 'warning' : 'success'} layout="multiline">
    <MessageBarBody>{error ?? said}</MessageBarBody>
    <MessageBarActions containerAction={<Dismiss onDismiss={onDismiss} />}>
      {undone === null && <Button size="small" disabledFocusable={busy} onClick={() => void undo()}>
        {t(busy ? 'alerts.bulk.notice.undoing' : 'alerts.bulk.notice.undo')}</Button>}
    </MessageBarActions>
  </MessageBar>;
}

function Dismiss({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useTranslation();
  return <Button appearance="transparent" size="small" icon={<Dismiss16Regular />} aria-label={t('alerts.bulk.notice.dismiss')} onClick={onDismiss} />;
}
