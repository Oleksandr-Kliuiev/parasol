import { useId, useRef, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import {
  Badge,
  Checkbox,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Field,
  Textarea,
  MessageBar,
  MessageBarBody,
  Button,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  mergeClasses,
  tokens,
  useRestoreFocusTarget,
  type BadgeProps,
} from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import {
  ArrowSync16Regular,
  ArrowSync24Regular,
  Building20Regular,
  Cloud20Regular,
  DesktopPulse20Regular,
  PeopleTeam20Regular,
  PlugConnected20Regular,
  Receipt20Regular,
} from '@fluentui/react-icons';
import { ScrollRegion } from '../admin/ScrollRegion';
import { useTranslation } from 'react-i18next';
import { cardSurface, h, type Tone } from '../../app/hearth';
import { IconChip, useSettingsStyles } from '../admin/settingsUi';
import { useTableCardStyles } from '../admin/tableCard';
import { useDialogStyles } from '../contracts/dialogStyles';
import { ApiError } from '../../api/client';
import { useBulkOutboundRetry, type OperationResult } from './monitoringApi';
import type { OutboundOperation } from '../../api/types';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { ListFooter } from '../../shared/components/ListFooter';
import { FactGrid, Panel } from '../../shared/components/Panel';
import { useKeptWhileClosing } from '../../shared/components/useKeptWhileClosing';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDateTime, formatNumber } from '../../shared/utils/format';
import { useConnectionTestAnswer, useIntegrationActions, useIntegrationStatus, useOutbound } from './api';
import { systemName } from './labels';

const useStyles = makeStyles({
  section: { display: 'grid', gap: '14px', minWidth: 0 },
  // Cards of a row share their height, so the action footers line up.
  cards: { alignItems: 'stretch' },
  sectionTitle: { margin: 0, fontFamily: h.display, fontSize: '18px', lineHeight: '24px', fontWeight: 600, letterSpacing: '-0.01em' },
  // One card per system, as on the integration cards of the reference: chip and status, name, figures, then actions.
  card: {
    ...cardSurface,
    display: 'grid',
    gridTemplateRows: 'auto auto 1fr auto',
    gap: '12px',
    minWidth: 0,
    // 16 px sides: the three footer actions fit one line in a card of the three-column grid.
    paddingTop: '20px',
    paddingBottom: '16px',
    paddingLeft: '16px',
    paddingRight: '16px',
  },
  top: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', minWidth: 0 },
  name: { margin: 0, fontFamily: h.display, fontSize: '16px', lineHeight: '22px', fontWeight: 600, letterSpacing: '-0.01em', overflowWrap: 'anywhere' },
  body: { display: 'grid', alignContent: 'start', gap: '10px', minWidth: 0 },
  footer: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '4px',
    marginTop: '4px',
    paddingTop: '12px',
    borderTop: `1px solid ${h.line}`,
  },
  // The quiet actions of the foot keep a narrower padding, so all three fit one line of a three-column card.
  footAction: { paddingLeft: '9px', paddingRight: '9px' },
  facts: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px', overflowWrap: 'anywhere' },
  error: { color: tokens.colorPaletteRedForeground1, fontSize: '13px', lineHeight: '18px', overflowWrap: 'anywhere' },
  toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', marginBottom: '12px' },
  results: { margin: '0 0 12px', paddingLeft: '18px', fontSize: '13px', lineHeight: '20px' },
});

/** A chip per system: its own tone while connected, neutral while it is not configured. */
const systemLook: Record<string, { icon: ReactElement; tone: Tone }> = {
  atera: { icon: <DesktopPulse20Regular />, tone: 'iris' },
  poweroffice: { icon: <Receipt20Regular />, tone: 'spruce' },
  partnercenter: { icon: <Cloud20Regular />, tone: 'saffron' },
  'microsoft-graph': { icon: <PeopleTeam20Regular />, tone: 'iris' },
  brreg: { icon: <Building20Regular />, tone: 'ember' },
};

export function SystemsPanel() {
  const styles = useStyles();
  const settings = useSettingsStyles();
  const headingId = useId();
  const { t } = useTranslation();
  const notify = useNotify();
  const navigate = useNavigate();
  const status = useIntegrationStatus();
  const actions = useIntegrationActions();
  const restoreFocusTarget = useRestoreFocusTarget();

  // A pause needs a reason, asked for in the dialog below; resuming needs none. The system stays set while the dialog
  // leaves, so its content does not collapse during the exit motion.
  const [pausing, setPausing] = useState({ system: '', open: false });
  const openPause = (system: string) => {
    actions.pause.reset();
    setPausing({ system, open: true });
  };
  // Only the answer says whether the integration is paused, so the dialog waits for it.
  const closePause = () => {
    if (!actions.pause.isPending) setPausing((current) => ({ ...current, open: false }));
  };
  const pause = async (system: string, reason: string) => {
    try {
      await actions.pause.mutateAsync({ system, paused: true, reason });
      setPausing((current) => ({ ...current, open: false }));
      notify(t('systemsPanel.pausedNotice'));
    } catch {
      // The dialog shows the error above the reason, which can be sent again.
    }
  };
  const resume = async (system: string) => {
    try {
      await actions.pause.mutateAsync({ system, paused: false });
      notify(t('systemsPanel.resumedNotice'));
    } catch (error) {
      notify(t('errors.generic'), 'error', errorMessage(error, t));
    }
  };

  // The worker runs the test (it alone has the provider credentials); the answer is asked for until it comes.
  const [pending, setPending] = useState<{ system: string; id: string } | null>(null);
  useConnectionTestAnswer(pending, (result) => {
    setPending(null);
    if (result) notify(result.message ?? '', result.success ? 'success' : 'error');
    else notify(t('systemsPanel.testNoAnswer'), 'warning');
  });

  const test = async (system: string) => {
    try {
      const result = await actions.test.mutateAsync(system);
      if (result.status === 'Running' && result.id) {
        setPending({ system, id: result.id });
      } else {
        notify(result.message ?? '', result.success ? 'success' : 'error');
      }
    } catch (error) {
      notify(t('errors.generic'), 'error', errorMessage(error, t));
    }
  };

  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.sectionTitle}>{t('systemsPanel.title')}</h2>
      {status.error ? (
        <ErrorState error={status.error} onRetry={() => void status.refetch()} />
      ) : (
        <div className={mergeClasses(settings.cards, styles.cards)}>
          {status.data?.map((s) => {
            const look = systemLook[s.system] ?? { icon: <PlugConnected20Regular />, tone: 'neutral' as Tone };
            return (
              <section key={s.system} className={styles.card} aria-label={systemName(t, s.system)}>
                <div className={styles.top}>
                  <IconChip icon={look.icon} tone={s.enabled ? look.tone : 'neutral'} />
                  <span className={settings.pills}>
                    <Badge appearance="tint" color={s.enabled ? 'success' : 'subtle'}>
                      {s.enabled ? t('systemsPanel.enabled') : t('systemsPanel.disabled')}
                    </Badge>
                    {s.paused && (
                      <Badge appearance="tint" color="warning">
                        {t('systemsPanel.paused')}
                      </Badge>
                    )}
                  </span>
                </div>
                <h3 className={styles.name}>{systemName(t, s.system)}</h3>
                <div className={styles.body}>
                  {/* The counts as tiles; their labels are the generic "Records" and "Not linked" of the record and mapping screens. */}
                  <FactGrid
                    className={styles.facts}
                    items={[
                      { label: t('recordAccess.records'), value: formatNumber(s.records, 0) },
                      { label: t('mappings.state.Unlinked'), value: formatNumber(s.unlinked, 0) },
                    ]}
                  />
                  <span className={s.failedOutbound > 0 ? styles.error : styles.muted}>
                    {t('systemsPanel.outbound', { pending: s.pendingOutbound, failed: s.failedOutbound })}
                  </span>
                  {/* Why "Test connection" cannot be used: the provider is not set up on this instance. */}
                  {!s.enabled && <span className={styles.muted}>{t('systemsPanel.notConfiguredHint')}</span>}
                  {s.paused && (
                    <span className={styles.muted}>
                      {t('systemsPanel.pausedBy', { who: s.pausedBy ?? '—', at: s.pausedAt ? formatDateTime(s.pausedAt) : '—' })}
                      {s.pauseReason ? ` · ${s.pauseReason}` : ''}
                    </span>
                  )}
                </div>
                <div className={styles.footer}>
                  <Button size="small" onClick={() => void test(s.system)} disabled={!s.enabled || actions.test.isPending || pending !== null}>
                    {pending?.system === s.system ? t('systemsPanel.testing') : t('systemsPanel.test')}
                  </Button>
                  <Button size="small" appearance="subtle" className={styles.footAction} onClick={() => navigate(`/admin/mappings?system=${s.system}`)}>
                    {t('systemsPanel.openMappings')}
                  </Button>
                  {/* Runbook 05: hold a misbehaving integration without a deploy. */}
                  <Button
                    {...restoreFocusTarget}
                    size="small"
                    appearance="subtle"
                    className={styles.footAction}
                    onClick={() => (s.paused ? void resume(s.system) : openPause(s.system))}
                    disabled={actions.pause.isPending}
                  >
                    {s.paused ? t('systemsPanel.resume') : t('systemsPanel.pause')}
                  </Button>
                </div>
              </section>
            );
          })}
        </div>
      )}
      <Dialog open={pausing.open} onOpenChange={(_, data) => !data.open && closePause()}>
        <DialogSurface>
          {pausing.system && (
            <PauseForm
              system={pausing.system}
              busy={actions.pause.isPending}
              error={actions.pause.error}
              onPause={(reason) => void pause(pausing.system, reason)}
              onCancel={closePause}
            />
          )}
        </DialogSurface>
      </Dialog>
    </section>
  );
}

/** Runbook 05: the reason goes in the log and on the card, so the integration is never paused without one. */
function PauseForm({ system, busy, error, onPause, onCancel }: { system: string; busy: boolean; error: Error | null; onPause: (reason: string) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const dialog = useDialogStyles();
  const field = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const missing = reason.trim() === '';
  return (
    // The dialog says what is missing itself: without noValidate the browser's own bubble would answer the required field.
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        setTried(true);
        if (missing) field.current?.focus();
        else onPause(reason.trim());
      }}
    >
      <DialogBody>
        <DialogTitle>{t('systemsPanel.pauseTitle', { system: systemName(t, system) })}</DialogTitle>
        <DialogContent>
          {error && (
            <MessageBar intent="error" className={dialog.error}>
              <MessageBarBody>{errorMessage(error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <p className={dialog.lead}>{t('systemsPanel.pauseBody')}</p>
          {/* IntegrationSwitches.Reason holds 512 characters. */}
          <Field
            label={t('systemsPanel.pauseReason')}
            hint={t('systemsPanel.pauseReasonHint')}
            required
            validationMessage={tried && missing ? t('systemsPanel.pauseReasonRequired') : undefined}
          >
            <Textarea ref={field} value={reason} maxLength={512} resize="vertical" onChange={(_, d) => setReason(d.value)} />
          </Field>
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={onCancel}>{t('common.cancel')}</Button>
          {/* Busy, not gone: the button keeps focus while the request runs, and the spinner reads on the ember fill. */}
          <Button type="submit" appearance="primary" disabledFocusable={busy} icon={busy ? <Spinner size="tiny" appearance="inverted" /> : undefined}>
            {t('systemsPanel.pause')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}

const outboundColor: Record<string, BadgeProps['color']> = { Pending: 'informative', Succeeded: 'success', Failed: 'danger', DeadLetter: 'danger', Cancelled: 'subtle' };

export function OutboundPanel() {
  const styles = useStyles();
  const table = useTableCardStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const outbound = useOutbound();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<OutboundOperation[] | null>(null);
  const shown = useKeptWhileClosing(confirming);
  const restoreFocusTarget = useRestoreFocusTarget();
  const [results, setResults] = useState<OperationResult[]>([]);
  const retryable = outbound.items.filter((o) => o.status === 'Failed' || o.status === 'DeadLetter');
  const chosen = retryable.filter((o) => selected.has(o.id));
  const actions = useIntegrationActions();

  const act = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      notify(t('errors.generic'), 'error', errorMessage(error, t));
    }
  };

  return (
    <Panel title={t('outbound.title')} icon={<ArrowSync16Regular />}>
      {results.length > 0 && <ul className={styles.results} aria-label={t('monitoring.operationResults')} aria-live="polite">{results.map((r) => <li key={r.id}>{r.id}: {t(`monitoring.operationStatus.${r.status}`)}</li>)}</ul>}
      {/* The bulk retry belongs to rows that can be retried; without any, the list says so on its own. */}
      {retryable.length > 0 && (
        <div className={styles.toolbar}>
          <Button {...restoreFocusTarget} disabled={!chosen.length || chosen.length > 100} onClick={() => setConfirming(chosen)}>{t('monitoring.retrySelected', { count: chosen.length })}</Button>
          {!chosen.length && <span className={styles.muted}>{t('outbound.selectHint')}</span>}
        </div>
      )}
      {outbound.error ? (
        <ErrorState error={outbound.error} onRetry={() => void outbound.refetch()} />
      ) : outbound.isSuccess && outbound.items.length === 0 ? (
        <EmptyState message={t('outbound.empty')} icon={<ArrowSync24Regular />} />
      ) : (
        <ScrollRegion className={table.inset} label={t('outbound.title')}>
          <Table size="small" className={mergeClasses(table.min880, table.roomy)} aria-label={t('outbound.title')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell className={table.checkCol}><Checkbox aria-label={t('delivery.selectAll')} checked={chosen.length > 0 && chosen.length === Math.min(100, retryable.length)} onChange={(_, d) => setSelected(d.checked === true ? new Set(retryable.slice(0, 100).map((o) => o.id)) : new Set())} /></TableHeaderCell>
                <TableHeaderCell className={table.dateTimeCol}>{t('outbound.columns.created')}</TableHeaderCell>
                <TableHeaderCell>{t('outbound.columns.operation')}</TableHeaderCell>
                <TableHeaderCell>{t('outbound.columns.status')}</TableHeaderCell>
                <TableHeaderCell>{t('outbound.columns.attempts')}</TableHeaderCell>
                <TableHeaderCell>{t('outbound.columns.details')}</TableHeaderCell>
                <TableHeaderCell className={table.actionCol} aria-label={t('outbound.retry')} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {outbound.items.map((o) => (
                <TableRow key={o.id}>
                  <TableCell><Checkbox aria-label={t('monitoring.selectOperation', { id: o.id })} disabled={!retryable.includes(o) || (!selected.has(o.id) && chosen.length >= 100)} checked={selected.has(o.id) && retryable.includes(o)} onChange={(_, d) => setSelected((current) => { const next = new Set(current); if (d.checked) next.add(o.id); else next.delete(o.id); return next; })} /></TableCell>
                  <TableCell className={table.nowrap}>{formatDateTime(o.createdAt)}</TableCell>
                  <TableCell>
                    {systemName(t, o.system)} · {t(`outbound.operations.${o.operation}`, { defaultValue: o.operation })}
                  </TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={outboundColor[o.status] ?? 'subtle'}>
                      {t(`outbound.status.${o.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className={table.nowrap}>{o.attempts}</TableCell>
                  <TableCell>{o.lastError ? <span className={styles.error}>{o.lastError}</span> : <span className={styles.muted}>{o.result}</span>}</TableCell>
                  <TableCell>
                    {(o.status === 'Failed' || o.status === 'DeadLetter') && (
                      <Button {...restoreFocusTarget} size="small" onClick={() => setConfirming([o])}>
                        {t('outbound.retry')}
                      </Button>
                    )}
                    {o.status === 'Pending' && (
                      <Button size="small" appearance="subtle" onClick={() => void act(() => actions.cancel.mutateAsync(o.id))}>
                        {t('outbound.cancel')}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <ListFooter shown={outbound.items.length} total={outbound.total} hasMore={outbound.hasNextPage} loading={outbound.isFetchingNextPage} onMore={() => void outbound.fetchNextPage()} />
        </ScrollRegion>
      )}
      <Dialog open={confirming !== null} onOpenChange={(_, d) => !d.open && setConfirming(null)}><DialogSurface>{shown && <OutboundRetryForm operations={shown} onResults={setResults} onClose={(done) => { setConfirming(null); if (done) setSelected(new Set()); }} />}</DialogSurface></Dialog>
    </Panel>
  );
}

function OutboundRetryForm({ operations, onClose, onResults }: { operations: OutboundOperation[]; onClose: (done: boolean) => void; onResults: (items: OperationResult[]) => void }) {
  const { t } = useTranslation();
  const retry = useBulkOutboundRetry();
  const [reason, setReason] = useState('');
  const [results, setResults] = useState<OperationResult[]>([]);
  const submit = async () => {
    try {
      const result = await retry.mutateAsync({ messages: operations.map((o) => ({ id: o.id, etag: o.etag })), expected: operations.length, reason: reason.trim() });
      onResults(result.items); onClose(true);
    } catch (error) {
      if (error instanceof ApiError && Array.isArray(error.problem.items)) {
        const items = error.problem.items as OperationResult[];
        setResults(items); onResults(items);
      }
    }
  };
  return <form onSubmit={(event) => { event.preventDefault(); if (reason.trim().length >= 10 && !retry.isPending) void submit(); }}><DialogBody>
    <DialogTitle>{t('monitoring.retryTitle', { count: operations.length })}</DialogTitle>
    <DialogContent>
      {retry.error && <MessageBar intent="error"><MessageBarBody>{errorMessage(retry.error, t)}</MessageBarBody></MessageBar>}
      {results.length > 0 && <ul aria-label={t('monitoring.operationResults')} aria-live="polite">{results.map((r) => <li key={r.id}>{r.id}: {t(`monitoring.operationStatus.${r.status}`)}</li>)}</ul>}
      <p>{t('monitoring.retryHint')}</p>
      <ul aria-label={t('monitoring.exactSelection')}>{operations.map((o) => <li key={o.id}>{systemName(t, o.system)} / {o.id} · {t(`outbound.operations.${o.operation}`, { defaultValue: o.operation })} · {formatDateTime(o.createdAt)}</li>)}</ul>
      <Field required label={t('delivery.reason')} hint={t('delivery.reasonHint', { min: 10 })}><Textarea maxLength={500} value={reason} onChange={(_, d) => setReason(d.value)} /></Field>
    </DialogContent>
    <DialogActions><Button disabled={retry.isPending} onClick={() => onClose(false)}>{t('common.cancel')}</Button><Button type="submit" appearance="primary" disabled={reason.trim().length < 10 || retry.isPending}>{t('monitoring.retryConfirm', { count: operations.length })}</Button></DialogActions>
  </DialogBody></form>;
}
