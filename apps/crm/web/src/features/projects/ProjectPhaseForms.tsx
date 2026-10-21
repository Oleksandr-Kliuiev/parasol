import { useState } from 'react';
import {
  Button,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  Option,
  Switch,
  Textarea,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import type { UserRef } from '../../api/types';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { UserPicker } from '../../shared/components/UserPicker';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { blankToNull, parseDecimal } from '../../shared/utils/format';
import { useDialogStyles } from '../contracts/dialogStyles';
import { useProjectActions } from './api';
import { taskStatuses, type Project, type ProjectPhase, type ProjectTask, type ProjectTaskStatus } from './types';

/** Adds a phase to a project or changes one (FR-PRJ-01). */
export function PhaseForm({ project, phase, onClose }: { project: Project; phase?: ProjectPhase; onClose: () => void }) {
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
      // Fee and bill-on-completion are finance data: omitted without finance.read, the server keeps the stored values.
      ...(canSeeMoney ? { fee: parseDecimal(fee) ?? 0, billOnCompletion } : {}),
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
                <div className={styles.switches}>
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

/** Adds a task to a phase or changes one. */
export function TaskForm({ projectId, phaseId, task, onClose }: { projectId: string; phaseId: string; task?: ProjectTask; onClose: () => void }) {
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
