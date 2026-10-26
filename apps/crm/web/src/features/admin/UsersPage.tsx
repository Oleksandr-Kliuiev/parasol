import { useState } from 'react';
import { Badge, SearchBox, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, makeStyles } from '@fluentui/react-components';
import { PeopleSearch24Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { usePagedList } from '../../api/paging';
import type { UserSummary } from '../../api/types';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { ListFooter } from '../../shared/components/ListFooter';
import { PageHeader } from '../../shared/components/PageHeader';
import { ScrollTable } from '../../shared/components/ScrollTable';
import { FilterField, Toolbar } from '../../shared/components/Toolbar';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import { ForbiddenPage } from '../errors/ForbiddenPage';
import { PersonCell } from './settingsUi';

// The status pill needs little room: the person cell keeps the rest, so names and e-mails do not break on a phone.
const useStyles = makeStyles({ status: { width: '128px' } });

export function UsersPage() {
  const styles = useStyles();
  const { t } = useTranslation();
  const allowed = useCan(Permissions.usersRead);
  const [search, setSearch] = useState('');
  const term = useDebouncedValue(search);
  // A new search is read with the previous rows kept in place: the end of the list says it is loading, and no count or empty answer
  // is claimed for them, so the table does not empty and refill as people type.
  const users = usePagedList<UserSummary>(['identity', 'users', 'admin', term], '/api/v1/identity/users', { search: term, includeInactive: true },
    { enabled: allowed, keepPrevious: true });
  const { items: data, error, refetch } = users;
  const stale = users.isPlaceholderData;
  if (!allowed) return <ForbiddenPage />;

  return (
    <>
      <PageHeader title={t('users.title')} subtitle={t('users.subtitle')} />
      <Toolbar>
        <FilterField label={t('users.search')} kind="search">
          <SearchBox id="users-search" value={search} onChange={(_, d) => setSearch(d.value)} placeholder={t('users.search')} />
        </FilterField>
      </Toolbar>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <ScrollTable>
          <Table aria-label={t('users.title')} aria-busy={stale || undefined}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('users.columns.name')}</TableHeaderCell>
                <TableHeaderCell className={styles.status}>{t('users.columns.status')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>
                    <PersonCell name={user.displayName} detail={user.email} />
                  </TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={user.isActive ? 'success' : 'subtle'}>
                      {user.isActive ? t('users.active') : t('users.inactive')}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!users.isPending && !stale && data.length === 0 && <EmptyState message={t('users.empty')} icon={<PeopleSearch24Regular />} />}
          <ListFooter shown={data.length} total={users.total} hasMore={users.hasNextPage} loading={users.isFetchingNextPage} onMore={() => void users.fetchNextPage()}
            stale={stale} />
        </ScrollTable>
      )}
    </>
  );
}
