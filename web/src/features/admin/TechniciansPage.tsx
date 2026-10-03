import { Badge, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { UserPicker } from '../../shared/components/UserPicker';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDateTime } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { useMapTechnician, useTechnicianMappings } from '../time/api';

/** Technicians of Atera mapped to CRM users, so imported hours land on the right person (BR-TIM-01). */
export function TechniciansPage() {
  const styles = useCatalogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const canMap = useCan(Permissions.integrationsManage);
  const { data = [], error, isPending, refetch } = useTechnicianMappings();
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
        <div className={styles.tableWrap}>
          <Table className={styles.table} aria-label={t('technicians.title')}>
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
                    <span className={styles.name}>{mapping.name ?? mapping.externalId}</span>
                    <div className={styles.sku}>{mapping.email ?? `#${mapping.externalId}`}</div>
                  </TableCell>
                  <TableCell>
                    <Badge appearance="tint" color="brand">
                      {t(`systems.${mapping.system}`, { defaultValue: mapping.system })}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {canMap ? (
                      <UserPicker
                        aria-labelledby={undefined}
                        value={mapping.userId ? { id: mapping.userId, displayName: mapping.userName ?? '' } : null}
                        onChange={(user) => void assign(mapping.id, user?.id ?? null)}
                      />
                    ) : (
                      <Text>{mapping.userName ?? t('technicians.notMapped')}</Text>
                    )}
                    {mapping.userId && <div className={styles.sku}>{t(`technicians.methods.${mapping.method}`)}</div>}
                  </TableCell>
                  <TableCell className="tabular">{formatDateTime(mapping.lastSeenAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!isPending && data.length === 0 && <EmptyState message={t('technicians.empty')} />}
        </div>
      )}
    </>
  );
}
