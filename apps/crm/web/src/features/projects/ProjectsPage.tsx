import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  Badge,
  Button,
  DialogSurface,
  ProgressBar,
  SearchBox,
  Skeleton,
  SkeletonItem,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import { Add20Regular, Briefcase16Regular, Briefcase24Regular } from '@fluentui/react-icons';
import { RecordCell } from '../organizations/RecordCell';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan, useCurrentUser } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ListFooter } from '../../shared/components/ListFooter';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { FilterField, Toolbar } from '../../shared/components/Toolbar';
import { formatDate, formatNumber } from '../../shared/utils/format';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import { useCatalogStyles } from '../catalog/styles';
import { ProjectDialog } from './ProjectDialog';
import { useProjects } from './api';
import { statusColor } from './shared';
import { SavedViews } from '../../shared/views/SavedViews';
import { ScrollTable } from '../../shared/components/ScrollTable';
import { h } from '../../app/hearth';

const useStyles = makeStyles({
  progress: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px', fontVariantNumeric: 'tabular-nums' },
  person: { fontWeight: 500, fontSize: '13px' },
  orgLink: { color: 'inherit', fontWeight: 600 },
  over: { color: h.saffronT },
});

/** Implementation projects across customers (FR-PRJ-01). */
export function ProjectsPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canWrite = useCan(Permissions.projectsWrite);
  // DEV-09: a technician sees the projects they are on, and is told so.
  const allProjects = useCurrentUser().recordScope.allProjects;
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const debounced = useDebouncedValue(search.trim());
  const restoreFocusTarget = useRestoreFocusTarget();
  const openOnly = params.get('all') !== 'true';
  const projects = useProjects({ search: debounced, openOnly }, true, { keepPrevious: true });
  const { items: data, error, isPending, refetch } = projects;
  // While another search or filter is read, the previous rows stay where they are, so a click on one still lands. They are not its
  // answer: the end of the list says it is loading, and no count or empty answer is claimed for them.
  const stale = projects.isPlaceholderData;
  const loading = isPending || (stale && data.length === 0);

  return (
    <>
      <PageHeader
        title={t('projects.title')}
        subtitle={allProjects ? t('projects.subtitle') : t('projects.scopeAssigned')}
        actions={
          <>
            <SavedViews scope="projects" keys={['all']} />
            {canWrite && (
              <Button {...restoreFocusTarget} appearance="primary" icon={<Add20Regular />} onClick={() => setCreating(true)}>
                {t('projects.new')}
              </Button>
            )}
          </>
        }
      />

      <Toolbar label={t('projects.filterLabel')}>
        <FilterField kind="search" label={t('projects.search')}>
          <SearchBox id="projects-search" value={search} onChange={(_, d) => setSearch(d.value)} placeholder={t('projects.search')} />
        </FilterField>
        <Switch
          className={catalog.toggle}
          label={t('projects.filters.includeClosed')}
          checked={!openOnly}
          onChange={(_, d) => {
            const next = new URLSearchParams(params);
            if (d.checked) next.set('all', 'true');
            else next.delete('all');
            setParams(next, { replace: true });
          }}
        />
      </Toolbar>

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <ScrollTable className={catalog.tableWrap}>
          <Table className={catalog.table} style={{ minWidth: 1060 }} aria-label={t('projects.title')} aria-busy={stale || undefined}>
            <TableHeader>
              <TableRow>
                {/* Content widths: every cell adds 12 px of padding on each side; project and customer share the rest. */}
                <TableHeaderCell>{t('projects.fields.project')}</TableHeaderCell>
                <TableHeaderCell>{t('projects.fields.customer')}</TableHeaderCell>
                <TableHeaderCell style={{ width: 96 }}>{t('projects.fields.status')}</TableHeaderCell>
                <TableHeaderCell style={{ width: 136 }}>{t('projects.fields.manager')}</TableHeaderCell>
                <TableHeaderCell style={{ width: 178 }}>{t('projects.fields.period')}</TableHeaderCell>
                <TableHeaderCell style={{ width: 116 }}>{t('projects.fields.hours')}</TableHeaderCell>
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
                    <RecordCell
                      avatarName={project.organization.name}
                      size={28}
                      name={<AppLink to={`/organizations/${project.organization.id}?tab=projects`} className={styles.orgLink}>{project.organization.name}</AppLink>}
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
          {loading && <Skeleton aria-label={t('common.loading')}><SkeletonItem size={48} /></Skeleton>}
          {!loading && data.length === 0 && <EmptyState icon={<Briefcase24Regular />} message={t('projects.empty')} />}
          <ListFooter shown={data.length} total={projects.total} hasMore={projects.hasNextPage} loading={projects.isFetchingNextPage} onMore={() => void projects.fetchNextPage()}
            stale={stale} />
        </ScrollTable>
      )}

      <Dialog open={creating} onOpenChange={(_, d) => !d.open && setCreating(false)}>
        <DialogSurface>
          <ProjectDialog
            onClose={() => setCreating(false)}
            onCreated={(id) => {
              setCreating(false);
              void navigate(`/projects/${id}`);
            }}
          />
        </DialogSurface>
      </Dialog>
    </>
  );
}
