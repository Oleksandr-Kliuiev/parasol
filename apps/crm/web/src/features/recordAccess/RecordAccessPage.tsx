import { useQuery } from '@tanstack/react-query';
import {
  MessageBar,
  MessageBarBody,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
} from '@fluentui/react-components';
import { Briefcase16Regular, DocumentText16Regular, People24Regular, ShieldKeyhole16Regular, Warning16Regular } from '@fluentui/react-icons';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { PersonCell } from '../admin/settingsUi';
import { api } from '../../api/client';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { EmptyState } from '../../shared/components/EmptyState';
import { FactGrid, Panel } from '../../shared/components/Panel';
import { formatNumber } from '../../shared/utils/format';

export interface RecordScopeReport {
  mode: 'Restricted' | 'Open';
  sections: RecordScopeSection[];
}

export interface RecordScopeSection {
  kind: string;
  everyRecordPermission: string;
  rolesSeeingAll: string[];
  rolesLimited: string[];
  total: number;
  withoutAssignee: number;
  assignees: { userId: string; name: string | null; active: boolean; records: number }[];
}

const useStyles = makeStyles({
  mode: { marginBottom: '16px' },
  // Two kinds of record side by side: the cards share the row instead of leaving an empty third column.
  cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))', gap: '16px', alignItems: 'start', minWidth: 0 },
  facts: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  body: { display: 'grid', gap: '16px', minWidth: 0 },
  // Who sees what: the two role lines in a quiet well, the totals under them.
  roles: {
    display: 'grid',
    gap: '6px',
    paddingTop: '12px',
    paddingBottom: '12px',
    paddingLeft: '16px',
    paddingRight: '16px',
    borderRadius: '14px',
    backgroundColor: h.well,
    fontSize: '13px',
    lineHeight: '20px',
  },
  warning: { display: 'flex', alignItems: 'flex-start', gap: '8px', color: h.saffronT, '& svg': { flexShrink: 0, marginTop: '2px' } },
  inactive: { color: h.saffronT },
  muted: { color: h.muted, fontSize: '13px' },
  hidden: { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' },
  number: { textAlign: 'end', fontVariantNumeric: 'tabular-nums' },
  numberHead: { width: '96px', textAlign: 'end', '& .fui-TableHeaderCell__button': { justifyContent: 'flex-end' } },
});

const kindIcon: Record<string, ReactElement> = { quotes: <DocumentText16Regular />, projects: <Briefcase16Regular /> };

/**
 * Who sees which quotes and projects (DEV-09, runbook 11): the roles that see all of them, the roles limited to their own or
 * assigned records, and how the records are spread over people — checked before the restricted mode reaches real data.
 */
export function RecordAccessPage() {
  const styles = useStyles();
  const { t } = useTranslation();
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ['admin', 'record-scope'],
    queryFn: async ({ signal }) => (await api.get<RecordScopeReport>('/api/v1/admin/record-scope', signal)).data,
  });
  const roles = (list: string[]) => list.map((role) => t(`appRoles.${role.replace('Crm.', '')}`)).join(', ');

  return (
    <>
      <PageHeader title={t('recordAccess.title')} subtitle={t('recordAccess.subtitle')} />
      {isPending ? (
        <Spinner label={t('common.loading')} />
      ) : error || !data ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <>
          <MessageBar intent={data.mode === 'Open' ? 'warning' : 'info'} className={styles.mode}>
            <MessageBarBody>{t(`recordAccess.mode.${data.mode}`)}</MessageBarBody>
          </MessageBar>
          <div className={styles.cards}>
            {data.sections.map((section) => (
              <Panel key={section.kind} title={t(`recordAccess.kind.${section.kind}`)} icon={kindIcon[section.kind] ?? <ShieldKeyhole16Regular />}>
                <div className={styles.body}>
                  <div className={styles.roles}>
                    <Text>{t('recordAccess.seeAll', { roles: roles(section.rolesSeeingAll) })}</Text>
                    <Text>{t('recordAccess.limited', { roles: roles(section.rolesLimited) })}</Text>
                  </div>
                  <FactGrid
                    className={styles.facts}
                    items={[
                      { label: t('recordAccess.records'), value: formatNumber(section.total, 0) },
                      { label: t('recordAccess.people'), value: formatNumber(section.assignees.length, 0) },
                    ]}
                  />
                  {section.withoutAssignee > 0 && (
                    <span className={styles.warning}>
                      <Warning16Regular aria-hidden />
                      <Text>{t('recordAccess.withoutAssignee', { value: formatNumber(section.withoutAssignee, 0) })}</Text>
                    </span>
                  )}
                  {section.assignees.length === 0 ? (
                    <EmptyState message={t('recordAccess.nobody')} icon={<People24Regular />} />
                  ) : (
                    <Table aria-label={t('recordAccess.tableLabel', { kind: t(`recordAccess.kind.${section.kind}`) })} size="small">
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>{t('recordAccess.person')}</TableHeaderCell>
                          <TableHeaderCell className={styles.numberHead}>{t('recordAccess.records')}</TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {section.assignees.map((person) => (
                          <TableRow key={person.userId}>
                            <TableCell>
                              <PersonCell
                                name={person.name ?? t('recordAccess.unknownUser')}
                                size={28}
                                detail={
                                  !person.active && (
                                    // The separator keeps the cell reading "name · inactive" for a screen reader.
                                    <span className={styles.inactive}>
                                      <span className={styles.hidden}> · </span>
                                      {t('recordAccess.inactive')}
                                    </span>
                                  )
                                }
                              />
                            </TableCell>
                            <TableCell className={styles.number}>{formatNumber(person.records, 0)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>
              </Panel>
            ))}
          </div>
        </>
      )}
    </>
  );
}
