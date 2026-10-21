import { useEffect, useRef, useState } from 'react';
import {
  Button, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, MessageBar, MessageBarBody, Radio, RadioGroup, Text, Textarea,
  makeStyles,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { Dialog } from '../../shared/components/Dialog';
import { FactGrid } from '../../shared/components/Panel';
import { useKeptWhileClosing } from '../../shared/components/useKeptWhileClosing';
import { formatDateTime } from '../../shared/utils/format';
import { systemName } from '../integrations/labels';
import { cancelAction, settleAction, useAction, useRefreshActions } from './api';
import { ActionStatusBadge } from './ActionStatusBadge';
import { actionErrorText, kindName, outcomeText } from './actionText';
import type { VendorAction } from './types';

const REASON_MIN = 10;

const useStyles = makeStyles({
  content: { display: 'grid', gap: '14px', gridTemplateColumns: 'minmax(0, 1fr)', overflowWrap: 'anywhere' },
  status: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 10px' },
  quote: { margin: 0, paddingLeft: '12px', borderLeft: `3px solid ${h.line2}`, whiteSpace: 'pre-wrap', color: h.text },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px' },
});

/**
 * One action of the log (M39.1): what was asked, by whom and why, what the worker did — and, for an action without a clear outcome,
 * the person's verdict after checking at the vendor. Settling sends nothing: asking again is a new action.
 */
export function ActionDetailDialog({ action, onClose }: { action: VendorAction | null; onClose: () => void }) {
  const shown = useKeptWhileClosing(action);
  return <Dialog open={action !== null} onOpenChange={(_, data) => { if (!data.open) onClose(); }}>
    <DialogSurface>{shown && <Detail key={shown.id} initial={shown} onClose={onClose} />}</DialogSurface>
  </Dialog>;
}

function Detail({ initial, onClose }: { initial: VendorAction; onClose: () => void }) {
  const { t } = useTranslation(); const styles = useStyles(); const refresh = useRefreshActions();
  const action = useAction(initial.id, initial).data ?? initial;
  const [verdict, setVerdict] = useState<'Succeeded' | 'Failed' | ''>(''); const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const text = typeof action.parameters.text === 'string' ? action.parameters.text : null;

  const run = async (change: () => Promise<VendorAction>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const changed = await change();
      if (alive.current) refresh(changed);
    } catch (failure) {
      if (alive.current) setError(failure);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const settleReady = verdict !== '' && reason.trim().length >= REASON_MIN;

  return <form onSubmit={(event) => { event.preventDefault(); if (settleReady) void run(() => settleAction(action, verdict as 'Succeeded' | 'Failed', reason.trim())); }}>
    <DialogBody>
      <DialogTitle>{`${kindName(t, action.system, action.kind)} · ${action.targetName}`}</DialogTitle>
      <DialogContent className={styles.content}>
        <div className={styles.status} role="status">
          <ActionStatusBadge status={action.status} />
          <Text>{outcomeText(t, action) || t(`actions.status.${action.status}`)}</Text>
        </div>
        {text && <blockquote className={styles.quote}>{text}</blockquote>}
        <FactGrid items={[
          { label: t('actions.fields.requestedBy'), value: action.requestedByName ?? '—' },
          { label: t('actions.fields.requestedAt'), value: formatDateTime(action.requestedAt) },
          { label: t('actions.fields.source'), value: systemName(t, action.system) },
          ...(action.organizationName ? [{ label: t('actions.fields.customer'), value: action.organizationName }] : []),
          ...(action.reason ? [{ label: t('actions.fields.reason'), value: action.reason }] : []),
          ...(action.completedAt ? [{ label: t('actions.fields.completedAt'), value: formatDateTime(action.completedAt) }] : []),
          ...(action.attempts > 1 ? [{ label: t('actions.fields.attempts'), value: String(action.attempts) }] : []),
          ...(action.closedByName ? [{ label: t('actions.fields.closedBy'), value: `${action.closedByName}${action.closeReason ? ` — ${action.closeReason}` : ''}` }] : []),
        ]} />
        {action.status === 'Uncertain' && <>
          <Text className={styles.muted}>{t('actions.settle.intro', { system: systemName(t, action.system) })}</Text>
          <Field label={t('actions.settle.question')} required>
            <RadioGroup value={verdict} onChange={(_, data) => setVerdict(data.value as 'Succeeded' | 'Failed')}>
              <Radio value="Succeeded" label={t('actions.settle.done', { system: systemName(t, action.system) })} />
              <Radio value="Failed" label={t('actions.settle.notDone', { system: systemName(t, action.system) })} />
            </RadioGroup>
          </Field>
          <Field label={t('actions.settle.reason')} required hint={t('actions.dialog.reasonHint', { min: REASON_MIN, max: 500 })}>
            <Textarea value={reason} onChange={(_, data) => setReason(data.value)} maxLength={500} resize="vertical" />
          </Field>
        </>}
        {error !== null && <MessageBar intent="error" layout="multiline"><MessageBarBody role="alert">{actionErrorText(t, error)}</MessageBarBody></MessageBar>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{t('common.close')}</Button>
        {action.status === 'Scheduled' || action.status === 'Queued'
          ? <Button onClick={() => void run(() => cancelAction(action))} disabled={busy}>{t('actions.dialog.cancelAction')}</Button> : null}
        {action.status === 'Uncertain' && <Button appearance="primary" type="submit" disabled={!settleReady || busy}>{t('actions.settle.confirm')}</Button>}
      </DialogActions>
    </DialogBody>
  </form>;
}
