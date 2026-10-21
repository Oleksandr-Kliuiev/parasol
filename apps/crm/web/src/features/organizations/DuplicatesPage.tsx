import { useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Avatar,
  Badge,
  Button,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Skeleton,
  SkeletonItem,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import { DocumentCopy24Regular, History16Regular } from '@fluentui/react-icons';
import { h } from '../../app/hearth';
import { useTranslation } from 'react-i18next';
import type { DuplicatePair, DuplicateSide } from '../../api/types';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { ListFooter } from '../../shared/components/ListFooter';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { OrganizationStatusBadge } from '../../shared/components/StatusBadges';
import { useKeptWhileClosing } from '../../shared/components/useKeptWhileClosing';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatDateTime } from '../../shared/utils/format';
import { formatOrgNumber } from '../../shared/utils/orgNumber';
import { useDuplicateActions, useDuplicates, useMerges } from './duplicatesApi';
import { ScrollTable } from '../../shared/components/ScrollTable';

const useStyles = makeStyles({
  muted: { color: h.muted },
  stack: { display: 'flex', flexDirection: 'column', gap: '16px' },
  // One possible pair: a card with the reasons on a well strip and the two organizations side by side.
  pair: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${h.line}`,
    borderRadius: '20px',
    boxShadow: tokens.shadow4,
    overflow: 'hidden',
  },
  reasons: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    paddingLeft: '20px',
    paddingRight: '12px',
    paddingTop: '10px',
    paddingBottom: '10px',
    backgroundColor: h.surface2,
    borderBottom: `1px solid ${h.line}`,
  },
  badges: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
  sides: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))' },
  side: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    paddingLeft: '20px',
    paddingRight: '20px',
    paddingTop: '16px',
    paddingBottom: '18px',
    ':first-child': { borderRight: `1px solid ${h.line}` },
  },
  sideHeader: { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' },
  sideName: { fontFamily: h.display, fontSize: '17px', lineHeight: '22px', fontWeight: 600, color: 'inherit' },
  facts: { margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: '16px', rowGap: '6px' },
  term: { color: h.muted, fontSize: '13px' },
  value: { margin: 0, fontSize: '14px', fontWeight: 600, overflowWrap: 'anywhere', fontVariantNumeric: 'tabular-nums' },
  different: { backgroundColor: h.saffronSoft, color: h.saffronT, borderRadius: '6px', paddingLeft: '4px', paddingRight: '4px' },
  note: { color: h.muted, fontSize: '12px' },
  // The table sits flush in its panel: no second card around it.
  tableWrap: { border: 'none', borderRadius: 0, boxShadow: 'none' },
});

type Field = 'orgNumber' | 'city' | 'email' | 'phone' | 'domains';

function valueOf(side: DuplicateSide, field: Field): string {
  if (field === 'orgNumber') return formatOrgNumber(side.orgNumber);
  if (field === 'domains') return side.domains.join(', ');
  return side[field] ?? '';
}

export function DuplicatesPage() {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const [params] = useSearchParams();
  const organizationId = params.get('organizationId') ?? undefined;
  const canMerge = useCan(Permissions.customersDelete);
  const canDismiss = useCan(Permissions.customersWrite);
  const duplicates = useDuplicates(organizationId);
  const merges = useMerges();
  const actions = useDuplicateActions();
  const [pending, setPending] = useState<{ target: DuplicateSide; source: DuplicateSide } | null>(null);
  const shown = useKeptWhileClosing(pending);
  const restoreFocusTarget = useRestoreFocusTarget();

  const merge = async () => {
    if (!pending) return;
    try {
      const result = await actions.merge.mutateAsync({ targetId: pending.target.id, sourceId: pending.source.id });
      notify(t('duplicates.merged', { count: result.movedContacts }));
      setPending(null);
    } catch (error) {
      notify(t('errors.generic'), 'error', errorMessage(error, t));
    }
  };

  const dismiss = async (pair: DuplicatePair) => {
    try {
      await actions.dismiss.mutateAsync({ a: pair.first.id, b: pair.second.id });
      notify(t('duplicates.dismissed'));
    } catch (error) {
      notify(t('errors.generic'), 'error', errorMessage(error, t));
    }
  };

  const undo = async (mergeId: string) => {
    try {
      await actions.undo.mutateAsync(mergeId);
      notify(t('duplicates.undoneToast'));
    } catch (error) {
      notify(t('errors.generic'), 'error', errorMessage(error, t));
    }
  };

  const side = (current: DuplicateSide, other: DuplicateSide) => (
    <div className={styles.side}>
      <div className={styles.sideHeader}>
        <Avatar name={current.name} size={36} color="colorful" aria-hidden />
        <AppLink to={`/organizations/${current.id}`} className={styles.sideName}>
          {current.name}
        </AppLink>
        <OrganizationStatusBadge status={current.status} />
      </div>
      <dl className={styles.facts}>
        {(['orgNumber', 'city', 'email', 'phone', 'domains'] as Field[]).map((field) => {
          const value = valueOf(current, field);
          const differs = value !== '' && valueOf(other, field) !== '' && value !== valueOf(other, field);
          return (
            <div key={field} style={{ display: 'contents' }}>
              <dt className={styles.term}>{t(`organizations.fields.${field}`)}</dt>
              <dd className={styles.value}>{value ? <span className={differs ? styles.different : undefined}>{value}</span> : '—'}</dd>
            </div>
          );
        })}
      </dl>
      <Text className={styles.note}>
        {t('duplicates.contacts', { count: current.activeContacts })} · {t('duplicates.created', { date: formatDate(current.createdAt) })}
      </Text>
      {canMerge && (
        <div>
          <Button
            {...restoreFocusTarget}
            size="small"
            aria-label={`${t('duplicates.keep')}: ${current.name}`}
            onClick={() => setPending({ target: current, source: other })}
          >
            {t('duplicates.keep')}
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <>
      <PageHeader title={t('duplicates.title')} subtitle={t('duplicates.subtitle')} back={{ to: '/organizations', label: t('organizations.title') }} />
      <div className={styles.stack}>
        {duplicates.isPending && (
          <Skeleton aria-label={t('common.loading')}>
            <SkeletonItem size={96} />
          </Skeleton>
        )}
        {duplicates.error && <ErrorState error={duplicates.error} onRetry={() => void duplicates.refetch()} />}
        {duplicates.data?.items.length === 0 && (
          <Panel>
            <EmptyState icon={<DocumentCopy24Regular />} message={t('duplicates.empty')} />
          </Panel>
        )}
        {duplicates.data && duplicates.data.totalCount != null && duplicates.data.totalCount > duplicates.data.items.length && (
          <Text className={styles.muted}>{t('duplicates.strongestShown', { shown: duplicates.data.items.length, total: duplicates.data.totalCount })}</Text>
        )}
        {duplicates.data?.items.map((pair) => (
          <section key={`${pair.first.id}-${pair.second.id}`} className={styles.pair} aria-label={`${pair.first.name} / ${pair.second.name}`}>
            <div className={styles.reasons}>
              <span className={styles.badges}>
                {pair.reasons.map((reason) => (
                  <Badge key={reason} appearance="tint" color="warning">
                    {t(`duplicates.reasons.${reason}`)}
                  </Badge>
                ))}
              </span>
              {canDismiss && (
                <Button size="small" appearance="subtle" onClick={() => void dismiss(pair)} disabled={actions.dismiss.isPending}>
                  {t('duplicates.notDuplicates')}
                </Button>
              )}
            </div>
            <div className={styles.sides}>
              {side(pair.first, pair.second)}
              {side(pair.second, pair.first)}
            </div>
          </section>
        ))}

        {merges.items.length > 0 && (
          <Panel title={t('duplicates.recent')} icon={<History16Regular />} flush>
            <ScrollTable className={styles.tableWrap}>
              <Table size="small">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>{t('duplicates.columns.when')}</TableHeaderCell>
                    <TableHeaderCell>{t('duplicates.columns.kept')}</TableHeaderCell>
                    <TableHeaderCell>{t('duplicates.columns.mergedAway')}</TableHeaderCell>
                    <TableHeaderCell>{t('duplicates.columns.by')}</TableHeaderCell>
                    <TableHeaderCell>{t('duplicates.columns.state')}</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {merges.items.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell className="tabular">{formatDateTime(m.mergedAt)}</TableCell>
                      <TableCell>
                        <AppLink to={`/organizations/${m.targetOrganizationId}`}>{m.targetName}</AppLink>
                      </TableCell>
                      <TableCell>{m.sourceName}</TableCell>
                      <TableCell>{m.mergedBy?.displayName}</TableCell>
                      <TableCell>
                        {m.undoneAt ? (
                          t('duplicates.undone')
                        ) : m.canUndo && canMerge ? (
                          <Button size="small" onClick={() => void undo(m.id)} disabled={actions.undo.isPending}>
                            {t('duplicates.undo')}
                          </Button>
                        ) : (
                          t('duplicates.final')
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <ListFooter shown={merges.items.length} total={merges.total} hasMore={merges.hasNextPage} loading={merges.isFetchingNextPage} onMore={() => void merges.fetchNextPage()} />
            </ScrollTable>
          </Panel>
        )}
      </div>

      <Dialog open={pending !== null} onOpenChange={(_, d) => !d.open && setPending(null)}>
        <DialogSurface>
          {shown && (
            <DialogBody>
              <DialogTitle>{t('duplicates.confirmTitle', { source: shown.source.name, target: shown.target.name })}</DialogTitle>
              <DialogContent>{t('duplicates.confirmBody', { source: shown.source.name, target: shown.target.name })}</DialogContent>
              <DialogActions>
                <Button onClick={() => setPending(null)}>{t('common.cancel')}</Button>
                <Button appearance="primary" onClick={() => void merge()} disabled={actions.merge.isPending}>
                  {actions.merge.isPending ? t('common.saving') : t('duplicates.confirm')}
                </Button>
              </DialogActions>
            </DialogBody>
          )}
        </DialogSurface>
      </Dialog>
    </>
  );
}
