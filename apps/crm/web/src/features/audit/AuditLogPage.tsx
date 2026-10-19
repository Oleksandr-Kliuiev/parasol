import { useState } from 'react';
import {
  Button,
  Dropdown,
  Field,
  Input,
  Option,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import type { AuditEntry } from '../../api/types';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { formatDateTime } from '../../shared/utils/format';
import { NotFoundPage } from '../errors/NotFoundPage';
import { useAuditLog, type AuditFilters } from './api';
import { ChangeList } from './ChangeList';
import { ScrollTable } from '../../shared/components/ScrollTable';

const useStyles = makeStyles({
  filters: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalM, alignItems: 'flex-end' },
  tableWrap: { overflowX: 'auto', backgroundColor: tokens.colorNeutralBackground1, borderRadius: tokens.borderRadiusLarge, border: `1px solid ${tokens.colorNeutralStroke2}` },
  table: { minWidth: '860px' },
  time: { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
  more: { display: 'flex', justifyContent: 'center', paddingBlock: tokens.spacingVerticalM },
});

const modules = ['customers', 'identity'];
const entityTypes = ['Organization', 'Contact', 'OrganizationContact', 'User'];
const actions = ['Create', 'Update', 'Delete', 'Erase'];

function recordLink(entry: AuditEntry): string | null {
  if (entry.entityType === 'Organization') return `/organizations/${entry.entityId}`;
  if (entry.entityType === 'Contact') return `/contacts/${entry.entityId}`;
  return null;
}

export function AuditLogPage() {
  const styles = useStyles();
  const { t } = useTranslation();
  const allowed = useCan(Permissions.auditRead);
  const [filters, setFilters] = useState<AuditFilters>({});
  const { data, error, isPending, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useAuditLog(filters);
  if (!allowed) return <NotFoundPage />;

  const entries = data?.pages.flatMap((p) => p.items) ?? [];
  const select = (key: keyof AuditFilters, options: string[], label: (value: string) => string) => (
    <Field label={t(`audit.filters.${key}`)}>
      <Dropdown
        value={filters[key] ? label(filters[key]!) : t('common.all')}
        selectedOptions={[filters[key] ?? '']}
        onOptionSelect={(_, d) => setFilters((f) => ({ ...f, [key]: d.optionValue || undefined }))}
      >
        <Option value="">{t('common.all')}</Option>
        {options.map((o) => (
          <Option key={o} value={o}>
            {label(o)}
          </Option>
        ))}
      </Dropdown>
    </Field>
  );
  const date = (key: 'from' | 'to') => (
    <Field label={t(`audit.filters.${key}`)}>
      <Input
        type="date"
        value={filters[key]?.slice(0, 10) ?? ''}
        onChange={(_, d) => setFilters((f) => ({ ...f, [key]: d.value ? new Date(`${d.value}T00:00:00`).toISOString() : undefined }))}
      />
    </Field>
  );

  return (
    <>
      <PageHeader title={t('audit.title')} subtitle={t('audit.subtitle')} />
      <div className={styles.filters}>
        {select('module', modules, (v) => v)}
        {select('entityType', entityTypes, (v) => v)}
        {select('action', actions, (v) => v)}
        {date('from')}
        {date('to')}
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <ScrollTable className={styles.tableWrap}>
          <Table className={styles.table} aria-label={t('audit.title')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('audit.columns.at')}</TableHeaderCell>
                <TableHeaderCell>{t('audit.columns.user')}</TableHeaderCell>
                <TableHeaderCell>{t('audit.columns.action')}</TableHeaderCell>
                <TableHeaderCell>{t('audit.columns.record')}</TableHeaderCell>
                <TableHeaderCell>{t('audit.columns.changes')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => {
                const link = recordLink(entry);
                return (
                  <TableRow key={entry.id}>
                    <TableCell className={styles.time}>{formatDateTime(entry.at)}</TableCell>
                    <TableCell>{entry.userName ?? t('history.system')}</TableCell>
                    <TableCell>{entry.action}</TableCell>
                    <TableCell>{link && entry.action !== 'Delete' && !entry.erased ? <AppLink to={link}>{entry.entityType}</AppLink> : entry.entityType}</TableCell>
                    <TableCell>{entry.erased ? t('history.erased') : <ChangeList changes={entry.changes} />}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {!isPending && entries.length === 0 && <EmptyState message={t('audit.empty')} />}
          {hasNextPage && (
            <div className={styles.more}>
              <Button onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
                {t('common.loadMore')}
              </Button>
            </div>
          )}
        </ScrollTable>
      )}
    </>
  );
}
