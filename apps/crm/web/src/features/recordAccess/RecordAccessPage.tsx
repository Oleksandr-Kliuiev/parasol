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
  tokens,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
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
  lines: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, marginBottom: tokens.spacingVerticalM },
  warning: { color: tokens.colorPaletteDarkOrangeForeground1 },
  muted: { color: tokens.colorNeutralForeground3 },
  number: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
});

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
          <MessageBar intent={data.mode === 'Open' ? 'warning' : 'info'} style={{ marginBottom: tokens.spacingVerticalM }}>
            <MessageBarBody>{t(`recordAccess.mode.${data.mode}`)}</MessageBarBody>
          </MessageBar>
          {data.sections.map((section) => (
            <Panel key={section.kind} title={t(`recordAccess.kind.${section.kind}`)}>
              <div className={styles.lines}>
                <Text>{t('recordAccess.seeAll', { roles: roles(section.rolesSeeingAll) })}</Text>
                <Text>{t('recordAccess.limited', { roles: roles(section.rolesLimited) })}</Text>
                <Text>{t('recordAccess.total', { value: formatNumber(section.total, 0) })}</Text>
                {section.withoutAssignee > 0 && (
                  <Text className={styles.warning}>{t('recordAccess.withoutAssignee', { value: formatNumber(section.withoutAssignee, 0) })}</Text>
                )}
              </div>
              {section.assignees.length === 0 ? (
                <Text className={styles.muted}>{t('recordAccess.nobody')}</Text>
              ) : (
                <Table aria-label={t('recordAccess.tableLabel', { kind: t(`recordAccess.kind.${section.kind}`) })} size="small">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>{t('recordAccess.person')}</TableHeaderCell>
                      <TableHeaderCell className={styles.number}>{t('recordAccess.records')}</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {section.assignees.map((person) => (
                      <TableRow key={person.userId}>
                        <TableCell>
                          {person.name ?? t('recordAccess.unknownUser')}
                          {!person.active && <Text className={styles.warning}>{` · ${t('recordAccess.inactive')}`}</Text>}
                        </TableCell>
                        <TableCell className={styles.number}>{formatNumber(person.records, 0)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Panel>
          ))}
        </>
      )}
    </>
  );
}
