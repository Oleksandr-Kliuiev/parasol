import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Button, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Link, MessageBar, MessageBarBody, ProgressBar, Spinner, Text,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../../api/client';
import { h } from '../../../app/hearth';
import { Dialog } from '../../../shared/components/Dialog';
import { useKeptWhileClosing } from '../../../shared/components/useKeptWhileClosing';
import { useScrollEdges } from '../../../shared/utils/useScrollEdges';
import { ActionDetailDialog } from '../../actions/ActionDetailDialog';
import { ActionStatusBadge } from '../../actions/ActionStatusBadge';
import { useAction, useRefreshActions } from '../../actions/api';
import { actionErrorText, blockText, codeText } from '../../actions/actionText';
import { previewBatch, requestBatch, useActionBatch } from '../../actions/batch';
import type { ActionBatchEntry, ActionBatchPreview, ActionBatchRequest, ActionBatchResult, ActionStatus } from '../../actions/types';
import { systemName } from '../../integrations/labels';
import { AlertAge, AlertSeverityBadge } from './AlertBits';
import { alertTitle } from './alertText';
import type { ChosenAlert } from './alertBulk';

const useStyles = makeStyles({
  content: { display: 'grid', gap: '14px', gridTemplateColumns: 'minmax(0, 1fr)', overflowWrap: 'anywhere' },
  scroll: { ':focus-visible': { outlineWidth: '2px', outlineStyle: 'solid', outlineColor: tokens.colorStrokeFocus2, outlineOffset: '2px' } },
  heading: { margin: 0, fontSize: '14px', lineHeight: '20px', fontWeight: 600 },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px' },
  lines: { margin: 0, paddingLeft: '20px', display: 'grid', gap: '4px' },
  // The alerts of the batch, each with what happened to it: a plain list, the dialog's content scrolls when it is long.
  items: { listStyleType: 'none', margin: 0, padding: 0, display: 'grid', gap: '2px' },
  item: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', columnGap: '10px', alignItems: 'start', paddingTop: '6px', paddingBottom: '6px',
    borderBottom: `1px solid ${h.line}` },
  name: { fontWeight: 600 },
  counts: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 12px' },
  count: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontVariantNumeric: 'tabular-nums' },
  // A 24 px hit box for the way to an action's card (WCAG 2.5.8).
  open: { minHeight: '24px', textAlign: 'start' },
  srOnly: { position: 'absolute', width: '1px', height: '1px', margin: '-1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0, padding: 0 },
});

/** The outcomes a batch result names, in the order a person reads them: what needs them first, then what went through. */
const order: ActionStatus[] = ['Uncertain', 'Failed', 'Rejected', 'Cancelled', 'Scheduled', 'Queued', 'Sending', 'Succeeded', 'Skipped', 'Simulated'];

/**
 * "Close in Atera" for many alerts at once (M45), on the vendor action path (M39.1): one preview made from saved data says how many
 * Atera will close and which stay as they are and why, one confirmation asks for an action per alert, and the dialog then follows
 * the batch — how many are handled, and when all are, what happened to each alert. Closing it never stops the actions: the page
 * follows the batch on (AlertBulkNotice) and opens this dialog again on it (`followed`); each action is in the action log on
 * Connections, and one without a clear answer reaches the person who asked.
 */
export function AlertBulkCloseDialog({ alerts, followed, onAsked, onClose }: {
  /** The chosen alerts; those not open in Atera stay out and are said so. Null while the dialog is closed. */
  alerts: readonly ChosenAlert[] | null;
  /** A batch asked before: the dialog opens on what became of it. */
  followed?: ActionBatchResult | null;
  /** The batch was saved: the page follows it from now on, open dialog or not. */
  onAsked: (result: ActionBatchResult) => void;
  /** `asked`: actions were saved, so the selection and the queue have changed. */
  onClose: (asked: boolean) => void;
}) {
  const shown = useKeptWhileClosing(alerts);
  const shownBatch = useKeptWhileClosing(followed ?? null, alerts !== null);
  // Escape and a click beside the dialog close it as its Close button does: once actions were asked, the queue has changed.
  const asked = useRef(false);
  const close = () => { const changed = asked.current; asked.current = false; onClose(changed); };
  return <Dialog open={alerts !== null} onOpenChange={(_, data) => { if (!data.open) close(); }}>
    <DialogSurface>{shown && <CloseFlow key={shownBatch?.batchId ?? shown.map((a) => a.id).join()} alerts={shown} followed={shownBatch}
      onAsked={(result) => { asked.current = true; onAsked(result); }} onClose={close} />}
    </DialogSurface>
  </Dialog>;
}

function CloseFlow({ alerts, followed, onAsked, onClose }: {
  alerts: readonly ChosenAlert[]; followed: ActionBatchResult | null; onAsked: (result: ActionBatchResult) => void; onClose: () => void;
}) {
  const { t } = useTranslation(); const styles = useStyles(); const refresh = useRefreshActions();
  const atera = useMemo(() => alerts.filter((a) => a.system === 'atera' && a.state !== 'Resolved'), [alerts]);
  const request = useMemo<ActionBatchRequest>(() => ({
    system: 'atera', kind: 'alert.resolve', targetType: 'alert', targetIds: atera.map((a) => a.externalId), parameters: {},
  }), [atera]);
  const [result, setResult] = useState<ActionBatchResult | null>(followed);
  // The preview is asked once per opening and again only on purpose: a renewal after the server said it aged or changed.
  const previewQuery = useQuery({
    queryKey: ['actions', 'batch-preview', request], queryFn: () => previewBatch(request), enabled: atera.length > 0 && followed === null,
    retry: false, staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const preview: ActionBatchPreview | null = previewQuery.isFetching ? null : previewQuery.data ?? null;
  const loadError: unknown = previewQuery.isFetching ? null : previewQuery.error;
  const [busy, setBusy] = useState(false); const [submitError, setSubmitError] = useState<unknown>(null); const [renewed, setRenewed] = useState(false);
  // One key for every press in this dialog: a repeat after a lost answer returns the actions already saved, never a second batch.
  const batchKey = useRef(crypto.randomUUID());
  const alive = useRef(true); const cancelRef = useRef<HTMLButtonElement>(null); const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Nothing to type: the way out takes the focus, so a stray Enter changes nothing (as in ActionDialog).
  useEffect(() => { if (preview || atera.length === 0) cancelRef.current?.focus(); }, [preview, atera.length]);
  // Once asked, the confirm button is gone: focus goes to Close, never to the page behind.
  useEffect(() => { if (result) closeRef.current?.focus(); }, [result]);

  const contentRef = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(contentRef, 'y', `${preview?.previewToken ?? ''}:${result?.batchId ?? ''}`);
  const title = t('alerts.bulk.close.title');
  const ready = preview && preview.block === null ? preview.ready : 0;

  const submit = async () => {
    if (!preview || ready === 0 || busy) return;
    setBusy(true); setSubmitError(null); setRenewed(false);
    try {
      const saved = await requestBatch(preview, request, batchKey.current);
      if (saved.batchId !== null) onAsked(saved);
      if (!alive.current) return;
      setResult(saved); refresh();
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof ApiError && (error.code === 'VND_PREVIEW_EXPIRED' || error.code === 'VND_PREVIEW_STALE')) {
        // The preview aged or the saved alerts changed: show the fresh one and let the person confirm what it says now.
        setRenewed(true); batchKey.current = crypto.randomUUID(); await previewQuery.refetch();
      } else setSubmitError(error);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return <form onSubmit={(event) => { event.preventDefault(); void submit(); }}><DialogBody>
    <DialogTitle>{title}</DialogTitle>
    <DialogContent ref={contentRef} className={mergeClasses(styles.content, styles.scroll)} style={edges.style}
      role={edges.overflow ? 'region' : undefined} aria-label={edges.overflow ? title : undefined} tabIndex={edges.overflow ? 0 : undefined}>
      {result ? <Following result={result} alerts={atera} /> : <>
        {atera.length > 0 && !preview && !loadError && <Spinner size="small" label={t('actions.dialog.previewing')} />}
        {loadError !== null && <MessageBar intent="error" layout="multiline"><MessageBarBody>{actionErrorText(t, loadError)}{' '}
          <Link as="button" type="button" onClick={() => void previewQuery.refetch()}>{t('common.retry')}</Link></MessageBarBody></MessageBar>}
        {preview && <Preview preview={preview} alerts={alerts} atera={atera} />}
        {atera.length === 0 && <Text block>{t('alerts.bulk.close.noneFromAtera', { count: alerts.length })}</Text>}
        {renewed && <MessageBar intent="info" layout="multiline"><MessageBarBody role="status">
          {t('actions.dialog.renewed', { confirm: t('alerts.bulk.close.confirm', { count: ready }) })}</MessageBarBody></MessageBar>}
      </>}
      {submitError !== null && <MessageBar intent="error" layout="multiline"><MessageBarBody role="alert">{actionErrorText(t, submitError)}</MessageBarBody></MessageBar>}
    </DialogContent>
    <DialogActions>
      {result
        ? <Button ref={closeRef} appearance="primary" onClick={onClose}>{t('common.close')}</Button>
        : <>
          <Button ref={cancelRef} onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          {/* Nothing to confirm until the preview says what will happen, and nothing when it says nothing can. */}
          {ready > 0 && <Button appearance="primary" type="submit" disabledFocusable={busy}>{t('alerts.bulk.close.confirm', { count: ready })}</Button>}
        </>}
    </DialogActions>
  </DialogBody></form>;
}

/**
 * What the batch will do, from saved data: how many Atera closes (and how many of them are critical), what stays as it is and why,
 * the vendor's test mode or pause, and the alerts it closes with what tells them apart: severity, customer, device and age.
 */
function Preview({ preview, alerts, atera }: { preview: ActionBatchPreview; alerts: readonly ChosenAlert[]; atera: readonly ChosenAlert[] }) {
  const { t } = useTranslation(); const styles = useStyles();
  const system = systemName(t, preview.system);
  // What keeps alerts out, each reason once with how many it keeps out.
  const left = useMemo(() => {
    const reasons = new Map<string, { text: string; count: number }>();
    for (const target of preview.targets) {
      if (!target.block) continue;
      const reason = reasons.get(target.block.code) ?? { text: blockText(t, target.block), count: 0 };
      reasons.set(target.block.code, { ...reason, count: reason.count + 1 });
    }
    return [...reasons.values()];
  }, [preview.targets, t]);
  const other = alerts.length - atera.length;
  const byId = useMemo(() => new Map(atera.map((a) => [a.externalId, a])), [atera]);
  const closing = preview.targets.filter((target) => target.block === null).map((target) => ({ target, alert: byId.get(target.targetId) }));
  const critical = closing.filter(({ alert }) => alert?.severity === 'Critical').length;
  const listId = useId();
  return <>
    {preview.block
      ? <MessageBar intent="warning" layout="multiline"><MessageBarBody>{blockText(t, preview.block)}</MessageBarBody></MessageBar>
      : <>
        <Text block>{t('alerts.bulk.close.intro', { count: preview.ready })}{critical > 0 &&
          ` ${preview.ready === 1 ? t('alerts.bulk.close.criticalOne') : t('alerts.bulk.close.critical', { count: critical })}`}</Text>
        {preview.simulated && <MessageBar intent="info" layout="multiline"><MessageBarBody>{t('actions.dialog.simulated', { system })}</MessageBarBody></MessageBar>}
        {preview.paused && <MessageBar intent="warning" layout="multiline"><MessageBarBody>{t('actions.dialog.paused', { system })}</MessageBarBody></MessageBar>}
      </>}
    {(left.length > 0 || other > 0) && <section>
      <h3 className={styles.heading}>{t('alerts.bulk.leftHeading', { count: left.reduce((sum, r) => sum + r.count, 0) + other })}</h3>
      <ul className={styles.lines}>
        {left.map((reason) => <li key={reason.text}>{t('alerts.bulk.leftReason', { count: reason.count, reason: reason.text })}</li>)}
        {other > 0 && <li>{t('alerts.bulk.leftReason', { count: other, reason: t('alerts.bulk.close.otherSources') })}</li>}
      </ul>
    </section>}
    {preview.ready > 0 && !preview.block && <section>
      <h3 id={listId} className={styles.heading}>{t('alerts.bulk.close.listHeading', { count: preview.ready })}</h3>
      <ul className={styles.items} aria-labelledby={listId}>
        {closing.map(({ target, alert }) => <li key={target.targetId} className={styles.item}>
          {alert ? <AlertSeverityBadge severity={alert.severity} /> : <span />}
          <span>
            <Text block className={styles.name}>{alert ? alertTitle(t, alert) : target.target?.name}</Text>
            <Text block className={styles.muted}>
              {[target.target?.organizationName ?? alert?.organizationName, alert?.deviceName].filter(Boolean).join(' · ')}
              {alert && <>{' · '}<AlertAge at={alert.createdAt} /></>}
            </Text>
          </span>
        </li>)}
      </ul>
    </section>}
  </>;
}

/**
 * The batch after it was asked for: how far the worker has come, the count of each outcome, and once nothing waits, every alert with
 * what happened to it. An alert without a clear answer, or one Atera refused, opens its action's card, where it is checked or settled.
 * The progress is shown, not read out at every step: one announcement says when the batch is done and how it went.
 */
function Following({ result, alerts }: { result: ActionBatchResult; alerts: readonly ChosenAlert[] }) {
  const { t } = useTranslation(); const styles = useStyles();
  const batch = useActionBatch(result.batchId);
  const [opened, setOpened] = useState<string | null>(null);
  const leftOutId = useId(); const resultsId = useId();
  const card = useAction(opened);
  const state = batch.state;
  const total = state?.total ?? result.asked;
  const done = state ? state.total - state.waiting : 0;
  const issues = state ? state.failed + state.uncertain : 0;
  // Targets the command left out (an action of the same kind still waiting, a change since the preview), with their reason.
  const leftOut = result.items.filter((item) => item.code !== null);
  const entries = useMemo(() => [...(state?.items ?? [])].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status)), [state?.items]);
  const byId = useMemo(() => new Map(alerts.map((a) => [a.externalId, a])), [alerts]);
  const name = (entry: Pick<ActionBatchEntry, 'targetId' | 'targetName'>) => {
    const alert = byId.get(entry.targetId);
    return alert ? alertTitle(t, alert) : entry.targetName;
  };
  // An alert action's outcome in the words of alerts: what closing it in Atera came to.
  const outcome = (entry: ActionBatchEntry) => entry.status === 'Succeeded' ? t('alerts.bulk.close.closedInAtera')
    : entry.status === 'Skipped' ? t('alerts.bulk.close.alreadyClosed')
      : entry.outcomeCode ? codeText(t, entry.outcomeCode, '') : null;
  const counts: Array<[ActionStatus, number]> = state ? ([
    ['Succeeded', state.succeeded], ['Skipped', state.skipped], ['Simulated', state.simulated], ['Failed', state.failed], ['Uncertain', state.uncertain],
  ] as Array<[ActionStatus, number]>).filter(([, count]) => count > 0) : [];
  return <div className={styles.content}>
    <span role="status" className={styles.srOnly}>{batch.finished
      ? issues > 0 ? t('alerts.bulk.notice.closedSome', { issues, count: total }) : t('alerts.bulk.notice.closedAll', { count: total })
      : ''}</span>
    {result.asked > 0 && <div className={styles.content}>
      <Text block weight="semibold">{batch.finished ? t('alerts.bulk.close.finished', { count: total }) : t('alerts.bulk.close.progress', { done, count: total })}</Text>
      {!batch.finished && <ProgressBar value={total > 0 ? done / total : 0} aria-label={t('alerts.bulk.close.progressLabel')} />}
      {counts.length > 0 && <span className={styles.counts}>
        {counts.map(([status, count]) => <span key={status} className={styles.count}><ActionStatusBadge status={status} />{count}</span>)}
      </span>}
      {!batch.finished && <Text className={styles.muted}>{t('alerts.bulk.close.keepsGoing')}</Text>}
    </div>}
    {result.asked === 0 && <Text block role="status">{t('alerts.bulk.close.noneAsked')}</Text>}
    {leftOut.length > 0 && <section>
      <h3 id={leftOutId} className={styles.heading}>{t('alerts.bulk.close.notAskedHeading', { count: leftOut.length })}</h3>
      <ul className={styles.items} aria-labelledby={leftOutId}>{leftOut.map((item) => <li key={item.targetId} className={styles.item}>
        {item.status ? <ActionStatusBadge status={item.status} /> : <span />}
        <span><Text block className={styles.name}>{name({ targetId: item.targetId, targetName: item.targetId })}</Text>
          <Text block className={styles.muted}>{codeText(t, item.code!, item.code!)}</Text></span>
      </li>)}</ul>
    </section>}
    {batch.finished && entries.length > 0 && <section>
      <h3 id={resultsId} className={styles.heading}>{t('alerts.bulk.close.resultsHeading', { count: entries.length })}</h3>
      <ul className={styles.items} aria-labelledby={resultsId}>
        {entries.map((entry) => <li key={entry.actionId} className={styles.item}>
          <ActionStatusBadge status={entry.status} />
          <span>
            <Text block className={styles.name}>{name(entry)}</Text>
            <Text block className={styles.muted}>{[entry.organizationName, outcome(entry)].filter(Boolean).join(' · ')}</Text>
            {(entry.status === 'Uncertain' || entry.status === 'Failed' || entry.status === 'Rejected') &&
              <Link as="button" type="button" className={styles.open} onClick={() => setOpened(entry.actionId)}
                aria-label={t('alerts.bulk.close.openActionNamed', { title: name(entry) })}>{t('alerts.bulk.close.openAction')}</Link>}
          </span>
        </li>)}
      </ul>
    </section>}
    {batch.error !== null && <MessageBar intent="warning" layout="multiline"><MessageBarBody>{actionErrorText(t, batch.error)}</MessageBarBody></MessageBar>}
    {/* Nested in the dialog, so the batch is the active dialog again once the card closes. */}
    <ActionDetailDialog action={opened !== null && card.data?.id === opened ? card.data : null} onClose={() => setOpened(null)} />
  </div>;
}
