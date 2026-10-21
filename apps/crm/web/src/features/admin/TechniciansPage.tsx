import { Badge, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, makeStyles, mergeClasses } from '@fluentui/react-components';
import { PeopleTeam24Regular } from '@fluentui/react-icons';
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
import { PersonCell } from './settingsUi';
import { useTableCardStyles } from './tableCard';

const useStyles = makeStyles({
  user: { display: 'grid', gap: '4px', minWidth: 0, maxWidth: '320px' },
  notMapped: { color: h.muted },
});

/** Technicians of Atera mapped to CRM users, so imported hours land on the right person (BR-TIM-01). */
export function TechniciansPage() {
  const styles = useStyles();
  const table = useTableCardStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const canMap = useCan(Permissions.integrationsManage);
  const mappings = useTechnicianMappings();
  const { items: data, error, isPending, refetch } = mappings;
  const map = useMapTechnician();

  const assign = async (id: string, userId: string | null) => {
    try {
      await map.mutateAsync({ id, userId });
      notify(userId ? t('technicians.mapped') : t('technicians.unmapped'));
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
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
                <TableHeaderCell>{t('technicians.columns.system')}</TableHeaderCell>
                <TableHeaderCell>{t('technicians.columns.user')}</TableHeaderCell>
                <TableHeaderCell>{t('technicians.columns.lastSeen')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((mapping) => (
                <TableRow key={mapping.id}>
                  <TableCell>
                    <PersonCell name={mapping.name ?? mapping.externalId} detail={mapping.email ?? `#${mapping.externalId}`} />
                  </TableCell>
                  <TableCell>
                    <Badge appearance="outline">{t(`systems.${mapping.system}`, { defaultValue: mapping.system })}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className={styles.user}>
                      {canMap ? (
                        <UserPicker
                          aria-labelledby={undefined}
                          value={mapping.userId ? { id: mapping.userId, displayName: mapping.userName ?? '' } : null}
                          onChange={(user) => void assign(mapping.id, user?.id ?? null)}
                        />
                      ) : (
                        <Text className={mapping.userName ? undefined : styles.notMapped}>{mapping.userName ?? t('technicians.notMapped')}</Text>
                      )}
                      {mapping.userId && <span className={table.sub}>{t(`technicians.methods.${mapping.method}`)}</span>}
                    </div>
                  </TableCell>
                  <TableCell className={table.nowrap}>{formatDateTime(mapping.lastSeenAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!isPending && data.length === 0 && <EmptyState message={t('technicians.empty')} icon={<PeopleTeam24Regular />} />}
          <ListFooter shown={data.length} total={mappings.total} hasMore={mappings.hasNextPage} loading={mappings.isFetchingNextPage} onMore={() => void mappings.fetchNextPage()} />
        </ScrollTable>
      )}
    </>
  );
}
