import { useMemo, useState } from 'react';
import {
  Button,
  Checkbox,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  MessageBar,
  MessageBarBody,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Textarea,
  Badge,
  makeStyles,
  mergeClasses,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import { Send16Regular, Send24Regular } from '@fluentui/react-icons';
import { h } from '../../app/hearth';
import { useTableCardStyles } from '../admin/tableCard';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import type { OperationResult } from './monitoringApi';
import type { OutboxMessageItem } from '../../api/types';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { Panel } from '../../shared/components/Panel';
import { useKeptWhileClosing } from '../../shared/components/useKeptWhileClosing';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDateTime } from '../../shared/utils/format';
import { useIntegrationActions, useOutbox } from './api';
import { ScrollTable } from '../../shared/components/ScrollTable';

/** The server's limits (OutboxEndpoints): a replay names at most this many messages and says why in this many characters. */
export const MAX_REPLAY = 100;
export const MIN_REASON = 10;

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: '16px', minWidth: 0 },
  toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px' },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '18px', overflowWrap: 'anywhere' },
  note: { color: h.muted, fontSize: '13px', lineHeight: '20px', margin: 0, maxWidth: '90ch' },
  // The backlog per module: quiet lines in a well, read before the list.
  backlog: { margin: 0, paddingTop: '10px', paddingBottom: '10px', paddingLeft: '32px', paddingRight: '16px', borderRadius: '12px', backgroundColor: h.well, color: h.muted, fontSize: '13px', lineHeight: '20px' },
  results: { margin: 0, paddingLeft: '18px', fontSize: '13px', lineHeight: '20px' },
  error: { color: tokens.colorPaletteRedForeground1, fontSize: '13px', lineHeight: '18px', overflowWrap: 'anywhere' },
  cellLine: { display: 'block', marginTop: '4px' },
});

const key = (m: Pick<OutboxMessageItem, 'module' | 'id'>) => `${m.module}/${m.id}`;

/**
 * Domain events that could not be delivered (DEV-07): dead letters after ten attempts and quarantined messages. A replay
 * delivers the stored message unchanged to the handlers that are not done with it yet; it names the messages, says why,
 * and is confirmed with their number, which the server checks against what can be replayed at that moment.
 */
export function DeliveryPanel() {
  const styles = useStyles();
  const table = useTableCardStyles();
  const { t } = useTranslation();
  const outbox = useOutbox();
  const [results, setResults] = useState<OperationResult[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<OutboxMessageItem[] | null>(null);
  const shown = useKeptWhileClosing(confirming);
  const restoreFocusTarget = useRestoreFocusTarget();

  const items = useMemo(() => outbox.data?.items ?? [], [outbox.data]);
  const replayable = items.filter((m) => !m.replayRequested);
  const chosen = replayable.filter((m) => selected.has(key(m)));
  const waiting = (outbox.data?.counts ?? []).filter((c) => c.deadLetter + c.quarantined + c.pending + c.processing > 0);
  const allSelected = replayable.length > 0 && chosen.length === Math.min(replayable.length, MAX_REPLAY);
  // The list holds the newest messages only (DEV-12); the module counts above count every one, so say how many are listed.
  const stuck = (outbox.data?.counts ?? []).reduce((sum, c) => sum + c.deadLetter + c.quarantined, 0);

  const toggle = (message: OutboxMessageItem, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on && chosen.length < MAX_REPLAY) next.add(key(message));
      else next.delete(key(message));
      return next;
    });

  return (
    <Panel title={t('delivery.title')} icon={<Send16Regular />}>
      <div className={styles.stack}>
        <p className={styles.note}>{t('delivery.description')}</p>
        {results.length > 0 && <ul className={styles.results} aria-label={t('monitoring.operationResults')} aria-live="polite">{results.map((r) => <li key={`${r.module}/${r.id}`}>{r.module} / {r.id}: {t(`monitoring.operationStatus.${r.status}`)}</li>)}</ul>}
        {waiting.length > 0 && (
          <ul className={styles.backlog} aria-label={t('delivery.backlog')}>
            {waiting.map((c) => (
              <li key={c.module}>
                {t('delivery.counts', {
                  module: c.module,
                  deadLetters: t('delivery.deadLetters', { count: c.deadLetter }),
                  quarantined: c.quarantined,
                  pending: c.pending + c.processing,
                })}
              </li>
            ))}
          </ul>
        )}
        {outbox.error ? (
          <ErrorState error={outbox.error} onRetry={() => void outbox.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState message={t('delivery.empty')} icon={<Send24Regular />} />
        ) : (
          <>
            {replayable.length > 0 && (
              <div className={styles.toolbar}>
                <Button {...restoreFocusTarget} appearance="primary" disabled={chosen.length === 0 || chosen.length > MAX_REPLAY} onClick={() => setConfirming(chosen)}>
                  {t('delivery.replaySelected', { count: chosen.length })}
                </Button>
                {chosen.length === 0 && <Text className={styles.muted}>{t('delivery.selectHint')}</Text>}
                {chosen.length >= MAX_REPLAY && <Text className={styles.muted}>{t('delivery.limit', { max: MAX_REPLAY })}</Text>}
              </div>
            )}
            <ScrollTable className={table.inset}>
              <Table size="small" className={mergeClasses(table.min880, table.roomy)} aria-label={t('delivery.title')}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell className={table.checkCol}>
                      <Checkbox
                        aria-label={t('delivery.selectAll')}
                        checked={allSelected ? true : chosen.length > 0 ? 'mixed' : false}
                        disabled={replayable.length === 0}
                        onChange={(_, d) => setSelected(d.checked === true ? new Set(replayable.slice(0, MAX_REPLAY).map(key)) : new Set())}
                      />
                    </TableHeaderCell>
                    <TableHeaderCell className={table.dateTimeCol}>{t('delivery.columns.occurred')}</TableHeaderCell>
                    <TableHeaderCell>{t('delivery.columns.event')}</TableHeaderCell>
                    <TableHeaderCell>{t('delivery.columns.status')}</TableHeaderCell>
                    <TableHeaderCell>{t('delivery.columns.attempts')}</TableHeaderCell>
                    <TableHeaderCell>{t('delivery.columns.handlers')}</TableHeaderCell>
                    <TableHeaderCell>{t('delivery.columns.error')}</TableHeaderCell>
                    <TableHeaderCell className={table.actionCol} aria-label={t('delivery.replay')} />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((m) => (
                    <TableRow key={key(m)}>
                      <TableCell>
                        <Checkbox
                          aria-label={t('delivery.selectRow', { event: m.eventType, time: formatDateTime(m.occurredAt) })}
                          checked={selected.has(key(m)) && !m.replayRequested}
                          disabled={m.replayRequested || (!selected.has(key(m)) && chosen.length >= MAX_REPLAY)}
                          onChange={(_, d) => toggle(m, d.checked === true)}
                        />
                      </TableCell>
                      <TableCell className={table.nowrap}>{formatDateTime(m.occurredAt)}</TableCell>
                      <TableCell>
                        <Text weight="semibold">{m.eventType}</Text>
                        <Text block className={styles.muted}>
                          {m.module} · {t('delivery.fields', { fields: m.payloadFields.join(', ') || '—' })}
                        </Text>
                      </TableCell>
                      <TableCell>
                        <Badge appearance="tint" color={m.status === 'Quarantined' ? 'warning' : 'danger'}>{t(`delivery.status.${m.status}`)}</Badge>
                        {m.replays > 0 && <Text block className={mergeClasses(styles.muted, styles.cellLine)}>{t('delivery.replayed', { count: m.replays })}</Text>}
                      </TableCell>
                      <TableCell className={table.nowrap}>{m.attempts}</TableCell>
                      <TableCell className={styles.muted}>{m.deliveredHandlers.join(', ') || '—'}</TableCell>
                      <TableCell>{m.lastError ? <span className={styles.error}>{m.lastError}</span> : '—'}</TableCell>
                      <TableCell>
                        {m.replayRequested ? (
                          <Text className={styles.muted}>{t('delivery.requested')}</Text>
                        ) : (
                          <Button {...restoreFocusTarget} size="small" onClick={() => setConfirming([m])}>
                            {t('delivery.replay')}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollTable>
            {stuck > items.length && <Text className={styles.muted}>{t('delivery.newestShown', { shown: items.length, total: stuck })}</Text>}
          </>
        )}
      </div>
      <Dialog open={confirming !== null} onOpenChange={(_, d) => !d.open && setConfirming(null)}>
        <DialogSurface>
          {shown && (
            <ReplayForm
              messages={shown}
              onResults={setResults}
              onClose={(done) => {
                setConfirming(null);
                if (done) setSelected(new Set());
              }}
            />
          )}
        </DialogSurface>
      </Dialog>
    </Panel>
  );
}

function ReplayForm({ messages, onClose, onResults }: { messages: OutboxMessageItem[]; onClose: (done: boolean) => void; onResults: (results: OperationResult[]) => void }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const { replay } = useIntegrationActions();
  const [reason, setReason] = useState('');
  const [results, setResults] = useState<OperationResult[]>([]);
  const byType = Object.entries(
    messages.reduce<Record<string, number>>((counts, m) => ({ ...counts, [m.eventType]: (counts[m.eventType] ?? 0) + 1 }), {}),
  );
  const valid = reason.trim().length >= MIN_REASON;

  const submit = async () => {
    try {
      const result = await replay.mutateAsync({
        messages: messages.map((m) => ({ module: m.module, id: m.id, replays: m.replays })),
        reason: reason.trim(),
        expected: messages.length,
      });
      onResults(result.items ?? messages.map((m) => ({ id: m.id, module: m.module, status: 'Requested' })));
      notify(t('delivery.requestedNotice', { count: result.requested }), 'success');
      onClose(true);
    } catch (error) {
      if (error instanceof ApiError && Array.isArray(error.problem.items)) {
        const items = error.problem.items as OperationResult[];
        setResults(items); onResults(items);
      }
      // Shown in the dialog; the list reloads so the person can confirm what is there now.
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !replay.isPending) void submit();
      }}
    >
      <DialogBody>
        <DialogTitle>{t('delivery.confirmTitle', { count: messages.length })}</DialogTitle>
        <DialogContent>
          {replay.error && (
            <MessageBar intent="error" style={{ marginBottom: 12 }}>
              <MessageBarBody>{errorMessage(replay.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          {results.length > 0 && <ul aria-label={t('monitoring.operationResults')} aria-live="polite">{results.map((r) => <li key={`${r.module}/${r.id}`}>{r.module} / {r.id}: {t(`monitoring.operationStatus.${r.status}`)}</li>)}</ul>}
          <p style={{ marginTop: 0 }}>{t('delivery.confirmBody')}</p>
          <ul aria-label={t('delivery.confirmList')}>
            {byType.map(([type, count]) => (
              <li key={type}>{t('delivery.confirmLine', { type, count })}</li>
            ))}
          </ul>
          <ul aria-label={t('monitoring.exactSelection')}>{messages.map((m) => <li key={`${m.module}/${m.id}`}>{m.module} / {m.id} · {m.eventType} · {formatDateTime(m.occurredAt)}</li>)}</ul>
          <Field label={t('delivery.reason')} hint={t('delivery.reasonHint', { min: MIN_REASON })} required>
            <Textarea value={reason} maxLength={500} onChange={(_, d) => setReason(d.value)} />
          </Field>
        </DialogContent>
        <DialogActions>
          <Button disabled={replay.isPending} onClick={() => onClose(false)}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={!valid || replay.isPending}>
            {t('delivery.confirm', { count: messages.length })}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}
