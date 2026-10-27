import { Badge, Checkbox, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, makeStyles, mergeClasses } from '@fluentui/react-components';
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
import { useMapTechnician, useTechnicianMappings } from '../time/api';
import type { TechnicianMapping } from '../time/types';
import { PersonCell } from './settingsUi';
import { useTableCardStyles } from './tableCard';

const useStyles = makeStyles({
  // Fluent's Combobox keeps 250 px by default and ran into the next column in a narrow table: it takes the cell's width.
  user: { display: 'grid', gap: '4px', minWidth: 0, maxWidth: '320px', '& .fui-Combobox': { minWidth: 0 } },
  notMapped: { color: h.muted },
  // A badge only ("Atera"): the room goes to the technician and the person.
  systemCol: { width: '96px' },
});

/** Atera's number beside the e-mail: only the row with a number can write in Atera, one keyed by e-mail cannot. */
function technicianDetail(mapping: TechnicianMapping) {
  const number = /^\d+$/.test(mapping.externalId) ? `#${mapping.externalId}` : null;
  return [mapping.email, number].filter(Boolean).join(' · ') || mapping.externalId;
}

/**
 * Technicians of Atera mapped to CRM users, so imported hours land on the right person (BR-TIM-01). One technician may be
 * shared by everyone (one Atera account for the whole firm): those without their own write in Atera as it.
 */
export function TechniciansPage() {
  const styles = useStyles();
  const table = useTableCardStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const canMap = useCan(Permissions.integrationsManage);
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

  return (
    <>
      <PageHeader title={t('technicians.title')} subtitle={t('technicians.subtitle')} />
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <ScrollTable>
          <Table className={mergeClasses(table.min800, table.roomy)} aria-label={t('technicians.title')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('technicians.columns.technician')}</TableHeaderCell>
                <TableHeaderCell className={styles.systemCol}>{t('technicians.columns.system')}</TableHeaderCell>
                <TableHeaderCell>{t('technicians.columns.user')}</TableHeaderCell>
                <TableHeaderCell className={table.dateTimeCol}>{t('technicians.columns.lastSeen')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((mapping) => {
                const shared = sharing?.id === mapping.id ? sharing.shared : mapping.shared;
                const hint = `technician-${mapping.id}-shared`;
                return (
                  <TableRow key={mapping.id}>
                    <TableCell>
                      <PersonCell name={mapping.name ?? mapping.externalId} detail={technicianDetail(mapping)} />
                    </TableCell>
                    <TableCell>
                      <Badge appearance="outline">{t(`systems.${mapping.system}`, { defaultValue: mapping.system })}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className={styles.user}>
                        {canMap ? (
                          <>
                            {!shared && (
                              <UserPicker
                                aria-labelledby={undefined}
                                value={mapping.userId ? { id: mapping.userId, displayName: mapping.userName ?? '' } : null}
                                onChange={(user) => void assign(mapping.id, user?.id ?? null)}
                              />
                            )}
                            <Checkbox
                              checked={shared}
                              disabled={map.isPending}
                              label={t('technicians.shared')}
                              aria-describedby={shared ? hint : undefined}
                              onChange={(_, state) => void share(mapping.id, state.checked === true)}
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
                    </TableCell>
                    <TableCell className={table.nowrap}>{formatDateTime(mapping.lastSeenAt)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {!isPending && data.length === 0 && <EmptyState message={t('technicians.empty')} icon={<PeopleTeam24Regular />} />}
          <ListFooter shown={data.length} total={mappings.total} hasMore={mappings.hasNextPage} loading={mappings.isFetchingNextPage} onMore={() => void mappings.fetchNextPage()} />
        </ScrollTable>
      )}
    </>
  );
}
