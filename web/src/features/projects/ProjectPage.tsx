import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Option,
  ProgressBar,
  Spinner,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Textarea,
  makeStyles,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Add20Regular, Delete20Regular, Dismiss16Regular, Edit20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { UserPicker } from '../../shared/components/UserPicker';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { blankToNull, formatDate, formatMoney, formatNumber, parseDecimal } from '../../shared/utils/format';
import type { UserRef } from '../../api/types';
import { useCatalogStyles } from '../catalog/styles';
import { useDialogStyles } from '../contracts/dialogStyles';
import { NotFoundPage } from '../errors/NotFoundPage';
import { ProjectDialog } from './ProjectDialog';
import { statusColor } from './shared';
import { useProject, useProjectActions } from './api';
import { phaseStatuses, projectStatuses, taskStatuses, type Project, type ProjectPhase, type ProjectPhaseStatus, type ProjectTask, type ProjectTaskStatus } from './types';

const useStyles = makeStyles({
  tiles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(170px, 100%), 1fr))', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalL },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  value: { fontSize: tokens.fontSizeHero700, lineHeight: tokens.lineHeightHero700, fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums' },
  label: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  over: { color: tokens.colorPaletteDarkOrangeForeground1 },
  phase: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalM,
  },
  phaseHead: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalS },
  phaseMeta: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalM, color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  spacer: { flexGrow: 1 },
  actions: { display: 'flex', gap: tokens.spacingHorizontalXS },
  team: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalM,
  },
  teamTitle: { margin: 0, fontSize: tokens.fontSizeBase400, fontWeight: tokens.fontWeightSemibold },
  members: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, listStyleType: 'none', margin: 0, padding: 0 },
  member: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
    paddingLeft: tokens.spacingHorizontalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusCircular,
  },
  addMember: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: tokens.spacingHorizontalS },
});

/** One implementation project: phases, tasks and plan against actual (FR-PRJ-01). */
export function ProjectPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const notify = useNotify();
  const canWrite = useCan(Permissions.projectsWrite);
  const canSeeMoney = useCan(Permissions.financeRead);
  const { data: project, error, isPending, refetch } = useProject(id);
  const actions = useProjectActions(id);
  const [editing, setEditing] = useState(false);
  const [phase, setPhase] = useState<ProjectPhase | 'new' | null>(null);
  const [task, setTask] = useState<{ phaseId: string; task?: ProjectTask } | null>(null);
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

  const overBudget = project.progress.budgetHours > 0 && project.progress.hours > project.progress.budgetHours;

  return (
    <>
      <PageHeader
        back={{ to: '/projects', label: t('projects.title') }}
        title={project.name}
        meta={
          <>
            <Badge appearance="outline" color={statusColor(project.status)}>
              {t(`projects.statuses.${project.status}`)}
            </Badge>
            <Text>{project.number}</Text>
            <AppLink to={`/organizations/${project.organization.id}?tab=projects`}>{project.organization.name}</AppLink>
            <Text>{t(`projects.types.${project.type}`)}</Text>
            <Text className="tabular">
              {formatDate(project.startDate)}
              {project.endDate ? ` – ${formatDate(project.endDate)}` : ''}
            </Text>
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
                        <MenuItem
                          key={status}
                          onClick={() => void run(() => actions.setStatus.mutateAsync(status), t('projects.statusChanged'))}
                        >
                          {t(`projects.statuses.${status}`)}
                        </MenuItem>
                      ))}
                  </MenuList>
                </MenuPopover>
              </Menu>
            </>
          )
        }
      />

      <div className={styles.tiles}>
        <div className={styles.tile}>
          <span className={`${styles.value} ${overBudget ? styles.over : ''}`}>{formatNumber(project.progress.hours, 1)}</span>
          <span className={styles.label}>
            {t('projects.progress.hours', { budget: formatNumber(project.progress.budgetHours, 0) })}
          </span>
          {project.progress.budgetHours > 0 && (
            <ProgressBar
              value={Math.min(project.progress.hours / project.progress.budgetHours, 1)}
              color={overBudget ? 'warning' : 'brand'}
              aria-label={t('projects.fields.hours')}
            />
          )}
        </div>
        <div className={styles.tile}>
          <span className={styles.value}>{formatNumber(project.progress.billableHours, 1)}</span>
          <span className={styles.label}>{t('projects.progress.billableHours')}</span>
        </div>
        {canSeeMoney && (
          <>
            <div className={styles.tile}>
              <span className={styles.value}>{formatMoney(project.progress.amount ?? 0)}</span>
              <span className={styles.label}>{t('projects.progress.amount', { budget: formatMoney(project.progress.budgetAmount ?? 0) })}</span>
            </div>
            <div className={styles.tile}>
              <span className={styles.value}>{formatMoney(project.progress.phaseFeesCompleted ?? 0)}</span>
              <span className={styles.label}>{t('projects.progress.phaseFees')}</span>
            </div>
          </>
        )}
        <div className={styles.tile}>
          <span className={styles.value}>
            {project.progress.phasesDone}/{project.progress.phases}
          </span>
          <span className={styles.label}>{t('projects.progress.phases', { tasks: project.progress.openTasks })}</span>
        </div>
      </div>

      <ProjectTeam project={project} canWrite={canWrite} />

      {canWrite && (
        <div className={catalog.filters}>
          <Button {...restoreFocusTarget} icon={<Add20Regular />} onClick={() => setPhase('new')}>
            {t('projects.addPhase')}
          </Button>
        </div>
      )}

      {project.phases.length === 0 ? (
        <EmptyState message={t('projects.noPhases')} />
      ) : (
        project.phases.map((p) => (
          <section key={p.id} className={styles.phase}>
            <div className={styles.phaseHead}>
              <Text weight="semibold">
                {p.order}. {p.name}
              </Text>
              <Badge appearance="outline" color={p.status === 'Completed' ? 'success' : p.status === 'Cancelled' ? 'danger' : 'informative'}>
                {t(`projects.phaseStatuses.${p.status}`)}
              </Badge>
              {p.billOnCompletion && canSeeMoney && <Text className={styles.label}>{t('projects.phaseFee', { fee: formatMoney(p.fee ?? 0) })}</Text>}
              <div className={styles.spacer} />
              {canWrite && (
                <div className={styles.actions}>
                  <Dropdown
                    aria-label={t('projects.fields.status')}
                    value={t(`projects.phaseStatuses.${p.status}`)}
                    selectedOptions={[p.status]}
                    onOptionSelect={(_, d) =>
                      void run(
                        () => actions.setPhaseStatus.mutateAsync({ phaseId: p.id, status: d.optionValue as ProjectPhaseStatus }),
                        d.optionValue === 'Completed' && p.billOnCompletion ? t('projects.phaseQueued') : t('projects.phaseUpdated'),
                      )
                    }
                  >
                    {phaseStatuses.map((status) => (
                      <Option key={status} value={status}>
                        {t(`projects.phaseStatuses.${status}`)}
                      </Option>
                    ))}
                  </Dropdown>
                  <Button icon={<Edit20Regular />} onClick={() => setPhase(p)} aria-label={t('common.edit')} />
                  <Button
                    icon={<Delete20Regular />}
                    appearance="subtle"
                    aria-label={t('common.delete')}
                    onClick={() => void run(() => actions.removePhase.mutateAsync(p.id), t('projects.phaseRemoved'))}
                  />
                </div>
              )}
            </div>
            <div className={styles.phaseMeta}>
              <span>
                {p.plannedStart ? formatDate(p.plannedStart) : '—'}
                {p.plannedEnd ? ` – ${formatDate(p.plannedEnd)}` : ''}
              </span>
              <span>{t('projects.plannedHours', { hours: formatNumber(p.plannedHours, 1) })}</span>
              {p.completedOn && <span>{t('projects.completedOn', { date: formatDate(p.completedOn) })}</span>}
            </div>

            <Table size="small" aria-label={p.name}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{t('projects.fields.task')}</TableHeaderCell>
                  <TableHeaderCell>{t('projects.fields.assignee')}</TableHeaderCell>
                  <TableHeaderCell>{t('projects.fields.dueDate')}</TableHeaderCell>
                  <TableHeaderCell className={catalog.number}>{t('projects.fields.estimate')}</TableHeaderCell>
                  <TableHeaderCell>{t('projects.fields.status')}</TableHeaderCell>
                  {canWrite && <TableHeaderCell />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.tasks.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{item.title}</TableCell>
                    <TableCell>{item.assignee?.name ?? '—'}</TableCell>
                    <TableCell className="tabular">{item.dueDate ? formatDate(item.dueDate) : '—'}</TableCell>
                    <TableCell className={catalog.number}>{formatNumber(item.estimatedHours, 1)}</TableCell>
                    <TableCell>{t(`projects.taskStatuses.${item.status}`)}</TableCell>
                    {canWrite && (
                      <TableCell>
                        <div className={styles.actions}>
                          <Button icon={<Edit20Regular />} appearance="subtle" aria-label={t('common.edit')} onClick={() => setTask({ phaseId: p.id, task: item })} />
                          <Button
                            icon={<Delete20Regular />}
                            appearance="subtle"
                            aria-label={t('common.delete')}
                            onClick={() => void run(() => actions.removeTask.mutateAsync(item.id), t('projects.taskRemoved'))}
                          />
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {canWrite && (
              <Button appearance="subtle" icon={<Add20Regular />} onClick={() => setTask({ phaseId: p.id })}>
                {t('projects.addTask')}
              </Button>
            )}
          </section>
        ))
      )}

      <Dialog open={editing} onOpenChange={(_, d) => !d.open && setEditing(false)}>
        <DialogSurface>{editing && <ProjectDialog project={project} onClose={() => setEditing(false)} />}</DialogSurface>
      </Dialog>
      <Dialog open={phase !== null} onOpenChange={(_, d) => !d.open && setPhase(null)}>
        <DialogSurface>
          {phase !== null && <PhaseForm project={project} phase={phase === 'new' ? undefined : phase} onClose={() => setPhase(null)} />}
        </DialogSurface>
      </Dialog>
      <Dialog open={task !== null} onOpenChange={(_, d) => !d.open && setTask(null)}>
        <DialogSurface>
          {task !== null && <TaskForm projectId={project.id} phaseId={task.phaseId} task={task.task} onClose={() => setTask(null)} />}
        </DialogSurface>
      </Dialog>
      {canWrite && project.status === 'Planned' && (
        <Button
          appearance="subtle"
          icon={<Delete20Regular />}
          onClick={() =>
            void run(async () => {
              await actions.remove.mutateAsync();
              void navigate('/projects');
            }, t('projects.deleted'))
          }
        >
          {t('projects.delete')}
        </Button>
      )}
    </>
  );
}

function PhaseForm({ project, phase, onClose }: { project: Project; phase?: ProjectPhase; onClose: () => void }) {
  const styles = useDialogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useProjectActions(project.id);
  const canSeeMoney = useCan(Permissions.financeRead);
  const [name, setName] = useState(phase?.name ?? '');
  const [plannedStart, setPlannedStart] = useState(phase?.plannedStart ?? '');
  const [plannedEnd, setPlannedEnd] = useState(phase?.plannedEnd ?? '');
  const [plannedHours, setPlannedHours] = useState(String(phase?.plannedHours ?? 0));
  const [fee, setFee] = useState(String(phase?.fee ?? 0));
  const [billOnCompletion, setBillOnCompletion] = useState(phase?.billOnCompletion ?? project.billingModel !== 'TimeAndMaterial');
  const invalid = !name.trim();

  const submit = async () => {
    if (invalid) return;
    const request = {
      name: name.trim(),
      plannedStart: blankToNull(plannedStart),
      plannedEnd: blankToNull(plannedEnd),
      plannedHours: parseDecimal(plannedHours) ?? 0,
      fee: canSeeMoney ? (parseDecimal(fee) ?? 0) : (phase?.fee ?? 0),
      billOnCompletion,
      productId: phase?.productId ?? null,
    };
    try {
      if (phase) await actions.updatePhase.mutateAsync({ phaseId: phase.id, request });
      else await actions.addPhase.mutateAsync(request);
      notify(phase ? t('projects.phaseUpdated') : t('projects.phaseAdded'));
      onClose();
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{phase ? t('projects.editPhase') : t('projects.addPhase')}</DialogTitle>
        <DialogContent>
          <div className={styles.grid}>
            <Field label={t('projects.fields.phaseName')} required className={styles.wide}>
              <Input value={name} onChange={(_, d) => setName(d.value)} />
            </Field>
            <Field label={t('projects.fields.plannedStart')}>
              <Input type="date" value={plannedStart} onChange={(_, d) => setPlannedStart(d.value)} />
            </Field>
            <Field label={t('projects.fields.plannedEnd')}>
              <Input type="date" value={plannedEnd} onChange={(_, d) => setPlannedEnd(d.value)} />
            </Field>
            <Field label={t('projects.fields.plannedHours')}>
              <Input inputMode="decimal" value={plannedHours} onChange={(_, d) => setPlannedHours(d.value)} />
            </Field>
            {canSeeMoney && (
              <>
                <Field label={t('projects.fields.fee')} hint={t('projects.feeHint')}>
                  <Input inputMode="decimal" value={fee} onChange={(_, d) => setFee(d.value)} contentAfter="NOK" />
                </Field>
                <div className={styles.wide}>
                  <Switch
                    label={t('projects.billOnCompletion')}
                    checked={billOnCompletion}
                    onChange={(_, d) => setBillOnCompletion(Boolean(d.checked))}
                  />
                </div>
              </>
            )}
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={invalid}>
            {t('common.save')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}

function TaskForm({ projectId, phaseId, task, onClose }: { projectId: string; phaseId: string; task?: ProjectTask; onClose: () => void }) {
  const styles = useDialogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useProjectActions(projectId);
  const [title, setTitle] = useState(task?.title ?? '');
  const [assignee, setAssignee] = useState<UserRef | null>(task?.assignee ? { id: task.assignee.id, displayName: task.assignee.name } : null);
  const [dueDate, setDueDate] = useState(task?.dueDate ?? '');
  const [estimate, setEstimate] = useState(String(task?.estimatedHours ?? 0));
  const [status, setStatus] = useState<ProjectTaskStatus>(task?.status ?? 'Open');
  const [notes, setNotes] = useState(task?.notes ?? '');
  const invalid = !title.trim();

  const submit = async () => {
    if (invalid) return;
    const request = {
      title: title.trim(),
      assigneeId: assignee?.id ?? null,
      dueDate: blankToNull(dueDate),
      estimatedHours: parseDecimal(estimate) ?? 0,
      notes: blankToNull(notes),
      status,
    };
    try {
      if (task) await actions.updateTask.mutateAsync({ taskId: task.id, request });
      else await actions.addTask.mutateAsync({ phaseId, request });
      notify(task ? t('projects.taskUpdated') : t('projects.taskAdded'));
      onClose();
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{task ? t('projects.editTask') : t('projects.addTask')}</DialogTitle>
        <DialogContent>
          <div className={styles.grid}>
            <Field label={t('projects.fields.task')} required className={styles.wide}>
              <Input value={title} onChange={(_, d) => setTitle(d.value)} />
            </Field>
            <Field label={t('projects.fields.assignee')}>
              <UserPicker value={assignee} onChange={setAssignee} />
            </Field>
            <Field label={t('projects.fields.dueDate')}>
              <Input type="date" value={dueDate} onChange={(_, d) => setDueDate(d.value)} />
            </Field>
            <Field label={t('projects.fields.estimate')}>
              <Input inputMode="decimal" value={estimate} onChange={(_, d) => setEstimate(d.value)} />
            </Field>
            <Field label={t('projects.fields.status')}>
              <Dropdown
                value={t(`projects.taskStatuses.${status}`)}
                selectedOptions={[status]}
                onOptionSelect={(_, d) => setStatus(d.optionValue as ProjectTaskStatus)}
              >
                {taskStatuses.map((value) => (
                  <Option key={value} value={value}>
                    {t(`projects.taskStatuses.${value}`)}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label={t('projects.fields.notes')} className={styles.wide}>
              <Textarea value={notes} onChange={(_, d) => setNotes(d.value)} resize="vertical" />
            </Field>
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={invalid}>
            {t('common.save')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}

/** The project's team (DEV-09): with the manager and the task assignees, they are the people who see the project. */
function ProjectTeam({ project, canWrite }: { project: Project; canWrite: boolean }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useProjectActions(project.id);
  const [person, setPerson] = useState<UserRef | null>(null);

  const change = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      notify(success);
      return true;
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
      return false;
    }
  };

  return (
    <section className={styles.team} aria-labelledby="project-team">
      <h2 id="project-team" className={styles.teamTitle}>
        {t('projects.team.title')}
      </h2>
      <Text className={styles.label}>{t('projects.team.hint')}</Text>
      {project.members.length === 0 ? (
        <Text>{t('projects.team.empty')}</Text>
      ) : (
        <ul className={styles.members}>
          {project.members.map((member) => (
            <li key={member.id} className={styles.member}>
              <Text>{member.name}</Text>
              {canWrite && (
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<Dismiss16Regular />}
                  aria-label={t('projects.team.remove', { name: member.name })}
                  disabled={actions.removeMember.isPending}
                  onClick={() => void change(() => actions.removeMember.mutateAsync(member.id), t('projects.team.removed', { name: member.name }))}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <div className={styles.addMember}>
          <Field label={t('projects.team.person')}>
            <UserPicker value={person} onChange={setPerson} />
          </Field>
          <Button
            disabled={person === null || actions.addMember.isPending}
            onClick={() =>
              person &&
              void change(() => actions.addMember.mutateAsync(person.id), t('projects.team.added', { name: person.displayName })).then(
                (ok) => ok && setPerson(null),
              )
            }
          >
            {t('projects.team.add')}
          </Button>
        </div>
      )}
    </section>
  );
}
