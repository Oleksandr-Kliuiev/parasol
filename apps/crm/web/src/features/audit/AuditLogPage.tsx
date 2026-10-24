import { useState } from 'react';
import {
  Badge,
  Button,
  Dropdown,
  Input,
  Option,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { History24Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { ScrollTable } from '../../shared/components/ScrollTable';
import { FilterField, Toolbar } from '../../shared/components/Toolbar';
import { formatDateTime } from '../../shared/utils/format';
import { addDays } from '../../shared/utils/week';
import { useMediaQuery } from '../../shared/utils/useMediaQuery';
import { ForbiddenPage } from '../errors/ForbiddenPage';
import { useAuditLog, type AuditFilters } from './api';
import { AuditActor } from './AuditActor';
import { AuditEntryCards } from './AuditEntryCards';
import { ChangeList } from './ChangeList';
import { actionColor, recordLink } from './entries';
import { useAuditLabels } from './labels';

/** Local midnight of a chosen day (YYYY-MM-DD), the way the date field shows it. */
const startOfDay = (day: string) => new Date(`${day}T00:00:00`).toISOString();

const useStyles = makeStyles({
  // A select or a date of the filter row keeps its size; on a phone two selects share a line and the dates the next one.
  slot: { flex: '0 1 auto', minWidth: 0, '@media (max-width: 560px)': { flex: '1 1 calc(50% - 5px)' } },
  period: { display: 'flex', gap: '10px', flex: '0 1 auto', minWidth: 0, '@media (max-width: 560px)': { flex: '1 1 100%', '& > *': { flex: '1 1 0', minWidth: 0 } } },
  control: { minWidth: '170px', width: '100%', '@media (max-width: 560px)': { minWidth: 0 } },
  date: { width: '190px', '@media (max-width: 560px)': { width: '100%', minWidth: 0 } },
  // The field's own word ("From", "To") in front of the date, since the filter row has no labels above its controls.
  prefix: { color: h.muted, fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap' },
  // Column widths are content widths (the cells add 12 px on each side): the changes get the rest of the row.
  table: { minWidth: '900px', tableLayout: 'fixed' },
  colTime: { width: '120px' },
  colUser: { width: '160px' },
  colAction: { width: '136px' },
  colRecord: { width: '150px' },
  // Rows grow with their changes, so every cell starts at the top; Fluent fixes the cell height, these rows do not.
  cell: { verticalAlign: 'top', height: 'auto', paddingTop: '12px', paddingBottom: '12px' },
  // Single-line cells centre on the 28 px avatar line, so time, user, action and record read as one row.
  line: { display: 'flex', alignItems: 'center', minHeight: '28px' },
  changes: { verticalAlign: 'top', height: 'auto', paddingTop: '17px', paddingBottom: '12px' },
  time: { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: h.muted, fontSize: '13px' },
  record: { display: 'grid', alignContent: 'center', minHeight: '28px', minWidth: 0 },
  recordName: { fontWeight: tokens.fontWeightSemibold, overflowWrap: 'anywhere' },
  module: { color: h.muted, fontSize: '12px', lineHeight: '16px' },
  erased: { color: h.muted, fontSize: '13px' },
  more: { display: 'flex', justifyContent: 'center', paddingTop: '12px', paddingBottom: '12px', borderTop: `1px solid ${h.line}` },
  morePhone: { display: 'flex', justifyContent: 'center', paddingTop: '16px' },
});

// The values the filters offer: those the log is written with (the server filters on the exact value).
const modules = ['customers', 'identity', 'integration'];
const entityTypes = ['Organization', 'Contact', 'OrganizationContact', 'User', 'UserSession'];
const actions = ['Create', 'Update', 'Delete', 'Erase', 'Login', 'Logout'];

export function AuditLogPage() {
  const styles = useStyles();
  const { t } = useTranslation();
  const labels = useAuditLabels();
  const allowed = useCan(Permissions.auditRead);
  const phone = useMediaQuery('(max-width: 720px)');
  const [filters, setFilters] = useState<AuditFilters>({});
  // The period is chosen in whole days and both days count: "to" is sent as the start of the next day, which the
  // server compares exclusively. A one-day period (from = to) is then that whole day, not an empty instant.
  const [days, setDays] = useState<{ from?: string; to?: string }>({});
  const { data, error, isPending, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useAuditLog({
    ...filters, from: days.from && startOfDay(days.from), to: days.to && startOfDay(addDays(days.to, 1)),
  });
  if (!allowed) return <ForbiddenPage />;

  const entries = data?.pages.flatMap((p) => p.items) ?? [];
  const select = (key: 'module' | 'entityType' | 'action', options: string[], label: (value: string) => string) => (
    <div className={styles.slot}>
      <FilterField label={t(`audit.filters.${key}`)}>
        <Dropdown
          className={styles.control}
          value={filters[key] ? label(filters[key]!) : t(`audit.filters.all.${key}`)}
          selectedOptions={[filters[key] ?? '']}
          onOptionSelect={(_, d) => setFilters((f) => ({ ...f, [key]: d.optionValue || undefined }))}
        >
          <Option value="">{t(`audit.filters.all.${key}`)}</Option>
          {options.map((o) => (
            <Option key={o} value={o}>
              {label(o)}
            </Option>
          ))}
        </Dropdown>
      </FilterField>
    </div>
  );
  const date = (key: 'from' | 'to') => (
    <FilterField label={t(`audit.filters.${key}`)}>
      <Input
        className={styles.date}
        type="date"
        contentBefore={<span className={styles.prefix} aria-hidden>{t(`audit.filters.${key}`)}</span>}
        value={days[key] ?? ''}
        onChange={(_, d) => setDays((current) => ({ ...current, [key]: d.value || undefined }))}
      />
    </FilterField>
  );

  return (
    <>
      <PageHeader title={t('audit.title')} subtitle={t('audit.subtitle')} />
      <Toolbar label={t('audit.filters.label')}>
        {select('module', modules, labels.module)}
        {select('entityType', entityTypes, labels.entityType)}
        {select('action', actions, labels.action)}
        <div className={styles.period}>
          {date('from')}
          {date('to')}
        </div>
      </Toolbar>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : phone ? (
        <>
          {entries.length > 0 ? <AuditEntryCards entries={entries} /> : !isPending && <Panel><EmptyState message={t('audit.empty')} icon={<History24Regular />} /></Panel>}
          {hasNextPage && (
            <div className={styles.morePhone}>
              <Button onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
                {t('common.loadMore')}
              </Button>
            </div>
          )}
        </>
      ) : (
        <ScrollTable>
          <Table className={styles.table} aria-label={t('audit.title')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell className={styles.colTime}>{t('audit.columns.at')}</TableHeaderCell>
                <TableHeaderCell className={styles.colUser}>{t('audit.columns.user')}</TableHeaderCell>
                <TableHeaderCell className={styles.colAction}>{t('audit.columns.action')}</TableHeaderCell>
                <TableHeaderCell className={styles.colRecord}>{t('audit.columns.record')}</TableHeaderCell>
                <TableHeaderCell>{t('audit.columns.changes')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => {
                const link = recordLink(entry);
                const type = labels.entityType(entry.entityType);
                return (
                  <TableRow key={entry.id}>
                    <TableCell className={mergeClasses(styles.cell, styles.time)}>
                      <span className={styles.line}>{formatDateTime(entry.at)}</span>
                    </TableCell>
                    <TableCell className={styles.cell}>
                      <AuditActor entry={entry} />
                    </TableCell>
                    <TableCell className={styles.cell}>
                      <span className={styles.line}>
                        <Badge appearance="tint" color={actionColor(entry.action)}>{labels.action(entry.action)}</Badge>
                      </span>
                    </TableCell>
                    <TableCell className={styles.cell}>
                      <span className={styles.record}>
                        <span className={styles.recordName}>
                          {link && entry.action !== 'Delete' && !entry.erased ? <AppLink to={link}>{type}</AppLink> : type}
                        </span>
                        <span className={styles.module}>{labels.module(entry.module)}</span>
                      </span>
                    </TableCell>
                    <TableCell className={styles.changes}>
                      {entry.erased ? <span className={styles.erased}>{t('history.erased')}</span> : <ChangeList changes={entry.changes} entityType={entry.entityType} />}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {!isPending && entries.length === 0 && <EmptyState message={t('audit.empty')} icon={<History24Regular />} />}
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
