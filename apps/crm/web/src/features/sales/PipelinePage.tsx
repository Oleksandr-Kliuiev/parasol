import { useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Badge,
  Button,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  SearchBox,
  Switch,
  Text,
  makeStyles,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Add20Regular, MoreHorizontal20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ListFooter } from '../../shared/components/ListFooter';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatMoney, formatNumber } from '../../shared/utils/format';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import { NARROW_SCREEN, useMediaQuery } from '../../shared/utils/useMediaQuery';
import { type OpportunityFilters, fetchOpportunityPage, useOpportunityActions, usePipeline, useStages } from './api';
import { LoseDialog, OpportunityDialog } from './OpportunityDialog';
import type { Opportunity } from './types';
import type { ReactNode } from 'react';
import { SavedViews } from '../../shared/views/SavedViews';

const useStyles = makeStyles({
  filters: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalM },
  search: { width: '280px', maxWidth: '100%', flexShrink: 0 },
  spacer: { flex: 1 },
  board: { display: 'flex', gap: tokens.spacingHorizontalM, overflowX: 'auto', paddingBottom: tokens.spacingVerticalM, alignItems: 'flex-start' },
  column: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minWidth: '260px',
    flex: '1 0 260px',
    padding: tokens.spacingHorizontalS,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  columnHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: tokens.spacingHorizontalS },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  cardHead: { display: 'flex', justifyContent: 'space-between', gap: tokens.spacingHorizontalS, alignItems: 'start' },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  amount: { fontVariantNumeric: 'tabular-nums', fontWeight: tokens.fontWeightSemibold },
  forecast: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  month: { display: 'flex', flexDirection: 'column' },
});

/** The deal board: one column per stage, with the weighted forecast per month (FR-SAL-02). */
export function PipelinePage() {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const notify = useNotify();
  const canWrite = useCan(Permissions.salesWrite);
  const canSeeMoney = useCan(Permissions.financeRead);
  const narrow = useMediaQuery(NARROW_SCREEN);
  const [params, setParams] = useSearchParams();
  const mine = params.get('mine') === 'true';
  const stale = params.get('stale') === 'true';
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search.trim());
  const filters: OpportunityFilters = { mine, stale, search: debounced };
  const { data, error, isPending, refetch, dataUpdatedAt } = usePipeline(filters);
  const stages = useStages();
  const actions = useOpportunityActions();
  const [dialog, setDialog] = useState<{ stageId?: string; opportunity?: Opportunity } | null>(null);
  const [losing, setLosing] = useState<Opportunity | null>(null);
  const restoreFocusTarget = useRestoreFocusTarget();
  const wonStage = stages.data?.find((s) => s.isWon);
  const lostStage = stages.data?.find((s) => s.isLost);

  const card = (opportunity: Opportunity) => (
    <div key={opportunity.id} className={styles.card}>
      <div className={styles.cardHead}>
        <AppLink to={`/sales/opportunities/${opportunity.id}`}>{opportunity.name}</AppLink>
        {canWrite && (
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button
                {...restoreFocusTarget}
                size="small"
                appearance="subtle"
                icon={<MoreHorizontal20Regular />}
                aria-label={t('opportunities.actionsFor', { name: opportunity.name })}
              />
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {(stages.data ?? []).filter((s) => !s.isWon && !s.isLost && s.id !== opportunity.stageId).map((stage) => (
                  <MenuItem key={stage.id} onClick={() => void move(opportunity, stage.id, t('opportunities.moved', { stage: stage.name }))}>
                    {t('opportunities.moveTo', { stage: stage.name })}
                  </MenuItem>
                ))}
                {wonStage && <MenuItem onClick={() => void move(opportunity, wonStage.id, t('opportunities.won'))}>{t('opportunities.markWon')}</MenuItem>}
                {lostStage && <MenuItem onClick={() => setLosing(opportunity)}>{t('opportunities.markLost')}</MenuItem>}
                <MenuItem onClick={() => setDialog({ opportunity })}>{t('common.edit')}</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        )}
      </div>
      <AppLink to={`/organizations/${opportunity.organization.id}`} className={styles.muted}>
        {opportunity.organization.name}
      </AppLink>
      {canSeeMoney && (
        <Text className={styles.amount}>
          {formatMoney(opportunity.forecastAmount ?? 0)} <span className={styles.muted}>({opportunity.probability} %)</span>
        </Text>
      )}
      <Text className={styles.muted}>
        {t('opportunities.closesOn', { date: formatDate(opportunity.expectedCloseDate) })}
        {opportunity.mrr ? ` · ${t('opportunities.mrrShort', { amount: formatNumber(opportunity.mrr, 0) })}` : ''}
      </Text>
      {opportunity.isStale && (
        <Badge appearance="tint" color="warning">
          {t('opportunities.stale')}
        </Badge>
      )}
    </div>
  );

  const setFlag = (key: string, value: boolean) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, 'true');
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const move = async (opportunity: Opportunity, stageId: string, label: string) => {
    try {
      await actions.move.mutateAsync({ id: opportunity.id, stageId });
      notify(label);
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  const monthName = (year: number, month: number) =>
    new Intl.DateTimeFormat(i18n.language, { month: 'short', year: '2-digit' }).format(new Date(Date.UTC(year, month - 1, 1)));

  return (
    <>
      <PageHeader
        title={t('opportunities.title')}
        subtitle={t('opportunities.subtitle')}
        actions={
          canWrite && (
            <Button {...restoreFocusTarget} appearance="primary" icon={<Add20Regular />} onClick={() => setDialog({})}>
              {t('opportunities.new')}
            </Button>
          )
        }
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12 }}>
        <SavedViews scope="pipeline" keys={['mine', 'stale']} />
      </div>
      <div className={styles.filters}>
        <SearchBox
          id="pipeline-search"
          className={styles.search}
          value={search}
          onChange={(_, d) => setSearch(d.value)}
          placeholder={t('opportunities.search')}
          aria-label={t('opportunities.search')}
        />
        <Switch label={t('opportunities.mine')} checked={mine} onChange={(_, d) => setFlag('mine', d.checked)} />
        <Switch label={t('opportunities.staleOnly')} checked={stale} onChange={(_, d) => setFlag('stale', d.checked)} />
        <span className={styles.spacer} />
        {(data?.stale ?? 0) > 0 && (
          <Badge appearance="tint" color="warning">
            {t('opportunities.staleCount', { count: data!.stale })}
          </Badge>
        )}
      </div>

      {canSeeMoney && (data?.forecast.length ?? 0) > 0 && (
        <div className={styles.forecast}>
          <Text weight="semibold">{t('opportunities.forecast')}</Text>
          {data!.forecast.map((month) => (
            <span key={`${month.year}-${month.month}`} className={styles.month}>
              <Text className={styles.amount}>{formatMoney(month.weighted ?? 0)}</Text>
              <Text className={styles.muted}>
                {monthName(month.year, month.month)} · {t('opportunities.dealCount', { count: month.count })}
              </Text>
            </span>
          ))}
        </div>
      )}

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <div className={styles.board} style={narrow ? { flexDirection: 'column' } : undefined}>
          {(data?.columns ?? []).map((column) => (
            <section key={column.stageId} className={styles.column} aria-label={column.stageName}>
              <div className={styles.columnHead}>
                <Text weight="semibold">{column.stageName}</Text>
                <Text className={styles.muted}>
                  {column.count}
                  {canSeeMoney ? ` · ${formatMoney(column.forecast ?? 0)}` : ''}
                </Text>
              </div>
              {column.opportunities.map(card)}
              <MoreCards
                key={`${column.stageId}-${dataUpdatedAt}`}
                filters={{ ...filters, stageId: column.stageId, status: 'Open' }}
                cursor={column.nextCursor}
                shown={column.opportunities.length}
                total={column.count}
                card={card}
              />
            </section>
          ))}
        </div>
      )}
      {!isPending && (data?.columns.every((c) => c.count === 0) ?? false) && <EmptyState message={t('opportunities.empty')} />}

      <OpportunityDialog open={dialog !== null} onClose={() => setDialog(null)} opportunity={dialog?.opportunity} stageId={dialog?.stageId} />
      <LoseDialog open={losing !== null} opportunity={losing} stageId={lostStage?.id ?? ''} onClose={() => setLosing(null)} />
    </>
  );
}

/**
 * The rest of one board column (DEV-12): the column arrives with its first cards and the count of all of them; the next cards
 * come from the deals list with the board's filters and the column's cursor. A reload of the board starts over (new key).
 */
function MoreCards({ filters, cursor, shown, total, card }: { filters: OpportunityFilters; cursor: string | null; shown: number; total: number; card: (opportunity: Opportunity) => ReactNode }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const [extra, setExtra] = useState<Opportunity[]>([]);
  const [next, setNext] = useState(cursor);
  const [loading, setLoading] = useState(false);
  const more = async () => {
    if (!next) return;
    setLoading(true);
    try {
      const page = await fetchOpportunityPage(filters, next);
      setExtra((current) => [...current, ...page.items]);
      setNext(page.nextCursor);
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    } finally {
      setLoading(false);
    }
  };
  return (
    <>
      {extra.map(card)}
      {total > shown && <ListFooter shown={shown + extra.length} total={total} hasMore={Boolean(next)} loading={loading} onMore={() => void more()} />}
    </>
  );
}
