import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Button, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, Link, MessageBar, MessageBarBody, Spinner, Text, Textarea,
  makeStyles,
} from '@fluentui/react-components';
import { Open16Regular } from '@fluentui/react-icons';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiError, REVERIFY_REQUIRED } from '../../api/client';
import { h } from '../../app/hearth';
import { Dialog } from '../../shared/components/Dialog';
import { useKeptWhileClosing } from '../../shared/components/useKeptWhileClosing';
import { safeHttpUrl } from '../../shared/utils/safeUrl';
import { systemName } from '../integrations/labels';
import { cancelAction, previewAction, requestAction, useAction, useRefreshActions } from './api';
import { ActionStatusBadge } from './ActionStatusBadge';
import { actionErrorText, blockText, effectText, nameMatches, outcomeText } from './actionText';
import { isWaiting, type ActionPreview, type ActionRequest, type VendorAction } from './types';

const REASON_MIN = 10;
const REASON_MAX = 500;

const useStyles = makeStyles({
  content: { display: 'grid', gap: '14px', gridTemplateColumns: 'minmax(0, 1fr)', overflowWrap: 'anywhere' },
  target: { display: 'grid', gap: '2px' },
  targetName: { fontWeight: 600 },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px' },
  effects: { margin: 0, paddingLeft: '20px', display: 'grid', gap: '4px' },
  status: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 10px' },
  // A 24 px hit box for the way to the vendor (WCAG 2.5.8); the mark stays beside the words when they wrap.
  external: { display: 'inline-flex', alignItems: 'center', gap: '4px', minHeight: '24px', '& svg': { flexShrink: 0 } },
});

/**
 * The one confirmation of every action at a vendor (M39.1). It shows the server's preview — made from saved data: the target, what
 * changes, what blocks it — asks what the action's level asks (one button; a reason; a fresh sign-in, the target's name typed and a
 * reason, then a hold with a way back), and follows the action until the worker has an outcome. Closing it never stops an action:
 * the action log keeps it.
 */
export function ActionDialog({ request, title, confirm, details, onClose, onFinished }: {
  request: ActionRequest | null; title: string; confirm: string;
  /** What the preview cannot show in words, such as the text of a reply, placed above the effects. */
  details?: ReactNode;
  onClose: () => void; onFinished?: (action: VendorAction) => void;
}) {
  const shown = useKeptWhileClosing(request);
  const keptTitle = useKeptWhileClosing(title, request !== null);
  const keptDetails = useKeptWhileClosing(details, request !== null);
  return <Dialog open={request !== null} onOpenChange={(_, data) => { if (!data.open) onClose(); }}>
    <DialogSurface>{shown && <ActionFlow key={JSON.stringify(shown)} request={shown} title={keptTitle} confirm={confirm} details={keptDetails}
      onClose={onClose} onFinished={onFinished} />}</DialogSurface>
  </Dialog>;
}

function ActionFlow({ request, title, confirm, details, onClose, onFinished }: {
  request: ActionRequest; title: string; confirm: string; details?: ReactNode; onClose: () => void; onFinished?: (action: VendorAction) => void;
}) {
  const { t } = useTranslation(); const styles = useStyles(); const refresh = useRefreshActions();
  // The preview is asked once per opening and again only on purpose: a renewal after the server said it aged or changed.
  const previewQuery = useQuery({
    queryKey: ['actions', 'preview', request], queryFn: () => previewAction(request),
    retry: false, staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const preview: ActionPreview | null = previewQuery.isFetching ? null : previewQuery.data ?? null;
  const loadError: unknown = previewQuery.isFetching ? null : previewQuery.error;
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [note, setNote] = useState<'renewed' | 'reverify' | null>(null);
  const [reason, setReason] = useState(''); const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState<VendorAction | null>(null);
  // One key for every press in this dialog: a repeat after a lost answer returns the action already saved, never a second one.
  const commandKey = useRef(crypto.randomUUID());
  const alive = useRef(true); const finished = useRef(false); const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // Nothing to type: the way out takes the focus, so a stray Enter changes nothing (as in ConfirmDialog).
  useEffect(() => { if (preview && !preview.confirmation.reason) cancelRef.current?.focus(); }, [preview]);

  const live = useAction(accepted?.id ?? null, accepted ?? undefined).data ?? accepted;
  useEffect(() => {
    if (!live || isWaiting(live.status) || finished.current) return;
    finished.current = true; refresh(live); onFinished?.(live);
  }, [live, onFinished, refresh]);

  const confirmation = preview?.confirmation;
  const reasonValid = !confirmation?.reason || (reason.trim().length >= REASON_MIN && reason.trim().length <= REASON_MAX);
  const nameValid = !confirmation?.typedName || (preview !== null && nameMatches(typed, preview.target.name));
  const ready = preview !== null && preview.block === null && preview.previewToken !== null && reasonValid && nameValid;

  const submit = async () => {
    if (!preview || !ready || busy) return;
    setBusy(true); setSubmitError(null); setNote(null);
    try {
      const action = await requestAction(preview, request, commandKey.current, { reason: confirmation?.reason ? reason.trim() : undefined, typedName: typed });
      if (!alive.current) return;
      setAccepted(action); refresh(action);
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof ApiError && error.code === REVERIFY_REQUIRED) setNote('reverify');
      else if (error instanceof ApiError && (error.code === 'VND_PREVIEW_EXPIRED' || error.code === 'VND_PREVIEW_STALE')) {
        // The preview aged or the saved data changed: show the fresh one and let the person confirm what it says now.
        setNote('renewed'); await previewQuery.refetch();
      } else setSubmitError(error);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const cancel = async () => {
    if (!live || busy) return;
    setBusy(true); setSubmitError(null);
    try {
      const action = await cancelAction(live);
      if (alive.current) { setAccepted(action); refresh(action); }
    } catch (error) {
      if (alive.current) setSubmitError(error);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return <form onSubmit={(event) => { event.preventDefault(); void submit(); }}><DialogBody>
    <DialogTitle>{title}</DialogTitle>
    <DialogContent className={styles.content}>
      {live && preview ? <Following action={live} preview={preview} /> : <>
        {!preview && !loadError && <Spinner size="small" label={t('actions.dialog.previewing')} />}
        {loadError !== null && <MessageBar intent="error" layout="multiline"><MessageBarBody>{actionErrorText(t, loadError)}{' '}
          <Link as="button" type="button" onClick={() => void previewQuery.refetch()}>{t('common.retry')}</Link></MessageBarBody></MessageBar>}
        {preview && <>
          <div className={styles.target}>
            <Text className={styles.targetName}>{preview.target.name}</Text>
            <Text className={styles.muted}>{[preview.target.organizationName, t('actions.dialog.source', { system: systemName(t, preview.system) })]
              .filter(Boolean).join(' · ')}</Text>
          </div>
          {details}
          {preview.effects.length > 0 && <ul className={styles.effects} aria-label={t('actions.dialog.effects')}>
            {preview.effects.map((effect, index) => <li key={`${effect.code}:${index}`}>{effectText(t, effect)}</li>)}
          </ul>}
          {preview.block && <MessageBar intent="warning" layout="multiline"><MessageBarBody>{blockText(t, preview.block)}</MessageBarBody></MessageBar>}
          {!preview.block && preview.simulated && <MessageBar intent="info" layout="multiline">
            <MessageBarBody>{t('actions.dialog.simulated', { system: systemName(t, preview.system) })}</MessageBarBody></MessageBar>}
          {!preview.block && preview.paused && <MessageBar intent="warning" layout="multiline">
            <MessageBarBody>{t('actions.dialog.paused', { system: systemName(t, preview.system) })}</MessageBarBody></MessageBar>}
          {!preview.block && preview.level === 'Destructive' && <MessageBar intent="warning" layout="multiline"><MessageBarBody>
            {t('actions.dialog.destructive', { seconds: preview.confirmation.holdSeconds })}</MessageBarBody></MessageBar>}
          {!preview.block && confirmation?.typedName && <Field label={t('actions.dialog.typeName', { name: preview.target.name })} required
            validationState={typed && !nameValid ? 'error' : 'none'} validationMessage={typed && !nameValid ? t('actions.dialog.typeNameMismatch') : undefined}>
            <Input value={typed} onChange={(_, data) => setTyped(data.value)} autoComplete="off" autoFocus />
          </Field>}
          {!preview.block && confirmation?.reason && <Field label={t('actions.dialog.reason')} required
            hint={t('actions.dialog.reasonHint', { min: REASON_MIN, max: REASON_MAX })}>
            <Textarea value={reason} onChange={(_, data) => setReason(data.value)} maxLength={REASON_MAX} resize="vertical"
              autoFocus={!confirmation.typedName} />
          </Field>}
        </>}
        {note && <MessageBar intent="info" layout="multiline"><MessageBarBody role="status">
          {t(note === 'reverify' ? 'actions.dialog.reverify' : 'actions.dialog.renewed', { confirm })}</MessageBarBody></MessageBar>}
      </>}
      {submitError !== null && <MessageBar intent="error" layout="multiline"><MessageBarBody role="alert">{actionErrorText(t, submitError)}</MessageBarBody></MessageBar>}
    </DialogContent>
    <DialogActions>
      {live ? <>
        {live.status === 'Scheduled' && <Button onClick={() => void cancel()} disabled={busy}>{t('actions.dialog.cancelAction')}</Button>}
        <Button appearance="primary" onClick={onClose}>{t('common.close')}</Button>
      </> : <>
        <Button ref={cancelRef} onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
        <Button appearance="primary" type="submit" disabled={!ready || busy}>{confirm}</Button>
      </>}
    </DialogActions>
  </DialogBody></form>;
}

/** The action after it was asked for: held with its countdown, on its way, or its outcome; announced as it changes. */
function Following({ action, preview }: { action: VendorAction; preview: ActionPreview }) {
  const { t } = useTranslation(); const styles = useStyles();
  const seconds = useSecondsUntil(action.status === 'Scheduled' ? action.notBefore : null);
  const system = systemName(t, action.system);
  const url = action.status === 'Uncertain' && preview.target.url ? safeHttpUrl(preview.target.url) : undefined;
  return <div className={styles.content} role="status" aria-live="polite">
    <div className={styles.status}>
      <ActionStatusBadge status={action.status} />
      {(action.status === 'Queued' || action.status === 'Sending') && <Spinner size="extra-tiny" aria-hidden />}
      <Text>{action.status === 'Scheduled' ? t('actions.dialog.held', { seconds })
        : isWaiting(action.status) ? t('actions.dialog.sending', { system })
          : outcomeText(t, action) || t(`actions.status.${action.status}`)}</Text>
    </div>
    {action.status === 'Uncertain' && <Text className={styles.muted}>{t('actions.dialog.uncertainNext', { system })}</Text>}
    {url && <Link href={url} target="_blank" rel="noopener noreferrer" className={styles.external}>
      <span>{t('actions.dialog.openAtVendor', { system })}</span><Open16Regular aria-hidden /></Link>}
    {isWaiting(action.status) && <Text className={styles.muted}>{t('actions.dialog.keepsGoing')}</Text>}
  </div>;
}

/** Whole seconds until a moment, counted down once a second; null when there is nothing to count. */
function useSecondsUntil(at: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!at) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [at]);
  return at ? Math.max(0, Math.ceil((Date.parse(at) - now) / 1_000)) : null;
}
