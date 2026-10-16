import { useState } from 'react';
import { Badge, Button, Dialog, DialogSurface, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, useRestoreFocusTarget } from '@fluentui/react-components';
import { Add20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ListFooter } from '../../shared/components/ListFooter';
import { ErrorState } from '../../shared/components/ErrorState';
import { formatDate, formatNumber } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { ProjectDialog } from './ProjectDialog';
import { statusColor } from './shared';
import { useProjects } from './api';

/** Implementation projects of one customer (docs/02 §4.10). */
export function OrganizationProjectsTab({ organizationId, organizationName }: { organizationId: string; organizationName: string }) {
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const canWrite = useCan(Permissions.projectsWrite);
  const restoreFocusTarget = useRestoreFocusTarget();
  const [creating, setCreating] = useState(false);
  const projects = useProjects({ organizationId });
  const { items: data, error, isPending, refetch } = projects;

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  return (
    <>
      {canWrite && (
        <div className={catalog.filters}>
          <Button {...restoreFocusTarget} icon={<Add20Regular />} onClick={() => setCreating(true)}>
            {t('projects.new')}
          </Button>
        </div>
      )}
      <div className={catalog.tableWrap}>
        <Table className={catalog.table} aria-label={t('projects.title')}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>{t('projects.fields.project')}</TableHeaderCell>
              <TableHeaderCell>{t('projects.fields.status')}</TableHeaderCell>
              <TableHeaderCell>{t('projects.fields.manager')}</TableHeaderCell>
              <TableHeaderCell>{t('projects.fields.period')}</TableHeaderCell>
              <TableHeaderCell className={catalog.number}>{t('projects.fields.hours')}</TableHeaderCell>
              <TableHeaderCell className={catalog.number}>{t('projects.fields.phases')}</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((project) => (
              <TableRow key={project.id}>
                <TableCell>
                  <AppLink to={`/projects/${project.id}`}>{project.name}</AppLink>
                  <div className={catalog.sku}>
                    {project.number} · {t(`projects.types.${project.type}`)}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge appearance="outline" color={statusColor(project.status)}>
                    {t(`projects.statuses.${project.status}`)}
                  </Badge>
                </TableCell>
                <TableCell>{project.manager?.name ?? '—'}</TableCell>
                <TableCell className="tabular">
                  {formatDate(project.startDate)}
                  {project.endDate ? ` – ${formatDate(project.endDate)}` : ''}
                </TableCell>
                <TableCell className={catalog.number}>
                  {formatNumber(project.hours, 1)} / {formatNumber(project.budgetHours, 0)}
                </TableCell>
                <TableCell className={catalog.number}>
                  {project.phasesDone}/{project.phases}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!isPending && data.length === 0 && <EmptyState message={t('projects.emptyForOrganization')} />}
        <ListFooter shown={data.length} total={projects.total} hasMore={projects.hasNextPage} loading={projects.isFetchingNextPage} onMore={() => void projects.fetchNextPage()} />
      </div>

      <Dialog open={creating} onOpenChange={(_, d) => !d.open && setCreating(false)}>
        <DialogSurface>
          {creating && (
            <ProjectDialog organization={{ id: organizationId, name: organizationName }} onClose={() => setCreating(false)} />
          )}
        </DialogSurface>
      </Dialog>
    </>
  );
}
