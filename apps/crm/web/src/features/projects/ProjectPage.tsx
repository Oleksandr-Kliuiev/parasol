import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  Badge,
  Button,
  DialogSurface,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  ProgressBar,
  Spinner,
  makeStyles,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import { CheckmarkCircle16Regular, Clock16Regular, Delete20Regular, Edit20Regular, Money16Regular, MoreHorizontal20Regular, Receipt16Regular, Timer16Regular } from '@fluentui/react-icons';
import { StatGrid, StatTile } from '../../shared/components/KpiTile';
import { ProjectTeam } from './ProjectTeamPanel';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { ConfirmDialog } from '../../shared/components/ConfirmDialog';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { useKeptWhileClosing } from '../../shared/components/useKeptWhileClosing';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatMoney, formatNumber } from '../../shared/utils/format';
import { MetaLine } from '../organizations/RecordCell';
import { NotFoundPage } from '../errors/NotFoundPage';
import { ProjectDialog } from './ProjectDialog';
import { PhaseForm, TaskForm } from './ProjectPhaseForms';
import { ProjectPhases } from './ProjectPhases';
import { statusColor } from './shared';
import { useProject, useProjectActions } from './api';
import { projectStatuses, type ProjectPhase, type ProjectTask } from './types';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: '16px' },
  meter: { marginTop: '6px' },
  meta: { fontSize: '13px', lineHeight: '18px' },
});

/** One implementation project: phases, tasks and plan against actual (FR-PRJ-01). */
export function ProjectPage() {
  const styles = useStyles();
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const notify = useNotify();
  const canWrite = useCan(Permissions.projectsWrite);
  const canSeeMoney = useCan(Permissions.financeRead);
  const { data: project, error, isPending, refetch } = useProject(id);
  const actions = useProjectActions(id);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [phase, setPhase] = useState<ProjectPhase | 'new' | null>(null);
  const [task, setTask] = useState<{ phaseId: string; task?: ProjectTask } | null>(null);
  const shownPhase = useKeptWhileClosing(phase);
  const shownTask = useKeptWhileClosing(task);
  const restoreFocusTarget = useRestoreFocusTarget();

  if (isPending) return <Spinner label={t('common.loading')} />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  if (error || !project) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const run = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      notify(success);
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  const { progress } = project;
  const overBudget = progress.budgetHours > 0 && progress.hours > progress.budgetHours;

  return (
    <>
      <PageHeader
        back={{ to: '/projects', label: t('projects.title') }}
        title={project.name}
        meta={
          <>
            <Badge appearance="tint" color={statusColor(project.status)}>
              {t(`projects.statuses.${project.status}`)}
            </Badge>
            <MetaLine
              className={styles.meta}
              parts={[
                <span>{project.number}</span>,
                <AppLink to={`/organizations/${project.organization.id}?tab=projects`}>{project.organization.name}</AppLink>,
                <span>{t(`projects.types.${project.type}`)}</span>,
                <span className="tabular">
                  {formatDate(project.startDate)}
                  {project.endDate ? ` – ${formatDate(project.endDate)}` : ''}
                </span>,
              ]}
            />
          </>
        }
        actions={
          canWrite && (
            <>
              <Button {...restoreFocusTarget} icon={<Edit20Regular />} onClick={() => setEditing(true)}>
                {t('common.edit')}
              </Button>
              <Menu>
                <MenuTrigger disableButtonEnhancement>
                  <Button appearance="primary">{t('projects.setStatus')}</Button>
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    {projectStatuses
                      .filter((status) => status !== project.status)
                      .map((status) => (
                        <MenuItem key={status} onClick={() => void run(() => actions.setStatus.mutateAsync(status), t('projects.statusChanged'))}>
                          {t(`projects.statuses.${status}`)}
                        </MenuItem>
                      ))}
                  </MenuList>
                </MenuPopover>
              </Menu>
              {/* Only a project that has not started can be deleted (it is cancelled otherwise); a rare step, so it asks first. */}
              {project.status === 'Planned' && (
                <Menu positioning="below-end">
                  <MenuTrigger disableButtonEnhancement>
                    <Button {...restoreFocusTarget} icon={<MoreHorizontal20Regular />} aria-label={t('projects.moreActions')} />
                  </MenuTrigger>
                  <MenuPopover>
                    <MenuList>
                      <MenuItem icon={<Delete20Regular />} onClick={() => setDeleting(true)}>{t('projects.delete')}</MenuItem>
                    </MenuList>
                  </MenuPopover>
                </Menu>
              )}
            </>
          )
        }
      />
      <ConfirmDialog open={deleting} title={t('projects.deleteTitle', { name: project.name })} confirm={t('projects.delete')}
        busy={actions.remove.isPending} error={actions.remove.error ? errorMessage(actions.remove.error, t) : null}
        onCancel={() => { setDeleting(false); actions.remove.reset(); }}
        onConfirm={() => void actions.remove.mutateAsync().then(() => { notify(t('projects.deleted')); void navigate('/projects'); }, () => undefined)}>
        {t('projects.deleteBody', { phases: project.phases.length, tasks: project.phases.reduce((n, phase) => n + phase.tasks.length, 0) })}
      </ConfirmDialog>

      <StatGrid label={t('projects.fields.hours')}>
        <StatTile
          icon={<Clock16Regular />}
          tone="iris"
          label={t('projects.progress.hours')}
          value={formatNumber(progress.hours, 1)}
          status={overBudget ? 'bad' : undefined}
          note={
            progress.budgetHours > 0 ? (
              <>
                {t('projects.progress.hoursNote', { budget: formatNumber(progress.budgetHours, 0) })}
                <ProgressBar
                  className={styles.meter}
                  value={Math.min(progress.hours / progress.budgetHours, 1)}
                  color={overBudget ? 'warning' : 'brand'}
                  aria-label={t('projects.fields.hours')}
                />
              </>
            ) : undefined
          }
        />
        <StatTile icon={<Timer16Regular />} tone="spruce" label={t('projects.progress.billableHours')} value={formatNumber(progress.billableHours, 1)} />
        {canSeeMoney && (
          <>
            <StatTile
              icon={<Money16Regular />}
              tone="ember"
              label={t('projects.progress.amount')}
              value={formatMoney(progress.amount ?? 0)}
              note={t('projects.progress.amountNote', { budget: formatMoney(progress.budgetAmount ?? 0) })}
            />
            <StatTile
              icon={<Receipt16Regular />}
              tone="saffron"
              label={t('projects.progress.phaseFees')}
              value={formatMoney(progress.phaseFeesCompleted ?? 0)}
              note={t('projects.progress.phaseFeesNote')}
            />
          </>
        )}
        <StatTile
          icon={<CheckmarkCircle16Regular />}
          tone="neutral"
          label={t('projects.progress.phases')}
          value={`${progress.phasesDone}/${progress.phases}`}
          note={t('projects.progress.openTasks', { count: progress.openTasks })}
        />
      </StatGrid>

      <div className={styles.stack}>
        <ProjectTeam project={project} canWrite={canWrite} />
        <ProjectPhases
          project={project}
          canWrite={canWrite}
          canSeeMoney={canSeeMoney}
          run={run}
          onAddPhase={() => setPhase('new')}
          onEditPhase={setPhase}
          onTask={(phaseId, item) => setTask({ phaseId, task: item })}
        />
      </div>

      <Dialog open={editing} onOpenChange={(_, d) => !d.open && setEditing(false)}>
        <DialogSurface><ProjectDialog project={project} onClose={() => setEditing(false)} /></DialogSurface>
      </Dialog>
      <Dialog open={phase !== null} onOpenChange={(_, d) => !d.open && setPhase(null)}>
        <DialogSurface>
          {shownPhase !== null && <PhaseForm project={project} phase={shownPhase === 'new' ? undefined : shownPhase} onClose={() => setPhase(null)} />}
        </DialogSurface>
      </Dialog>
      <Dialog open={task !== null} onOpenChange={(_, d) => !d.open && setTask(null)}>
        <DialogSurface>
          {shownTask !== null && <TaskForm projectId={project.id} phaseId={shownTask.phaseId} task={shownTask.task} onClose={() => setTask(null)} />}
        </DialogSurface>
      </Dialog>
    </>
  );
}
