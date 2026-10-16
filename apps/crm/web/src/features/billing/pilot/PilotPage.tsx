import { useState } from 'react';
import { useParams } from 'react-router';
import { MessageBar, MessageBarBody, Spinner } from '@fluentui/react-components';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../../api/client';
import { Permissions, useCan } from '../../../auth/CurrentUserContext';
import { ErrorState } from '../../../shared/components/ErrorState';
import { PageHeader } from '../../../shared/components/PageHeader';
import { formatDateTime } from '../../../shared/utils/format';
import { NotFoundPage } from '../../errors/NotFoundPage';
import { billingKeys, useRun } from '../api';
import { monthLabel } from '../period';
import { pilotKeys, useOverview, type ComparisonResult, type SignoffResult } from './api';
import { ComparePanel } from './ComparePanel';
import { CompareResult } from './CompareResult';
import { HistoryPanel } from './HistoryPanel';
import { KpiPanel } from './KpiPanel';
import { usePilotStyles } from './styles';
import { ReadinessPanel } from './ReadinessPanel';
import { SignoffForm } from './SignoffForm';
import { TracePanel } from './TracePanel';

/**
 * Pilot reconciliation of one billing run (DEV-22): is a parallel month safe, the line-by-line trace, the independent calculation
 * against the run, Finance's sign-off of the result, and the process figures. Nothing here writes to a billing table.
 */
export function PilotPage() {
  const styles = usePilotStyles();
  const { t, i18n } = useTranslation();
  const { id = '' } = useParams();
  const client = useQueryClient();
  const canReconcile = useCan(Permissions.billingReconcile);
  const canSeeFinance = useCan(Permissions.financeRead);
  const { data: run, error, isPending, refetch } = useRun(id);
  const overview = useOverview(id);
  // The comparison made in this visit: the stored document has the lines the sign-off must explain.
  const [latest, setLatest] = useState<ComparisonResult | null>(null);
  const [signed, setSigned] = useState<{ comparisonId: string; result: SignoffResult } | null>(null);

  if (isPending) return <Spinner label={t('common.loading')} />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  if (!run) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const reload = () => {
    void refetch();
    void client.invalidateQueries({ queryKey: pilotKeys.overview(id) });
    void client.invalidateQueries({ queryKey: billingKeys.run(id) });
  };
  const signoffOfLatest = latest ? overview.data?.signoffs.find((s) => s.comparisonId === latest.comparison.comparisonId) : undefined;
  const canSign = canReconcile && latest !== null && signed?.comparisonId !== latest.comparison.comparisonId && !signoffOfLatest;

  return (
    <>
      <PageHeader
        back={{ to: `/billing/runs/${id}`, label: monthLabel(run.periodStart, i18n.language) }}
        title={t('pilot.title')}
        subtitle={t('pilot.subtitle', { month: monthLabel(run.periodStart, i18n.language) })}
      />
      <div className={styles.stack}>
        <ReadinessPanel period={run.periodStart.slice(0, 7)} />
        <TracePanel runId={id} />
        {canReconcile ? (
          <>
            <ComparePanel
              runId={id}
              onResult={(result) => {
                setLatest(result);
                setSigned(null);
              }}
            />
            {latest && <CompareResult result={latest} />}
            {canSign && (
              <SignoffForm
                key={latest.comparison.comparisonId}
                result={latest}
                overview={overview.data}
                run={{ etag: run.etag, contentRevision: run.contentRevision }}
                onSigned={(result) => setSigned({ comparisonId: latest.comparison.comparisonId, result })}
                onReload={reload}
              />
            )}
            {latest && !canSign && (signed || signoffOfLatest) && (
              <MessageBar intent="success" layout="multiline" role="status">
                <MessageBarBody>
                  {signoffOfLatest
                    ? t('pilot.signoff.doneBy', { name: signoffOfLatest.signedBy.name, at: formatDateTime(signoffOfLatest.signedAt) })
                    : t('pilot.signoff.doneYou', { at: formatDateTime(signed!.result.signedAt) })}
                </MessageBarBody>
              </MessageBar>
            )}
          </>
        ) : (
          <MessageBar intent="info">
            <MessageBarBody>{t('pilot.noReconcile')}</MessageBarBody>
          </MessageBar>
        )}
        <HistoryPanel runId={id} />
        {canSeeFinance && <KpiPanel />}
      </div>
    </>
  );
}
