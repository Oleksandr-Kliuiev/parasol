import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Badge,
  Checkbox,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Field, Textarea, MessageBar, MessageBarBody,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { useBulkOutboundRetry, type OperationResult } from './monitoringApi';
import type { OutboundOperation } from '../../api/types';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { ListFooter } from '../../shared/components/ListFooter';
import { Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDateTime } from '../../shared/utils/format';
import { useConnectionTestAnswer, useIntegrationActions, useIntegrationStatus, useOutbound } from './api';
import { systemName } from './labels';

const useStyles = makeStyles({
  cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))', gap: tokens.spacingHorizontalM },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: tokens.spacingHorizontalS },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  buttons: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalXS },
  tableWrap: { overflowX: 'auto' },
  table: { minWidth: '760px' },
  error: { color: tokens.colorPaletteRedForeground1, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere' },
});

export function SystemsPanel() {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const navigate = useNavigate();
  const status = useIntegrationStatus();
  const actions = useIntegrationActions();

  const pause = async (system: string, paused: boolean) => {
    try {
      const answer = paused ? globalThis.prompt(t('systemsPanel.pauseReason')) : undefined;
      if (answer === null) return;
      const reason = answer;
      await actions.pause.mutateAsync({ system, paused, reason });
      notify(paused ? t('systemsPanel.pausedNotice') : t('systemsPanel.resumedNotice'));
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
    <Panel title={t('systemsPanel.title')}>
      {status.error ? (
        <ErrorState error={status.error} onRetry={() => void status.refetch()} />
      ) : (
        <div className={styles.cards}>
          {status.data?.map((s) => (
            <section key={s.system} className={styles.card} aria-label={systemName(t, s.system)}>
              <div className={styles.header}>
                <Text weight="semibold">{systemName(t, s.system)}</Text>
                <Badge appearance="outline" color="informative">
                  {s.enabled ? t('systemsPanel.enabled') : t('systemsPanel.disabled')}
                </Badge>
                {s.paused && (
                  <Badge appearance="outline" color="informative">
                    {t('systemsPanel.paused')}
                  </Badge>
                )}
              </div>
              <span className={styles.muted}>
                {t('systemsPanel.records', { count: s.records })} · {t('systemsPanel.unlinked', { count: s.unlinked })}
              </span>
              <span className={styles.muted}>{t('systemsPanel.outbound', { pending: s.pendingOutbound, failed: s.failedOutbound })}</span>
              {s.paused && (
                <span className={styles.muted}>
                  {t('systemsPanel.pausedBy', { who: s.pausedBy ?? '—', at: s.pausedAt ? formatDateTime(s.pausedAt) : '—' })}
                  {s.pauseReason ? ` · ${s.pauseReason}` : ''}
                </span>
              )}
              <div className={styles.buttons}>
                <Button size="small" onClick={() => void test(s.system)} disabled={!s.enabled || actions.test.isPending || pending !== null}>
                  {pending?.system === s.system ? t('systemsPanel.testing') : t('systemsPanel.test')}
                </Button>
                <Button size="small" appearance="subtle" onClick={() => navigate(`/admin/mappings?system=${s.system}`)}>
                  {t('systemsPanel.openMappings')}
                </Button>
                {/* Runbook 05: hold a misbehaving integration without a deploy. */}
                <Button size="small" appearance="subtle" onClick={() => void pause(s.system, !s.paused)} disabled={actions.pause.isPending}>
                  {s.paused ? t('systemsPanel.resume') : t('systemsPanel.pause')}
                </Button>
              </div>
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function OutboundPanel() {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const outbound = useOutbound();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<OutboundOperation[] | null>(null);
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
    <Panel title={t('outbound.title')}>
      {results.length > 0 && <ul aria-label={t('monitoring.operationResults')} aria-live="polite">{results.map((r) => <li key={r.id}>{r.id}: {t(`monitoring.operationStatus.${r.status}`)}</li>)}</ul>}
      <Button disabled={!chosen.length || chosen.length > 100} onClick={() => setConfirming(chosen)}>{t('monitoring.retrySelected', { count: chosen.length })}</Button>
      {outbound.error ? (
        <ErrorState error={outbound.error} onRetry={() => void outbound.refetch()} />
      ) : outbound.isSuccess && outbound.items.length === 0 ? (
        <EmptyState message={t('outbound.empty')} />
      ) : (
        <div className={styles.tableWrap} tabIndex={0} role="region" aria-label={t('outbound.title')}>
          <Table size="small" className={styles.table} aria-label={t('outbound.title')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell><Checkbox aria-label={t('delivery.selectAll')} checked={chosen.length > 0 && chosen.length === Math.min(100, retryable.length)} onChange={(_, d) => setSelected(d.checked === true ? new Set(retryable.slice(0, 100).map((o) => o.id)) : new Set())} /></TableHeaderCell>
                <TableHeaderCell>{t('outbound.columns.created')}</TableHeaderCell>
                <TableHeaderCell>{t('outbound.columns.operation')}</TableHeaderCell>
                <TableHeaderCell>{t('outbound.columns.status')}</TableHeaderCell>
                <TableHeaderCell>{t('outbound.columns.attempts')}</TableHeaderCell>
                <TableHeaderCell>{t('outbound.columns.details')}</TableHeaderCell>
                <TableHeaderCell aria-label={t('outbound.retry')} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {outbound.items.map((o) => (
                <TableRow key={o.id}>
                  <TableCell><Checkbox aria-label={t('monitoring.selectOperation', { id: o.id })} disabled={!retryable.includes(o) || (!selected.has(o.id) && chosen.length >= 100)} checked={selected.has(o.id) && retryable.includes(o)} onChange={(_, d) => setSelected((current) => { const next = new Set(current); if (d.checked) next.add(o.id); else next.delete(o.id); return next; })} /></TableCell>
                  <TableCell className="tabular">{formatDateTime(o.createdAt)}</TableCell>
                  <TableCell>
                    {systemName(t, o.system)} · {t(`outbound.operations.${o.operation}`, { defaultValue: o.operation })}
                  </TableCell>
                  <TableCell>
                    <Badge appearance="outline" color="informative">
                      {t(`outbound.status.${o.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="tabular">{o.attempts}</TableCell>
                  <TableCell>{o.lastError ? <span className={styles.error}>{o.lastError}</span> : <span className={styles.muted}>{o.result}</span>}</TableCell>
                  <TableCell>
                    {(o.status === 'Failed' || o.status === 'DeadLetter') && (
                      <Button size="small" onClick={() => setConfirming([o])}>
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
        </div>
      )}
      <Dialog open={confirming !== null} onOpenChange={(_, d) => !d.open && setConfirming(null)}><DialogSurface>{confirming && <OutboundRetryForm operations={confirming} onResults={setResults} onClose={(done) => { setConfirming(null); if (done) setSelected(new Set()); }} />}</DialogSurface></Dialog>
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
