import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Avatar,
  Badge,
  SearchBox,
  Table,
  TableBody,
  TableCell,
  TableCellLayout,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { api, query } from '../../api/client';
import type { UserSummary } from '../../api/types';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import { NotFoundPage } from '../errors/NotFoundPage';

const useStyles = makeStyles({
  search: { maxWidth: '360px', marginBottom: tokens.spacingVerticalM },
  tableWrap: { overflowX: 'auto', backgroundColor: tokens.colorNeutralBackground1, borderRadius: tokens.borderRadiusLarge, border: `1px solid ${tokens.colorNeutralStroke2}` },
});

export function UsersPage() {
  const styles = useStyles();
  const { t } = useTranslation();
  const allowed = useCan(Permissions.usersRead);
  const [search, setSearch] = useState('');
  const term = useDebouncedValue(search);
  const { data, error, refetch } = useQuery({
    queryKey: ['identity', 'users', 'admin', term],
    enabled: allowed,
    queryFn: async ({ signal }) => (await api.get<UserSummary[]>(`/api/v1/identity/users${query({ search: term, includeInactive: true })}`, signal)).data,
  });
  if (!allowed) return <NotFoundPage />;

  return (
    <>
      <PageHeader title={t('users.title')} subtitle={t('users.subtitle')} />
      <SearchBox id="users-search" className={styles.search} value={search} onChange={(_, d) => setSearch(d.value)} placeholder={t('users.search')} />
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <div className={styles.tableWrap}>
          <Table aria-label={t('users.title')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('users.columns.name')}</TableHeaderCell>
                <TableHeaderCell>{t('users.columns.email')}</TableHeaderCell>
                <TableHeaderCell>{t('users.columns.status')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>
                    <TableCellLayout media={<Avatar name={user.displayName} size={24} color="colorful" />}>{user.displayName}</TableCellLayout>
                  </TableCell>
                  <TableCell>{user.email}</TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={user.isActive ? 'success' : 'subtle'}>
                      {user.isActive ? t('users.active') : t('users.inactive')}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
