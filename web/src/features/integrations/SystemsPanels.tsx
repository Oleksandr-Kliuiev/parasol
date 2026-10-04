import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Badge,
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
  type BadgeProps,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import type { OutboundStatus } from '../../api/types';
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
  cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: tokens.spacingHorizontalM },
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
  error: { color: tokens.colorPaletteRedForeground1, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere' },
});

const statusColor: Record<OutboundStatus, BadgeProps['color']> = {
  Pending: 'informative',
  Succeeded: 'success',
  Failed: 'danger',
  DeadLetter: 'danger',
  Cancelled: 'subtle',
};

export function SystemsPanel() {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const navigate = useNavigate();
  const status = useIntegrationStatus();
  const actions = useIntegrationActions();

  const pause = async (system: string, paused: boolean) => {
    try {
      const reason = paused ? (globalThis.prompt(t('systemsPanel.pauseReason')) ?? undefined) : undefined;
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
                <Badge appearance="tint" color={s.enabled ? 'success' : 'subtle'}>
                  {s.enabled ? t('systemsPanel.enabled') : t('systemsPanel.disabled')}
                </Badge>
                {s.paused && (
                  <Badge appearance="outline" color="warning">
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
      {outbound.error ? (
        <ErrorState error={outbound.error} onRetry={() => void outbound.refetch()} />
      ) : outbound.isSuccess && outbound.items.length === 0 ? (
        <EmptyState message={t('outbound.empty')} />
      ) : (
        <div className={styles.tableWrap}>
          <Table size="small" aria-label={t('outbound.title')}>
            <TableHeader>
              <TableRow>
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
                  <TableCell className="tabular">{formatDateTime(o.createdAt)}</TableCell>
                  <TableCell>
                    {systemName(t, o.system)} · {t(`outbound.operations.${o.operation}`, { defaultValue: o.operation })}
                  </TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={statusColor[o.status]}>
                      {t(`outbound.status.${o.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="tabular">{o.attempts}</TableCell>
                  <TableCell>{o.lastError ? <span className={styles.error}>{o.lastError}</span> : <span className={styles.muted}>{o.result}</span>}</TableCell>
                  <TableCell>
                    {(o.status === 'Failed' || o.status === 'DeadLetter') && (
                      <Button size="small" onClick={() => void act(() => actions.retry.mutateAsync(o.id))}>
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
    </Panel>
  );
}
