import { useState } from 'react';
import { Badge, Button, DialogSurface, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, makeStyles, useRestoreFocusTarget } from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import { Add20Regular, Briefcase16Regular, Briefcase24Regular } from '@fluentui/react-icons';
import { RecordCell } from '../organizations/RecordCell';
import { useRecordStyles } from '../organizations/recordStyles';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ListFooter } from '../../shared/components/ListFooter';
import { ErrorState } from '../../shared/components/ErrorState';
import { Panel } from '../../shared/components/Panel';
import { formatDate, formatNumber } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { ProjectDialog } from './ProjectDialog';
import { statusColor } from './shared';
import { useProjects } from './api';
import { ScrollTable } from '../../shared/components/ScrollTable';

const useStyles = makeStyles({ person: { fontWeight: 500, fontSize: '13px' } });

/** Implementation projects of one customer (docs/02 §4.10), in the card every list of the customer's tabs has. */
export function OrganizationProjectsTab({ organizationId, organizationName }: { organizationId: string; organizationName: string }) {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const record = useRecordStyles();
  const { t } = useTranslation();
  const canWrite = useCan(Permissions.projectsWrite);
  const restoreFocusTarget = useRestoreFocusTarget();
  const [creating, setCreating] = useState(false);
  const projects = useProjects({ organizationId });
  const { items: data, error, isPending, refetch } = projects;

  return (
    <>
      <Panel
        title={t('projects.title')}
        icon={<Briefcase16Regular />}
        actions={
          canWrite && (
            <Button {...restoreFocusTarget} size="small" icon={<Add20Regular />} onClick={() => setCreating(true)}>
              {t('projects.new')}
            </Button>
          )
        }
      >
        {error ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : isPending ? null : data.length === 0 ? (
          <EmptyState icon={<Briefcase24Regular />} message={t('projects.emptyForOrganization')} />
        ) : (
          <ScrollTable className={record.flatTable}>
            <Table className={catalog.table} style={{ minWidth: 940 }} aria-label={t('projects.title')}>
              <TableHeader>
                <TableRow>
                  {/* Content widths: every cell adds 12 px of padding on each side; the project takes the rest. */}
                  <TableHeaderCell>{t('projects.fields.project')}</TableHeaderCell>
                  <TableHeaderCell style={{ width: 96 }}>{t('projects.fields.status')}</TableHeaderCell>
                  <TableHeaderCell style={{ width: 136 }}>{t('projects.fields.manager')}</TableHeaderCell>
                  <TableHeaderCell style={{ width: 178 }}>{t('projects.fields.period')}</TableHeaderCell>
                  <TableHeaderCell className={catalog.number} style={{ width: 116 }}>{t('projects.fields.hours')}</TableHeaderCell>
                  <TableHeaderCell className={catalog.number} style={{ width: 56 }}>{t('projects.fields.phases')}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((project) => (
                  <TableRow key={project.id}>
                    <TableCell>
                      <RecordCell
                        icon={<Briefcase16Regular />}
                        tone="iris"
                        name={<AppLink to={`/projects/${project.id}`} className={catalog.name}>{project.name}</AppLink>}
                        meta={[project.number, t(`projects.types.${project.type}`)]}
                      />
                    </TableCell>
                    <TableCell>
                      <Badge appearance="tint" color={statusColor(project.status)}>
                        {t(`projects.statuses.${project.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {project.manager ? <RecordCell avatarName={project.manager.name} size={28} name={<span className={styles.person}>{project.manager.name}</span>} /> : '—'}
                    </TableCell>
                    <TableCell className="tabular">
                      {formatDate(project.startDate)}
                      {project.endDate ? ` – ${formatDate(project.endDate)}` : ''}
                    </TableCell>
                    <TableCell className={catalog.number}>
                      {t('projects.hoursOfBudget', { hours: formatNumber(project.hours, 1), budget: formatNumber(project.budgetHours, 0) })}
                    </TableCell>
                    <TableCell className={catalog.number}>
                      {project.phasesDone}/{project.phases}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollTable>
        )}
        <ListFooter shown={data.length} total={projects.total} hasMore={projects.hasNextPage} loading={projects.isFetchingNextPage} onMore={() => void projects.fetchNextPage()} />
      </Panel>

      <Dialog open={creating} onOpenChange={(_, d) => !d.open && setCreating(false)}>
        <DialogSurface>
          <ProjectDialog organization={{ id: organizationId, name: organizationName }} onClose={() => setCreating(false)} />
        </DialogSurface>
      </Dialog>
    </>
  );
}
