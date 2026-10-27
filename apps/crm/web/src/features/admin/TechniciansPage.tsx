import { Badge, Checkbox, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { PeopleTeam24Regular } from '@fluentui/react-icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { ListFooter } from '../../shared/components/ListFooter';
import { PageHeader } from '../../shared/components/PageHeader';
import { ScrollTable } from '../../shared/components/ScrollTable';
import { UserPicker } from '../../shared/components/UserPicker';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDateTime } from '../../shared/utils/format';
import { useMediaQuery } from '../../shared/utils/useMediaQuery';
import { useMapTechnician, useTechnicianMappings } from '../time/api';
import type { TechnicianMapping } from '../time/types';
import { useRecordStyles } from '../organizations/recordStyles';
import { PersonCell } from './settingsUi';
import { useTableCardStyles } from './tableCard';

// The table needs 800 px; below that (a tablet held upright, a phone) each technician is a card, so the person and the
// "Shared by everyone" box are on the first screen instead of behind a sideways scroll.
const CARDS = '(max-width: 840px)';

const useStyles = makeStyles({
  // Fluent's Combobox keeps 250 px by default and ran into the next column in a narrow table: it takes the cell's width.
  user: { display: 'grid', gap: '4px', minWidth: 0, maxWidth: '320px', '& .fui-Combobox': { minWidth: 0 } },
  notMapped: { color: h.muted },
  // A badge only ("Atera"): the room goes to the technician and the person.
  systemCol: { width: '96px' },
  // A card holds the technician over their person: a column, not the record card's row.
  card: { display: 'grid', gap: '12px', alignItems: 'stretch' },
  cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', minWidth: 0 },
  // The card's whole width on a phone, a field's width on a tablet held upright.
  cardUser: { maxWidth: '440px' },
  // The label sits on its field (4 px), as in the app's forms; the card's 12 px gap is between groups.
  field: { display: 'grid', gap: '4px', minWidth: 0 },
  label: { fontSize: '13px', lineHeight: '18px', fontWeight: tokens.fontWeightSemibold, color: h.muted },
});

/** Atera's number beside the e-mail: only the row with a number can write in Atera, one keyed by e-mail cannot. */
function technicianDetail(mapping: TechnicianMapping) {
  const number = /^\d+$/.test(mapping.externalId) ? `#${mapping.externalId}` : null;
  return [mapping.email, number].filter(Boolean).join(' · ') || mapping.externalId;
}

interface UserControlsProps {
  mapping: TechnicianMapping;
  shared: boolean;
  canMap: boolean;
  busy: boolean;
  /** The picker's name: the column or field label, then the technician (one picker per row, told apart by name). */
  labelledBy: string;
  className?: string;
  onAssign: (userId: string | null) => void;
  onShare: (shared: boolean) => void;
}

/** The person a technician belongs to, or "Shared by everyone", with what that means: the same in a table row and a card. */
function UserControls({ mapping, shared, canMap, busy, labelledBy, className, onAssign, onShare }: UserControlsProps) {
  const styles = useStyles();
  const table = useTableCardStyles();
  const { t } = useTranslation();
  const hint = `technician-${mapping.id}-shared`;
  return (
    <div className={mergeClasses(styles.user, className)}>
      {canMap ? (
        <>
          {!shared && (
            <UserPicker
              aria-labelledby={labelledBy}
              value={mapping.userId ? { id: mapping.userId, displayName: mapping.userName ?? '' } : null}
              onChange={(user) => onAssign(user?.id ?? null)}
            />
          )}
          <Checkbox
            checked={shared}
            disabled={busy}
            label={t('technicians.shared')}
            aria-describedby={shared ? hint : undefined}
            onChange={(_, state) => onShare(state.checked === true)}
          />
        </>
      ) : (
        <Text className={mapping.userName || shared ? undefined : styles.notMapped}>
          {shared ? t('technicians.shared') : mapping.userName ?? t('technicians.notMapped')}
        </Text>
      )}
      {shared
        ? <span id={hint} className={table.sub}>{t('technicians.sharedHint')}</span>
        : mapping.userId && <span className={table.sub}>{t(`technicians.methods.${mapping.method}`)}</span>}
    </div>
  );
}

/**
 * Technicians of Atera mapped to CRM users, so imported hours land on the right person (BR-TIM-01). One technician may be
 * shared by everyone (one Atera account for the whole firm): those without their own write in Atera as it.
 */
export function TechniciansPage() {
  const styles = useStyles();
  const table = useTableCardStyles();
  const record = useRecordStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const canMap = useCan(Permissions.integrationsManage);
  const cards = useMediaQuery(CARDS);
  const mappings = useTechnicianMappings();
  const { items: data, error, isPending, refetch } = mappings;
  const map = useMapTechnician();
  // The box shows the choice at once; the row follows the server's answer when it comes, or goes back on a refusal.
  const [sharing, setSharing] = useState<{ id: string; shared: boolean } | null>(null);

  const save = async (id: string, change: { userId: string | null; shared?: boolean }, done: string) => {
    try {
      await map.mutateAsync({ id, ...change });
      notify(done);
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };
  const assign = (id: string, userId: string | null) =>
    save(id, { userId }, userId ? t('technicians.mapped') : t('technicians.unmapped'));
  const share = async (id: string, shared: boolean) => {
    setSharing({ id, shared });
    await save(id, { userId: null, shared }, shared ? t('technicians.sharedOn') : t('technicians.sharedOff'));
    setSharing(null);
  };
  const controls = (mapping: TechnicianMapping, labelledBy: string, className?: string) => (
    <UserControls
      mapping={mapping}
      shared={sharing?.id === mapping.id ? sharing.shared : mapping.shared}
      canMap={canMap}
      busy={map.isPending}
      labelledBy={labelledBy}
      className={className}
      onAssign={(userId) => void assign(mapping.id, userId)}
      onShare={(shared) => void share(mapping.id, shared)}
    />
  );
  const system = (mapping: TechnicianMapping) => (
    <Badge appearance="outline">{t(`systems.${mapping.system}`, { defaultValue: mapping.system })}</Badge>
  );
  const lastSeen = (mapping: TechnicianMapping) => <time dateTime={mapping.lastSeenAt}>{formatDateTime(mapping.lastSeenAt)}</time>;
  const empty = !isPending && data.length === 0 && <EmptyState message={t('technicians.empty')} icon={<PeopleTeam24Regular />} />;
  const footer = (
    <ListFooter shown={data.length} total={mappings.total} hasMore={mappings.hasNextPage} loading={mappings.isFetchingNextPage} onMore={() => void mappings.fetchNextPage()} />
  );

  return (
    <>
      <PageHeader title={t('technicians.title')} subtitle={t('technicians.subtitle')} />
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : cards ? (
        <>
          {data.length > 0 && (
            <ul className={record.cards} aria-label={t('technicians.title')}>
              {data.map((mapping) => {
                const name = `technician-${mapping.id}-name`;
                const label = `technician-${mapping.id}-user`;
                return (
                  <li key={mapping.id} className={mergeClasses(record.card, styles.card)}>
                    <span className={styles.cardHead}>
                      <PersonCell name={mapping.name ?? mapping.externalId} detail={technicianDetail(mapping)} nameId={name} />
                      {system(mapping)}
                    </span>
                    <div className={styles.field}>
                      <span id={label} className={styles.label}>{t('technicians.columns.user')}</span>
                      {controls(mapping, `${label} ${name}`, styles.cardUser)}
                    </div>
                    <span className={table.sub}>{t('technicians.columns.lastSeen')}: {lastSeen(mapping)}</span>
                  </li>
                );
              })}
            </ul>
          )}
          {empty}
          {footer}
        </>
      ) : (
        <ScrollTable>
          <Table className={mergeClasses(table.min800, table.roomy)} aria-label={t('technicians.title')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('technicians.columns.technician')}</TableHeaderCell>
                <TableHeaderCell className={styles.systemCol}>{t('technicians.columns.system')}</TableHeaderCell>
                <TableHeaderCell id="technicians-user-column">{t('technicians.columns.user')}</TableHeaderCell>
                <TableHeaderCell className={table.dateTimeCol}>{t('technicians.columns.lastSeen')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((mapping) => {
                const name = `technician-${mapping.id}-name`;
                return (
                  <TableRow key={mapping.id}>
                    <TableCell>
                      <PersonCell name={mapping.name ?? mapping.externalId} detail={technicianDetail(mapping)} nameId={name} />
                    </TableCell>
                    <TableCell>{system(mapping)}</TableCell>
                    <TableCell>{controls(mapping, `technicians-user-column ${name}`)}</TableCell>
                    <TableCell className={table.nowrap}>{lastSeen(mapping)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {empty}
          {footer}
        </ScrollTable>
      )}
    </>
  );
}
