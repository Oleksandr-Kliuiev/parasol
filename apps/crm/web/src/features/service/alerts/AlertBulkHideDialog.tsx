import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Button, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, MessageBar, MessageBarBody, Spinner, Text, Textarea,
  ToggleButton, makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { h } from '../../../app/hearth';
import { ConfirmDialog } from '../../../shared/components/ConfirmDialog';
import { Dialog } from '../../../shared/components/Dialog';
import { useNotify } from '../../../shared/components/useNotify';
import { errorMessage } from '../../../shared/utils/errors';
import { formatDate } from '../../../shared/utils/format';
import { useScrollEdges } from '../../../shared/utils/useScrollEdges';
import { alertTitle } from './alertText';
import { dayIn, hideMaxDays, hideShortcuts, validHideDay } from './alertHiding';
import {
  hiddenTogether, hideAlerts, lookupAlerts, showAlerts, type AlertBulkOutcome, type AlertBulkResult, type AlertSelectionItem, type ChosenAlert,
  type HiddenTogether,
} from './alertBulk';

const useStyles = makeStyles({
  content: { display: 'grid', gap: '12px', gridTemplateColumns: 'minmax(0, 1fr)', overflowWrap: 'anywhere' },
  scroll: { ':focus-visible': { outlineWidth: '2px', outlineStyle: 'solid', outlineColor: tokens.colorStrokeFocus2, outlineOffset: '2px' } },
  shortcuts: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px' },
  heading: { margin: 0, fontSize: '14px', lineHeight: '20px', fontWeight: 600 },
  lines: { margin: 0, paddingLeft: '20px', display: 'grid', gap: '4px' },
  items: { listStyleType: 'none', margin: 0, padding: 0, display: 'grid', gap: '2px' },
  item: { paddingTop: '6px', paddingBottom: '6px', borderBottom: `1px solid ${h.line}` },
  name: { fontWeight: 600 },
});

const reasonLength = 500;

/** Why an alert was left as it was, in the order a person reads them. */
const leftOrder: AlertBulkOutcome[] = ['Changed', 'Resolved', 'NotHidden', 'NotFound'];

/**
 * Hides many alerts in Parasoll until one day with one reason, or shows many hidden alerts again (M45), as one alert is hidden or
 * shown (M40). The chosen alerts are read when the dialog opens: it says how many it changes and which it leaves as they are and why,
 * and the change goes with the ETags of that read, so an alert someone changed meanwhile is left alone. When all of them changed, the
 * dialog closes and says so; otherwise it lists the ones left as they were. A reason being typed survives Escape and a click beside
 * the dialog: it asks before throwing it away (Cancel still closes at once).
 */
export function AlertBulkHideDialog({ mode, alerts, onClose }: {
  mode: 'hide' | 'show';
  alerts: readonly ChosenAlert[];
  /**
   * `changed`: some alerts were hidden or shown, so the selection and the queue have changed; `hidden` names those hidden, with their
   * day and the ETags the hide left, so the page can offer the way back.
   */
  onClose: (changed: boolean, hidden?: HiddenTogether) => void;
}) {
  const { t } = useTranslation(); const styles = useStyles(); const client = useQueryClient(); const notify = useNotify();
  const ids = useMemo(() => alerts.map((a) => a.id), [alerts]);
  const read = useQuery({
    queryKey: ['service', 'alerts', 'bulk-read', ids], queryFn: () => lookupAlerts(ids),
    retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false,
  });
  const items = read.data?.items;
  // What this change takes: not resolved, and hidden or not as the change needs.
  const applicable = useMemo(() => items?.filter((item) => item.state !== 'Resolved' &&
    (mode === 'hide' ? item.hiddenUntil === null : item.hiddenUntil !== null)) ?? [], [items, mode]);
  const [until, setUntil] = useState(() => dayIn(1));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [touched, setTouched] = useState(false);
  const [asking, setAsking] = useState(false); const [result, setResult] = useState<AlertBulkResult | null>(null);
  const reasonField = useRef<HTMLTextAreaElement>(null); const cancelRef = useRef<HTMLButtonElement>(null); const closeRef = useRef<HTMLButtonElement>(null);
  const dayOk = validHideDay(until);
  const reasonOk = reason.trim().length > 0;
  const applied = (result?.applied ?? 0) > 0;
  // The alerts a hide with leftovers did hide: handed to the page with the close, for the way back.
  const done = useRef<HiddenTogether | undefined>(undefined);
  const leave = () => { if (busy) return; if (!result && mode === 'hide' && reason.trim()) setAsking(true); else onClose(applied, done.current); };
  const keepEditing = () => { setAsking(false); requestAnimationFrame(() => reasonField.current?.focus()); };
  // Showing again asks nothing: the way out takes the focus once the alerts are read, so a stray Enter changes nothing.
  useEffect(() => { if (mode === 'show' && items) cancelRef.current?.focus(); }, [mode, items]);
  useEffect(() => { if (result) closeRef.current?.focus(); }, [result]);
  const contentRef = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(contentRef, 'y', `${items?.length ?? ''}:${result ? 1 : 0}:${error ?? ''}:${touched}`);
  const title = t(mode === 'hide' ? 'alerts.bulk.hide.title' : 'alerts.bulk.show.title', { count: alerts.length });

  // What the read found that this change leaves as it is: each reason once, with how many it leaves.
  const left = useMemo(() => {
    if (!items) return [];
    const found = new Set(items.map((item) => item.id));
    const reasons: Array<['resolved' | 'alreadyHidden' | 'notHidden' | 'gone', number]> = [
      ['resolved', items.filter((item) => item.state === 'Resolved').length],
      [mode === 'hide' ? 'alreadyHidden' : 'notHidden',
        items.filter((item) => item.state !== 'Resolved' && (mode === 'hide' ? item.hiddenUntil !== null : item.hiddenUntil === null)).length],
      ['gone', ids.filter((id) => !found.has(id)).length],
    ];
    return reasons.filter(([, count]) => count > 0);
  }, [ids, items, mode]);

  const submit = async () => {
    setTouched(true);
    if (busy || applicable.length === 0 || (mode === 'hide' && (!dayOk || !reasonOk))) return;
    setBusy(true); setError(null);
    try {
      const answer = mode === 'hide' ? await hideAlerts(applicable, until, reason.trim()) : await showAlerts(applicable);
      // The queue and its counts are read again; this dialog's own read only names the alerts of its result now.
      void client.invalidateQueries({ queryKey: ['service', 'alerts'], predicate: (query) => query.queryKey[2] !== 'bulk-read' });
      const hidden = mode === 'hide' ? hiddenTogether(answer, until) : undefined;
      if (answer.applied === answer.items.length) {
        // Every alert changed: the page says so above the list, with the way back for a hide; showing again is said in passing.
        if (mode === 'show') notify(t('alerts.bulk.show.done', { count: answer.applied }));
        onClose(true, hidden);
        return;
      }

      done.current = hidden;
      setResult(answer);
    } catch (failure) {
      setError(errorMessage(failure, t));
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open onOpenChange={(_, data) => { if (!data.open) leave(); }}><DialogSurface>
  {/* The fields say what is missing themselves: the browser's own check of required fields would stop the form before they could. */}
  <form noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}><DialogBody>
    <DialogTitle>{title}</DialogTitle>
    <DialogContent ref={contentRef} className={mergeClasses(styles.content, styles.scroll)} style={edges.style}
      role={edges.overflow ? 'region' : undefined} aria-label={edges.overflow ? title : undefined} tabIndex={edges.overflow ? 0 : undefined}>
      {read.isFetching && !items && <Spinner size="small" label={t('alerts.bulk.reading')} />}
      {!read.isFetching && read.isError && <MessageBar intent="error"><MessageBarBody>{errorMessage(read.error, t)}</MessageBarBody></MessageBar>}
      {result ? <Results mode={mode} result={result} items={items ?? []} until={until} /> : items && <>
        <Text block>{applicable.length > 0
          ? t(mode === 'hide' ? 'alerts.bulk.hide.intro' : 'alerts.bulk.show.intro', { count: applicable.length })
          : t(mode === 'hide' ? 'alerts.bulk.hide.none' : 'alerts.bulk.show.none')}</Text>
        {left.length > 0 && <section>
          <h3 className={styles.heading}>{t('alerts.bulk.leftHeading', { count: left.reduce((sum, [, count]) => sum + count, 0) })}</h3>
          <ul className={styles.lines}>{left.map(([key, count]) => <li key={key}>
            {t('alerts.bulk.leftReason', { count, reason: t(`alerts.bulk.left.${key}`) })}</li>)}</ul>
        </section>}
        {mode === 'hide' && applicable.length > 0 && <>
          {/* What hiding leaves alone, said only of what is chosen: an alert stays open at its source, a gap's check goes on. */}
          <Text block className={styles.muted}>{[applicable.some((item) => item.rule === null) && t('alerts.bulk.hide.sourceStays'),
            applicable.some((item) => item.rule !== null) && t('alerts.bulk.hide.gapStays')].filter(Boolean).join(' ')}</Text>
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
          <Field required label={t('alerts.hide.reason')} hint={t('alerts.bulk.hide.reasonHint')}
            validationMessage={touched && !reasonOk ? t('alerts.bulk.hide.reasonRequired') : undefined}>
            <Textarea ref={reasonField} value={reason} maxLength={reasonLength} disabled={busy} resize="vertical" onChange={(_, d) => setReason(d.value)} />
          </Field>
          {dayOk && <Text block role="status" className={styles.muted}>{t('alerts.bulk.hide.summary', { count: applicable.length, date: formatDate(until) })}</Text>}
        </>}
        {mode === 'show' && applicable.length > 0 && <Text block className={styles.muted}>{t('alerts.bulk.show.history')}</Text>}
      </>}
      {error && <MessageBar intent="error" layout="multiline"><MessageBarBody role="alert">{error}</MessageBarBody></MessageBar>}
    </DialogContent>
    <DialogActions>
      {result
        ? <Button ref={closeRef} appearance="primary" onClick={() => onClose(applied, done.current)}>{t('common.close')}</Button>
        : <>
          <Button ref={cancelRef} disabled={busy} onClick={() => onClose(false)}>{t('common.cancel')}</Button>
          {applicable.length > 0 && <Button appearance="primary" type="submit" disabledFocusable={busy}>
            {busy ? t(mode === 'hide' ? 'alerts.hide.hiding' : 'alerts.bulk.show.showing')
              : t(mode === 'hide' ? 'alerts.bulk.hide.confirm' : 'alerts.bulk.show.confirm', { count: applicable.length })}</Button>}
        </>}
    </DialogActions>
  </DialogBody>
  {/* Nested in the surface, so the form is the active dialog again once the question closes. */}
  <ConfirmDialog open={asking} title={t('alerts.hide.discardTitle')} confirm={t('alerts.hide.discard')} cancel={t('alerts.hide.keepEditing')}
    onConfirm={() => onClose(false)} onCancel={keepEditing}>{t('alerts.bulk.hide.discardBody')}</ConfirmDialog>
  </form></DialogSurface></Dialog>;
}

/** What the change did: how many it changed, and each alert it left as it was, with why. */
function Results({ mode, result, items, until }: { mode: 'hide' | 'show'; result: AlertBulkResult; items: readonly AlertSelectionItem[]; until: string }) {
  const { t } = useTranslation(); const styles = useStyles();
  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const leftId = useId();
  const left = result.items.filter((item) => item.outcome !== 'Hidden' && item.outcome !== 'Shown')
    .sort((a, b) => leftOrder.indexOf(a.outcome) - leftOrder.indexOf(b.outcome));
  return <div className={styles.content}>
    <Text block weight="semibold" role="status">{t(mode === 'hide' ? 'alerts.bulk.hide.applied' : 'alerts.bulk.show.applied',
      { count: result.applied, date: formatDate(until) })}</Text>
    <h3 id={leftId} className={styles.heading}>{t('alerts.bulk.leftHeading', { count: left.length })}</h3>
    <ul className={styles.items} aria-labelledby={leftId}>
      {left.map((item) => {
        const alert = byId.get(item.id);
        return <li key={item.id} className={styles.item}>
          <Text block className={styles.name}>{alert ? alertTitle(t, alert) : t('alerts.detail.notFound')}</Text>
          <Text block className={styles.muted}>{[alert?.organizationName, t(`alerts.bulk.outcomes.${item.outcome}`)].filter(Boolean).join(' · ')}</Text>
        </li>;
      })}
    </ul>
  </div>;
}
