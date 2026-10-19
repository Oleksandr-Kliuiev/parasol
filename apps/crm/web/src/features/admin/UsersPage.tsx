import { useState } from 'react';
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
import { usePagedList } from '../../api/paging';
import type { UserSummary } from '../../api/types';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { ErrorState } from '../../shared/components/ErrorState';
import { ListFooter } from '../../shared/components/ListFooter';
import { PageHeader } from '../../shared/components/PageHeader';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import { NotFoundPage } from '../errors/NotFoundPage';
import { ScrollTable } from '../../shared/components/ScrollTable';

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
  const users = usePagedList<UserSummary>(['identity', 'users', 'admin', term], '/api/v1/identity/users', { search: term, includeInactive: true }, { enabled: allowed });
  const { items: data, error, refetch } = users;
  if (!allowed) return <NotFoundPage />;

  return (
    <>
      <PageHeader title={t('users.title')} subtitle={t('users.subtitle')} />
      <SearchBox id="users-search" className={styles.search} value={search} onChange={(_, d) => setSearch(d.value)} placeholder={t('users.search')} />
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <ScrollTable className={styles.tableWrap}>
          <Table aria-label={t('users.title')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('users.columns.name')}</TableHeaderCell>
                <TableHeaderCell>{t('users.columns.email')}</TableHeaderCell>
                <TableHeaderCell>{t('users.columns.status')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((user) => (
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
          <ListFooter shown={data.length} total={users.total} hasMore={users.hasNextPage} loading={users.isFetchingNextPage} onMore={() => void users.fetchNextPage()} />
        </ScrollTable>
      )}
    </>
  );
}
