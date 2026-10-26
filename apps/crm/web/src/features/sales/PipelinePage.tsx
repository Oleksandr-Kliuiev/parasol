import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Avatar,
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
  mergeClasses,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Add20Regular, CalendarLtr16Regular, Clock12Regular, DataFunnel24Regular, DataTrending16Regular, MoreHorizontal20Regular } from '@fluentui/react-icons';
import { cardSurface, h } from '../../app/hearth';
import { StatGrid, StatTile } from '../../shared/components/KpiTile';
import { useScrollEdges } from '../../shared/utils/useScrollEdges';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { FilterField, Toolbar } from '../../shared/components/Toolbar';
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
  // A switch on the line of the 42 px search next to it.
  toggle: { display: 'inline-flex', alignItems: 'center', minHeight: '42px' },
  // The board of the reference: one well per stage, cards on it; the row scrolls sideways with a fading edge.
  // When the stages are wider than the page the board is a focusable region, so the arrow keys scroll it even without cards.
  board: { display: 'flex', gap: '14px', overflowX: 'auto', paddingBottom: '12px', alignItems: 'flex-start',
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px', borderRadius: '18px' } },
  boardNarrow: { flexDirection: 'column', alignItems: 'stretch', overflowX: 'visible' },
  column: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    minWidth: '260px',
    flex: '1 0 260px',
    paddingTop: '12px',
    paddingBottom: '10px',
    paddingLeft: '10px',
    paddingRight: '10px',
    backgroundColor: h.well,
    borderRadius: '18px',
    border: `1px solid ${h.line}`,
  },
  columnHead: { display: 'grid', gap: '6px', paddingLeft: '4px', paddingRight: '4px', paddingBottom: '4px' },
  columnTitle: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 },
  dot: { width: '10px', height: '10px', borderRadius: '50%', flexShrink: 0 },
  stage: { fontWeight: 700, fontSize: '14px', lineHeight: '20px', flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere' },
  count: {
    minWidth: '22px',
    height: '22px',
    paddingLeft: '6px',
    paddingRight: '6px',
    boxSizing: 'border-box',
    display: 'inline-grid',
    placeItems: 'center',
    borderRadius: '999px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${h.line}`,
    fontSize: '12px',
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
  },
  sum: { fontFamily: h.display, fontSize: '17px', lineHeight: '22px', fontWeight: 600, letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums' },
  share: { height: '3px', borderRadius: '999px', backgroundColor: h.line, overflow: 'hidden' },
  shareFill: { display: 'block', height: '100%', borderRadius: '999px' },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    paddingTop: '12px',
    paddingBottom: '12px',
    paddingLeft: '12px',
    paddingRight: '8px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${h.line}`,
    borderRadius: '14px',
    boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05), 0 6px 16px -10px rgba(0, 0, 0, 0.25)',
  },
  cardHead: { display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'start' },
  who: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 },
  whoText: { display: 'grid', minWidth: 0 },
  // The deal and its customer are two links on top of each other: each gets a 24 px tall target (WCAG 2.5.8).
  dealName: { display: 'inline-flex', alignItems: 'center', minHeight: '24px', fontWeight: 700, fontSize: '14px', lineHeight: '20px', color: 'inherit', overflowWrap: 'anywhere' },
  orgLink: { display: 'inline-flex', alignItems: 'center', minHeight: '24px', color: h.muted, fontSize: '12px', lineHeight: '16px', fontWeight: 600 },
  muted: { color: h.muted, fontSize: '12px', lineHeight: '16px' },
  amount: { fontFamily: h.display, fontSize: '18px', lineHeight: '24px', fontWeight: 600, letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums' },
  // The close date as the reference's small chip with a clock.
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: '6px',
    paddingTop: '3px',
    paddingBottom: '3px',
    paddingLeft: '8px',
    paddingRight: '10px',
    borderRadius: '999px',
    backgroundColor: h.well,
    color: h.muted,
    fontSize: '12px',
    lineHeight: '16px',
    fontWeight: 600,
    '& svg': { flexShrink: 0 },
  },
  // Money with decimals needs the full phone width to stay on one line.
  // Wider month tiles, so an amount with decimals keeps to one line; one column on a phone.
  forecastGrid: { gridTemplateColumns: 'repeat(auto-fill, minmax(min(240px, 100%), 1fr))', '@media (max-width: 560px)': { gridTemplateColumns: 'minmax(0, 1fr)' } },
  forecastTitle: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: 0, marginBottom: '12px', fontFamily: h.display, fontSize: '16px', lineHeight: '22px', fontWeight: 600, letterSpacing: '-0.01em' },
  forecastIcon: { display: 'inline-flex', color: h.faint, '& svg': { width: '16px', height: '16px' } },
  emptyBoard: { ...cardSurface },
  // An empty stage: a quiet dashed place where its cards would be.
  columnEmpty: {
    display: 'grid',
    placeItems: 'center',
    minHeight: '72px',
    paddingLeft: '12px',
    paddingRight: '12px',
    borderRadius: '14px',
    border: `1px dashed ${h.line2}`,
    color: h.muted,
    fontSize: '12.5px',
    textAlign: 'center',
  },
});

const stageTones = [h.iris, h.saffron, h.spruce, h.ember, h.irisT, h.saffronT];

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
  const { data, error, refetch, dataUpdatedAt } = usePipeline(filters);
  const stages = useStages();
  const actions = useOpportunityActions();
  const [dialog, setDialog] = useState<{ stageId?: string; opportunity?: Opportunity } | null>(null);
  const [losing, setLosing] = useState<Opportunity | null>(null);
  const restoreFocusTarget = useRestoreFocusTarget();
  const board = useRef<HTMLDivElement>(null);
  const boardEdges = useScrollEdges(board, 'x', `${narrow}:${data?.columns.length ?? 0}:${dataUpdatedAt}`);
  const wonStage = stages.data?.find((s) => s.isWon);
  const lostStage = stages.data?.find((s) => s.isLost);

  const card = (opportunity: Opportunity) => (
    <div key={opportunity.id} className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.who}>
          <Avatar name={opportunity.organization.name} size={28} color="colorful" aria-hidden />
          <span className={styles.whoText}>
            <AppLink to={`/sales/opportunities/${opportunity.id}`} className={styles.dealName}>{opportunity.name}</AppLink>
            <AppLink to={`/organizations/${opportunity.organization.id}`} className={styles.orgLink}>
              {opportunity.organization.name}
            </AppLink>
          </span>
        </span>
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
      {canSeeMoney && (
        <Text className={styles.amount}>
          {formatMoney(opportunity.forecastAmount ?? 0)} <span className={styles.muted}>({opportunity.probability} %)</span>
        </Text>
      )}
      <Text className={styles.chip}>
        <Clock12Regular aria-hidden />
        <span>
          {t('opportunities.closesOn', { date: formatDate(opportunity.expectedCloseDate) })}
          {opportunity.mrr ? ` · ${t('opportunities.mrrShort', { amount: formatNumber(opportunity.mrr, 0) })}` : ''}
        </span>
      </Text>
      {opportunity.isStale && (
        <span>
          <Badge appearance="tint" color="warning">
            {t('opportunities.stale')}
          </Badge>
        </span>
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

  const maxCount = Math.max(0, ...(data?.columns ?? []).map((c) => c.count));

  const monthName = (year: number, month: number) =>
    new Intl.DateTimeFormat(i18n.language, { month: 'short', year: '2-digit' }).format(new Date(Date.UTC(year, month - 1, 1)));

  return (
    <>
      <PageHeader
        title={t('opportunities.title')}
        subtitle={t('opportunities.subtitle')}
        actions={
          <>
            <SavedViews scope="pipeline" keys={['mine', 'stale']} />
            {canWrite && (
              <Button {...restoreFocusTarget} appearance="primary" icon={<Add20Regular />} onClick={() => setDialog({})}>
                {t('opportunities.new')}
              </Button>
            )}
          </>
        }
      />
      <Toolbar
        label={t('opportunities.filterLabel')}
        end={
          (data?.stale ?? 0) > 0 && (
            <Badge appearance="tint" color="warning">
              {t('opportunities.staleCount', { count: data!.stale })}
            </Badge>
          )
        }
      >
        <FilterField kind="search" label={t('opportunities.search')}>
          <SearchBox id="pipeline-search" value={search} onChange={(_, d) => setSearch(d.value)} placeholder={t('opportunities.search')} />
        </FilterField>
        <Switch className={styles.toggle} label={t('opportunities.mine')} checked={mine} onChange={(_, d) => setFlag('mine', d.checked)} />
        <Switch className={styles.toggle} label={t('opportunities.staleOnly')} checked={stale} onChange={(_, d) => setFlag('stale', d.checked)} />
      </Toolbar>

      {canSeeMoney && (data?.forecast.length ?? 0) > 0 && (
        <section aria-labelledby="pipeline-forecast">
          <h2 id="pipeline-forecast" className={styles.forecastTitle}>
            <span className={styles.forecastIcon} aria-hidden><DataTrending16Regular /></span>
            {t('opportunities.forecast')}
          </h2>
          <StatGrid className={styles.forecastGrid}>
            {data!.forecast.map((month) => (
              <StatTile
                key={`${month.year}-${month.month}`}
                icon={<CalendarLtr16Regular />}
                tone="iris"
                label={monthName(month.year, month.month)}
                value={formatMoney(month.weighted ?? 0)}
                note={t('opportunities.dealCount', { count: month.count })}
              />
            ))}
          </StatGrid>
        </section>
      )}

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data && data.columns.length === 0 ? (
        // No open stages at all (an administrator turned them off): the board's card says so instead of staying blank.
        <div className={styles.emptyBoard}>
          <EmptyState icon={<DataFunnel24Regular />} message={t('opportunities.empty')} />
        </div>
      ) : (
        <div ref={board} className={mergeClasses(styles.board, narrow && styles.boardNarrow)} style={narrow ? undefined : boardEdges.style}
          {...(!narrow && boardEdges.overflow ? { role: 'region', 'aria-label': t('opportunities.title'), tabIndex: 0 } : {})}>
          {(data?.columns ?? []).map((column, index) => (
            <section key={column.stageId} className={styles.column} aria-label={column.stageName}>
              <div className={styles.columnHead}>
                <span className={styles.columnTitle}>
                  <span className={styles.dot} style={{ backgroundColor: stageTones[index % stageTones.length] }} aria-hidden />
                  <Text className={styles.stage}>{column.stageName}</Text>
                  <Text className={styles.count}>{column.count}</Text>
                </span>
                {canSeeMoney && <Text className={styles.sum}>{formatMoney(column.forecast ?? 0)}</Text>}
                <span className={styles.share} aria-hidden>
                  <span className={styles.shareFill} style={{ width: `${maxCount ? (column.count / maxCount) * 100 : 0}%`, backgroundColor: stageTones[index % stageTones.length] }} />
                </span>
              </div>
              {column.count === 0 && <div className={styles.columnEmpty}>{t('opportunities.columnEmpty')}</div>}
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
