import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  Badge,
  Button,
  Dialog,
  DialogSurface,
  ProgressBar,
  SearchBox,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Add20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { formatDate, formatNumber } from '../../shared/utils/format';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import { useCatalogStyles } from '../catalog/styles';
import { ProjectDialog } from './ProjectDialog';
import { useProjects } from './api';
import { statusColor } from './shared';

const useStyles = makeStyles({
  progress: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: '140px' },
  over: { color: tokens.colorPaletteDarkOrangeForeground1 },
});

/** Implementation projects across customers (FR-PRJ-01). */
export function ProjectsPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canWrite = useCan(Permissions.projectsWrite);
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const debounced = useDebouncedValue(search.trim());
  const restoreFocusTarget = useRestoreFocusTarget();
  const openOnly = params.get('all') !== 'true';
  const { data = [], error, isPending, refetch } = useProjects({ search: debounced, openOnly });

  return (
    <>
      <PageHeader
        title={t('projects.title')}
        subtitle={t('projects.subtitle')}
        actions={
          canWrite && (
            <Button {...restoreFocusTarget} appearance="primary" icon={<Add20Regular />} onClick={() => setCreating(true)}>
              {t('projects.new')}
            </Button>
          )
        }
      />

      <div className={catalog.filters}>
        <SearchBox
          id="projects-search"
          className={catalog.search}
          value={search}
          onChange={(_, d) => setSearch(d.value)}
          placeholder={t('projects.search')}
          aria-label={t('projects.search')}
        />
        <Switch
          label={t('projects.filters.includeClosed')}
          checked={!openOnly}
          onChange={(_, d) => {
            const next = new URLSearchParams(params);
            if (d.checked) next.set('all', 'true');
            else next.delete('all');
            setParams(next, { replace: true });
          }}
        />
      </div>

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <div className={catalog.tableWrap}>
          <Table className={catalog.table} aria-label={t('projects.title')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('projects.fields.project')}</TableHeaderCell>
                <TableHeaderCell>{t('projects.fields.customer')}</TableHeaderCell>
                <TableHeaderCell>{t('projects.fields.status')}</TableHeaderCell>
                <TableHeaderCell>{t('projects.fields.manager')}</TableHeaderCell>
                <TableHeaderCell>{t('projects.fields.period')}</TableHeaderCell>
                <TableHeaderCell>{t('projects.fields.hours')}</TableHeaderCell>
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
                    <AppLink to={`/organizations/${project.organization.id}?tab=projects`}>{project.organization.name}</AppLink>
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
                  <TableCell>
                    <div className={styles.progress}>
                      <Text className={project.budgetHours > 0 && project.hours > project.budgetHours ? styles.over : undefined}>
                        {t('projects.hoursOfBudget', { hours: formatNumber(project.hours, 1), budget: formatNumber(project.budgetHours, 0) })}
                      </Text>
                      {project.budgetHours > 0 && (
                        <ProgressBar
                          value={Math.min(project.hours / project.budgetHours, 1)}
                          color={project.hours > project.budgetHours ? 'warning' : 'brand'}
                          aria-label={t('projects.fields.hours')}
                        />
                      )}
                    </div>
                  </TableCell>
                  <TableCell className={catalog.number}>
                    {project.phasesDone}/{project.phases}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!isPending && data.length === 0 && <EmptyState message={t('projects.empty')} />}
        </div>
      )}

      <Dialog open={creating} onOpenChange={(_, d) => !d.open && setCreating(false)}>
        <DialogSurface>
          {creating && (
            <ProjectDialog
              onClose={() => setCreating(false)}
              onCreated={(id) => {
                setCreating(false);
                void navigate(`/projects/${id}`);
              }}
            />
          )}
        </DialogSurface>
      </Dialog>
    </>
  );
}
