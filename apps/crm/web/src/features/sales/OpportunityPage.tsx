import { useState } from 'react';
import { useParams } from 'react-router';
import {
  Badge,
  Button,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Spinner,
  Text,
  makeStyles,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Edit20Regular, Money16Regular, MoreHorizontal20Regular, Target16Regular } from '@fluentui/react-icons';
import { h } from '../../app/hearth';
import { useTranslation } from 'react-i18next';
import { CustomFieldsPanel } from '../customfields/CustomFieldsPanel';
import { ApiError } from '../../api/client';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { DetailList, Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatDateTime, formatMoney } from '../../shared/utils/format';
import { ActivityTimeline } from '../activities/ActivityTimeline';
import { NotFoundPage } from '../errors/NotFoundPage';
import { NextStep } from './NextStep';
import { QuotesPanel } from '../quotes/QuotesPanel';
import { useQuotes } from '../quotes/api';
import { useOpportunity, useOpportunityActions, useStages } from './api';
import { LoseDialog, OpportunityDialog } from './OpportunityDialog';

const useStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: '16px', alignItems: 'start' },
  stack: { display: 'flex', flexDirection: 'column', gap: '16px' },
  // The weighted forecast as the reference's "estimated payment" block: a soft ember well, the figure in display type.
  well: { display: 'grid', gap: '4px', marginBottom: '14px', paddingTop: '14px', paddingBottom: '14px', paddingLeft: '16px', paddingRight: '16px', borderRadius: '14px', backgroundColor: h.emberSoft },
  forecast: { fontFamily: h.display, fontSize: 'clamp(26px, 2.4vw, 34px)', lineHeight: 1.1, fontWeight: 600, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' },
  muted: { color: h.muted, fontSize: '13px' },
});

export function OpportunityPage() {
  const styles = useStyles();
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const notify = useNotify();
  const canWrite = useCan(Permissions.salesWrite);
  const canSeeMoney = useCan(Permissions.financeRead);
  const { data: opportunity, error, isPending, refetch } = useOpportunity(id);
  // The deal's quotes, the same read its quotes panel makes (one cached query): an accepted one has drafted a contract.
  const quotes = useQuotes({ opportunityId: id }, Boolean(id));
  const acceptedQuote = quotes.items.find((quote) => quote.status === 'Accepted');
  const stages = useStages();
  const actions = useOpportunityActions();
  const [editing, setEditing] = useState(false);
  const [losing, setLosing] = useState(false);
  const restoreFocusTarget = useRestoreFocusTarget();

  if (isPending) return <Spinner label={t('common.loading')} />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const wonStage = stages.data?.find((s) => s.isWon);
  const lostStage = stages.data?.find((s) => s.isLost);
  const openStages = (stages.data ?? []).filter((s) => !s.isWon && !s.isLost);

  const move = async (stageId: string, label: string) => {
    try {
      await actions.move.mutateAsync({ id: opportunity.id, stageId });
      notify(label);
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  const reopen = async () => {
    try {
      await actions.reopen.mutateAsync(opportunity.id);
      notify(t('opportunities.reopened'));
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <>
      <PageHeader
        back={{ to: '/pipeline', label: t('opportunities.title') }}
        title={opportunity.name}
        meta={
          <>
            <Badge appearance="tint" color={opportunity.status === 'Won' ? 'success' : opportunity.status === 'Lost' ? 'subtle' : 'brand'}>
              {opportunity.status === 'Open' ? opportunity.stageName : t(`opportunities.statuses.${opportunity.status}`)}
            </Badge>
            <AppLink to={`/organizations/${opportunity.organization.id}`}>{opportunity.organization.name}</AppLink>
            {opportunity.isStale && (
              <Badge appearance="tint" color="warning">
                {t('opportunities.stale')}
              </Badge>
            )}
          </>
        }
        actions={
          canWrite && (
            <>
              {opportunity.status === 'Open' ? (
                <>
                  <Button {...restoreFocusTarget} icon={<Edit20Regular />} onClick={() => setEditing(true)}>
                    {t('common.edit')}
                  </Button>
                  <Menu>
                    <MenuTrigger disableButtonEnhancement>
                      <Button {...restoreFocusTarget} icon={<MoreHorizontal20Regular />} aria-label={t('opportunities.more')} />
                    </MenuTrigger>
                    <MenuPopover>
                      <MenuList>
                        {openStages.filter((s) => s.id !== opportunity.stageId).map((stage) => (
                          <MenuItem key={stage.id} onClick={() => void move(stage.id, t('opportunities.moved', { stage: stage.name }))}>
                            {t('opportunities.moveTo', { stage: stage.name })}
                          </MenuItem>
                        ))}
                        {lostStage && <MenuItem onClick={() => setLosing(true)}>{t('opportunities.markLost')}</MenuItem>}
                      </MenuList>
                    </MenuPopover>
                  </Menu>
                  {wonStage && (
                    <Button appearance="primary" onClick={() => void move(wonStage.id, t('opportunities.won'))}>
                      {t('opportunities.markWon')}
                    </Button>
                  )}
                </>
              ) : (
                <>
                  <Button onClick={() => void reopen()}>{t('opportunities.reopen')}</Button>
                  {/* An accepted quote has already drafted its contract (QuoteAcceptedHandler): that draft is the next step, not a
                      blank contract that would duplicate it. */}
                  {opportunity.status === 'Won' && (acceptedQuote ? (
                    <Button as="a" href={`/contracts?search=${encodeURIComponent(acceptedQuote.title)}`} appearance="primary">
                      {t('opportunities.openDraftContract')}
                    </Button>
                  ) : (
                    <Button as="a" href={`/contracts/new?organizationId=${opportunity.organization.id}`} appearance="primary">
                      {t('opportunities.createContract')}
                    </Button>
                  ))}
                </>
              )}
            </>
          )
        }
      />

      <div className={styles.stack}>
        <div className={styles.grid}>
          {opportunity.status === 'Open' && <NextStep organizationId={opportunity.organization.id} opportunityId={opportunity.id} />}
          {canSeeMoney && (
            <Panel title={t('opportunities.fields.forecast')} icon={<Money16Regular />}>
              <div className={styles.well}>
                <div className={styles.forecast}>{formatMoney(opportunity.forecastAmount ?? 0)}</div>
                <Text className={styles.muted}>{t('opportunities.forecastExplainer', { probability: opportunity.probability })}</Text>
              </div>
              <DetailList
                items={[
                  { label: t('opportunities.fields.oneOffAmount'), value: formatMoney(opportunity.oneOffAmount ?? 0) },
                  { label: t('opportunities.fields.mrr'), value: formatMoney(opportunity.mrr ?? 0) },
                  { label: t('opportunities.fields.termMonths'), value: String(opportunity.termMonths) },
                ]}
              />
            </Panel>
          )}
          <Panel title={t('opportunities.sections.deal')} icon={<Target16Regular />}>
            <DetailList
              items={[
                {
                  label: t('opportunities.fields.stage'),
                  value: opportunity.status === 'Open' ? `${opportunity.stageName} · ${opportunity.probability} %` : t(`opportunities.statuses.${opportunity.status}`),
                },
                { label: t('opportunities.fields.businessLine'), value: t(`opportunities.businessLines.${opportunity.businessLine}`) },
                { label: t('opportunities.fields.expectedCloseDate'), value: formatDate(opportunity.expectedCloseDate) },
                { label: t('opportunities.fields.owner'), value: opportunity.owner?.name },
                { label: t('opportunities.fields.source'), value: opportunity.source },
                { label: t('opportunities.fields.competitor'), value: opportunity.competitor },
                { label: t('opportunities.fields.contact'), value: opportunity.contactName },
                ...(opportunity.lostReason ? [{ label: t('opportunities.fields.lostReason'), value: opportunity.lostReason }] : []),
                ...(opportunity.closedOn ? [{ label: t('opportunities.fields.closedOn'), value: formatDate(opportunity.closedOn) }] : []),
                { label: t('opportunities.fields.lastActivity'), value: formatDateTime(opportunity.lastActivityAt) },
              ]}
            />
          </Panel>
          <CustomFieldsPanel framed entity="Opportunity" entityId={opportunity.id} />
        </div>

        <QuotesPanel
          organizationId={opportunity.organization.id}
          organizationName={opportunity.organization.name}
          opportunityId={opportunity.id}
        />

        <ActivityTimeline organizationId={opportunity.organization.id} opportunityId={opportunity.id} />
      </div>

      <OpportunityDialog open={editing} onClose={() => setEditing(false)} opportunity={opportunity} />
      <LoseDialog open={losing} opportunity={opportunity} stageId={lostStage?.id ?? ''} onClose={() => setLosing(false)} />
    </>
  );
}
