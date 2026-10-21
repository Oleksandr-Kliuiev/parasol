import { useState } from 'react';
import {
  Badge,
  Button,
  Dropdown,
  Option,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  useRestoreFocusTarget,
  type BadgeProps,
} from '@fluentui/react-components';
import { Add20Regular, Delete20Regular, Edit20Regular, TaskListSquareLtr16Regular, TaskListSquareLtr24Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { EmptyState } from '../../shared/components/EmptyState';
import { Panel } from '../../shared/components/Panel';
import { ScrollTable } from '../../shared/components/ScrollTable';
import { formatDate, formatMoney, formatNumber } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { MetaLine, RecordCell } from '../organizations/RecordCell';
import { useRecordStyles } from '../organizations/recordStyles';
import { ConfirmDialog } from '../../shared/components/ConfirmDialog';
import { useKeptWhileClosing } from '../../shared/components/useKeptWhileClosing';
import { useProjectActions } from './api';
import { phaseStatuses, type Project, type ProjectPhase, type ProjectPhaseStatus, type ProjectTask, type ProjectTaskStatus } from './types';

const useStyles = makeStyles({
  // The phases of one card follow each other with a hairline between them, each with its own tasks.
  phase: {
    paddingTop: '16px',
    paddingBottom: '12px',
    borderTop: `1px solid ${h.line}`,
    ':first-of-type': { borderTop: 'none', paddingTop: 0 },
  },
  head: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px' },
  title: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 10px', flex: '1 1 260px', minWidth: 0 },
  name: { fontFamily: h.display, fontSize: '15px', lineHeight: '21px', fontWeight: 600, letterSpacing: '-0.01em' },
  order: { color: h.faint, fontVariantNumeric: 'tabular-nums' },
  actions: { display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto' },
  status: { minWidth: '150px' },
  meta: { marginTop: '4px', marginBottom: '8px' },
  noTasks: { paddingTop: '6px', paddingBottom: '6px', color: h.muted, fontSize: '13px' },
  person: { fontWeight: 500, fontSize: '13px' },
});

const taskColor: Record<ProjectTaskStatus, NonNullable<BadgeProps['color']>> = { Open: 'informative', InProgress: 'brand', Done: 'success', Cancelled: 'subtle' };
const phaseColor: Record<ProjectPhaseStatus, NonNullable<BadgeProps['color']>> = { Planned: 'informative', Active: 'brand', Completed: 'success', Cancelled: 'danger' };

interface ProjectPhasesProps {
  project: Project;
  canWrite: boolean;
  canSeeMoney: boolean;
  run: (action: () => Promise<unknown>, success: string) => Promise<void>;
  onAddPhase: () => void;
  onEditPhase: (phase: ProjectPhase) => void;
  onTask: (phaseId: string, task?: ProjectTask) => void;
}

/** The plan of the project: its phases in order, each with its status, plan and tasks (FR-PRJ-01). */
export function ProjectPhases({ project, canWrite, canSeeMoney, run, onAddPhase, onEditPhase, onTask }: ProjectPhasesProps) {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const record = useRecordStyles();
  const { t } = useTranslation();
  const actions = useProjectActions(project.id);
  // The phase and task dialogs live on the project page; focus goes back to the button that opened them.
  const restoreFocusTarget = useRestoreFocusTarget();
  // Removing a phase or a task cannot be undone, so the trash button asks first and names what goes.
  const [removing, setRemoving] = useState<{ phase: ProjectPhase; task?: ProjectTask } | null>(null);
  const shownRemoval = useKeptWhileClosing(removing);
  const remove = async () => {
    if (!removing) return;
    const { phase, task } = removing; setRemoving(null);
    await (task ? run(() => actions.removeTask.mutateAsync(task.id), t('projects.taskRemoved'))
      : run(() => actions.removePhase.mutateAsync(phase.id), t('projects.phaseRemoved')));
    // The removed row took its button along: focus goes to the add button that stays in the same place.
    document.getElementById(task ? `add-task-${phase.id}` : `add-phase-${project.id}`)?.focus();
  };

  return (
    <Panel
      title={t('projects.fields.phases')}
      icon={<TaskListSquareLtr16Regular />}
      actions={
        canWrite && (
          <Button {...restoreFocusTarget} id={`add-phase-${project.id}`} size="small" icon={<Add20Regular />} onClick={onAddPhase}>
            {t('projects.addPhase')}
          </Button>
        )
      }
    >
      {project.phases.length === 0 && <EmptyState icon={<TaskListSquareLtr24Regular />} message={t('projects.noPhases')} />}
      {project.phases.map((p) => (
        <section key={p.id} className={styles.phase} aria-label={p.name}>
          <div className={styles.head}>
            <span className={styles.title}>
              <Text className={styles.name}>
                <span className={styles.order}>{p.order}.</span> {p.name}
              </Text>
              <Badge appearance="tint" color={phaseColor[p.status]}>
                {t(`projects.phaseStatuses.${p.status}`)}
              </Badge>
            </span>
            {canWrite && (
              <span className={styles.actions}>
                <Dropdown
                  className={styles.status}
                  size="small"
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
                <Button {...restoreFocusTarget} size="small" icon={<Edit20Regular />} onClick={() => onEditPhase(p)} aria-label={t('projects.editPhaseNamed', { name: p.name })} />
                <Button
                  {...restoreFocusTarget}
                  size="small"
                  icon={<Delete20Regular />}
                  appearance="subtle"
                  aria-label={t('projects.removePhaseNamed', { name: p.name })}
                  onClick={() => setRemoving({ phase: p })}
                />
              </span>
            )}
          </div>
          <MetaLine
            className={styles.meta}
            parts={[
              <span className="tabular">
                {p.plannedStart ? formatDate(p.plannedStart) : '—'}
                {p.plannedEnd ? ` – ${formatDate(p.plannedEnd)}` : ''}
              </span>,
              t('projects.plannedHours', { hours: formatNumber(p.plannedHours, 1) }),
              p.billOnCompletion && canSeeMoney && t('projects.phaseFee', { fee: formatMoney(p.fee ?? 0) }),
              p.completedOn && t('projects.completedOn', { date: formatDate(p.completedOn) }),
            ]}
          />

          {p.tasks.length === 0 ? (
            <Text block className={styles.noTasks}>{t('projects.noTasks')}</Text>
          ) : (
            <ScrollTable className={record.flatTable}>
              <Table size="small" className={catalog.table} style={{ minWidth: 820 }} aria-label={p.name}>
                <TableHeader>
                  <TableRow>
                    {/* Content widths: every cell adds 12 px of padding on each side; the task takes the rest. */}
                    <TableHeaderCell>{t('projects.fields.task')}</TableHeaderCell>
                    <TableHeaderCell style={{ width: 156 }}>{t('projects.fields.assignee')}</TableHeaderCell>
                    <TableHeaderCell style={{ width: 86 }}>{t('projects.fields.dueDate')}</TableHeaderCell>
                    <TableHeaderCell className={catalog.number} style={{ width: 86 }}>{t('projects.fields.estimate')}</TableHeaderCell>
                    <TableHeaderCell style={{ width: 106 }}>{t('projects.fields.status')}</TableHeaderCell>
                    {canWrite && <TableHeaderCell style={{ width: 68 }} />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {p.tasks.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>{item.title}</TableCell>
                      <TableCell>
                        {item.assignee ? (
                          <RecordCell avatarName={item.assignee.name} size={28} name={<span className={styles.person}>{item.assignee.name}</span>} />
                        ) : (
                          <span className={catalog.muted}>{t('projects.unassigned')}</span>
                        )}
                      </TableCell>
                      <TableCell className="tabular">{item.dueDate ? formatDate(item.dueDate) : '—'}</TableCell>
                      <TableCell className={catalog.number}>{formatNumber(item.estimatedHours, 1)}</TableCell>
                      <TableCell>
                        <Badge appearance="tint" color={taskColor[item.status]}>
                          {t(`projects.taskStatuses.${item.status}`)}
                        </Badge>
                      </TableCell>
                      {canWrite && (
                        <TableCell>
                          <span className={catalog.rowActions}>
                            <Button {...restoreFocusTarget} size="small" icon={<Edit20Regular />} appearance="subtle" aria-label={t('projects.editTaskNamed', { name: item.title })} onClick={() => onTask(p.id, item)} />
                            <Button
                              {...restoreFocusTarget}
                              size="small"
                              icon={<Delete20Regular />}
                              appearance="subtle"
                              aria-label={t('projects.removeTaskNamed', { name: item.title })}
                              onClick={() => setRemoving({ phase: p, task: item })}
                            />
                          </span>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollTable>
          )}
          {canWrite && (
            <Button {...restoreFocusTarget} id={`add-task-${p.id}`} size="small" appearance="subtle" icon={<Add20Regular />} onClick={() => onTask(p.id)}>
              {t('projects.addTask')}
            </Button>
          )}
        </section>
      ))}
      <ConfirmDialog open={removing !== null} onConfirm={() => void remove()} onCancel={() => setRemoving(null)}
        title={shownRemoval?.task ? t('projects.removeTaskTitle', { name: shownRemoval.task.title }) : t('projects.removePhaseTitle', { name: shownRemoval?.phase.name ?? '' })}
        confirm={t(shownRemoval?.task ? 'projects.removeTask' : 'projects.removePhase')}>
        {shownRemoval?.task ? t('projects.removeTaskBody')
          : t('projects.removePhaseBody', { count: shownRemoval?.phase.tasks.length ?? 0 })}
      </ConfirmDialog>
    </Panel>
  );
}
