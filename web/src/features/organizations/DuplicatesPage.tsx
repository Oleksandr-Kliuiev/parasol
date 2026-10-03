import { useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Badge,
  Button,
  Dialog,
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
import { useTranslation } from 'react-i18next';
import type { DuplicatePair, DuplicateSide } from '../../api/types';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { OrganizationStatusBadge } from '../../shared/components/StatusBadges';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatDateTime } from '../../shared/utils/format';
import { formatOrgNumber } from '../../shared/utils/orgNumber';
import { useDuplicateActions, useDuplicates, useMerges } from './duplicatesApi';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  pair: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    overflow: 'hidden',
  },
  reasons: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
    paddingInline: tokens.spacingHorizontalL,
    paddingBlock: tokens.spacingVerticalS,
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  badges: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
  sides: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' },
  side: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    paddingInline: tokens.spacingHorizontalL,
    paddingBlock: tokens.spacingVerticalM,
    ':first-child': { borderRight: `1px solid ${tokens.colorNeutralStroke2}` },
  },
  sideHeader: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, alignItems: 'baseline' },
  facts: { margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalXXS },
  term: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  value: { margin: 0, fontSize: tokens.fontSizeBase300, overflowWrap: 'anywhere', fontVariantNumeric: 'tabular-nums' },
  different: { backgroundColor: tokens.colorPaletteYellowBackground1, borderRadius: tokens.borderRadiusSmall, paddingInline: '2px' },
  tableWrap: { overflowX: 'auto' },
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
        <AppLink to={`/organizations/${current.id}`}>
          <Text weight="semibold" size={400}>
            {current.name}
          </Text>
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
      <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
        {t('duplicates.contacts', { count: current.activeContacts })} · {t('duplicates.created', { date: formatDate(current.createdAt) })}
      </Text>
      {canMerge && (
        <div>
          <Button
            {...restoreFocusTarget}
            appearance="primary"
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
        {duplicates.data?.length === 0 && (
          <Panel>
            <EmptyState message={t('duplicates.empty')} />
          </Panel>
        )}
        {duplicates.data?.map((pair) => (
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

        {merges.data && merges.data.length > 0 && (
          <Panel title={t('duplicates.recent')}>
            <div className={styles.tableWrap}>
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
                  {merges.data.map((m) => (
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
            </div>
          </Panel>
        )}
      </div>

      <Dialog open={pending !== null} onOpenChange={(_, d) => !d.open && setPending(null)}>
        <DialogSurface>
          {pending && (
            <DialogBody>
              <DialogTitle>{t('duplicates.confirmTitle', { source: pending.source.name, target: pending.target.name })}</DialogTitle>
              <DialogContent>{t('duplicates.confirmBody', { source: pending.source.name, target: pending.target.name })}</DialogContent>
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
