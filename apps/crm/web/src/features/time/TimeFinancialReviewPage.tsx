import { useCallback, useState } from 'react';
import { Button, MessageBar, MessageBarBody, Spinner, Text, makeStyles, tokens } from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import { useCurrentUser } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { DetailList, Panel } from '../../shared/components/Panel';
import { formatDate, formatDateTime, formatNumber } from '../../shared/utils/format';
import { NotFoundPage } from '../errors/NotFoundPage';
import { financialReviewPermissions } from './financialReviewAccess';
import { parseFinancialReview, type FinancialReview } from './financialReviewContract';

const useStyles = makeStyles({
  content: { display: 'grid', gap: tokens.spacingVerticalL },
  cards: { padding: 0, listStyle: 'none', display: 'grid', gap: tokens.spacingVerticalM,
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))' },
  card: { padding: tokens.spacingHorizontalM, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    display: 'grid', gap: tokens.spacingVerticalS, overflowWrap: 'anywhere', minWidth: 0 },
  findings: { display: 'grid', gap: tokens.spacingVerticalS, padding: 0, listStyle: 'none' },
});

export function TimeFinancialReviewPage() {
  const { t } = useTranslation();
  const user = useCurrentUser();
  const { id = '' } = useParams();
  if (!financialReviewPermissions.every(p => user.permissions.includes(p))) return <>
    <PageHeader title={t('financialReview.title')} /><Text role="status">{t('financialReview.noAccess')}</Text>
  </>;
  return <AuthorizedReview key={`${user.id}:${id}`} id={id.toLowerCase()} />;
}

function AuthorizedReview({ id }: { id: string }) {
  const { t } = useTranslation(); const user = useCurrentUser(); const styles = useStyles();
  const [refreshing, setRefreshing] = useState(false);
  const query = useQuery({
    queryKey: ['time', 'financial-review', user.id, id],
    queryFn: async ({ signal }) => parseFinancialReview((await api.get<unknown>(`/api/v1/time/entries/${encodeURIComponent(id)}/financial-review`, signal)).data, id),
    retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: 'always',
  });
  const { refetch } = query;
  const refresh = useCallback(() => { setRefreshing(true); void refetch().finally(() => setRefreshing(false)); }, [refetch]);
  const checking = refreshing || query.isFetching;
  const report = !checking && !query.isError ? query.data : undefined;
  if (!checking && query.error instanceof ApiError && query.error.status === 404) return <NotFoundPage />;
  const date = report?.workDate.split('-');
  return <>
    <PageHeader title={t('financialReview.title')}
      back={{ to: date ? `/time/entries?year=${date[0]}&month=${Number(date[1])}` : '/time/entries', label: t('time.title') }}
      actions={<Button disabled={checking} disabledFocusable={checking} onClick={refresh}>{t('financialReview.refresh')}</Button>} />
    <p>{t('financialReview.scope')}</p>
    {checking && <Spinner label={t('common.loading')} />}
    {!checking && query.isError && <ErrorState error={query.error} onRetry={refresh} />}
    {report && <div className={styles.content}>
      <Text>{t('financialReview.checkedAt', { at: formatDateTime(report.checkedAt) })}</Text>
      <Panel title={t('financialReview.entry')}>
        <DetailList items={[
          { label: t('time.fields.organization'), value: <AppLink to={`/organizations/${report.organizationId}`}>{report.organizationName ?? t('financialReview.unknownCustomer')}</AppLink> },
          { label: t('time.fields.workDate'), value: formatDate(report.workDate) },
          { label: t('time.fields.hours'), value: formatNumber(report.hours) },
          { label: t('time.fields.status'), value: t(`time.statuses.${report.status}`) },
          { label: t('financialReview.approval'), value: String(report.approvalCount) },
        ]} />
        {report.reviewNote && <p>{report.reviewNote}</p>}
      </Panel>
      <Panel title={t('financialReview.findingsTitle')}>
        <Text role="status">{t(report.requiresReview ? 'financialReview.needsReview' : 'financialReview.noDiscrepancy')}</Text>
        <ul className={styles.findings}>
          {report.findings.map(f => <li key={f.code}><MessageBar layout="multiline" intent={f.level === 'Review' ? 'warning' : 'info'}>
            <MessageBarBody>{t(`financialReview.findings.${f.code}`)}</MessageBarBody>
          </MessageBar></li>)}
        </ul>
      </Panel>
      <ReviewSources report={report} />
    </div>}
  </>;
}

function ReviewSources({ report }: { report: FinancialReview }) {
  const { t } = useTranslation(); const styles = useStyles();
  return <>
    <Panel title={t('financialReview.banks')}>
      {report.banks.length === 0 && <Text>{t('financialReview.noBanks')}</Text>}
      <ul className={styles.cards}>
        {report.banks.map(bank => <li key={bank.bankId} className={styles.card}>
          {bank.available ? <AppLink to={`/contracts/hour-banks/${bank.bankId}`}>{bank.name}</AppLink> : <Text>{bank.name ?? t('financialReview.unavailableBank')}</Text>}
          <Text>{t(`financialReview.bankStates.${bank.state}`)}</Text>
          <DetailList items={[
            { label: t('financialReview.allocated'), value: formatNumber(bank.allocatedHours) },
            { label: t('financialReview.actual'), value: formatNumber(bank.netHours) },
            { label: t('financialReview.returned'), value: formatNumber(bank.returnedHours) },
            { label: t('financialReview.receipts'), value: String(bank.receipts) },
          ]} />
        </li>)}
      </ul>
    </Panel>
    <Panel title={t('financialReview.billing')}>
      {report.billing.length === 0 && <Text>{t('financialReview.noBilling')}</Text>}
      <ul className={styles.cards}>
        {report.billing.map(basis => <li key={basis.basisId} className={styles.card}>
          <AppLink to={`/billing/bases/${basis.basisId}`}>{t('financialReview.openBilling')}</AppLink>
          <Text>{t(basis.exported ? 'financialReview.exported' : 'financialReview.protected')}</Text>
          <Text>{t(basis.proven && basis.currentRevision ? 'financialReview.versionMatches' : 'financialReview.versionDiffers')}</Text>
          <Text>{t('financialReview.matchingParts', { count: basis.matchedAllocations })}</Text>
        </li>)}
      </ul>
    </Panel>
  </>;
}
