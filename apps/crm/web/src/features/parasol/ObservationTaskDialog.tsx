import { useEffect, useId, useRef, useState } from 'react';
import {
  Button,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  ToggleButton,
  makeStyles,
  mergeClasses,
} from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import type { UserRef } from '../../api/types';
import { Permissions, currentUserQueryKey, useCurrentUser } from '../../auth/CurrentUserContext';
import { formatDateTime } from '../../shared/utils/format';
import { UserPicker } from '../../shared/components/UserPicker';
import { activityKeys } from '../activities/api';
import { useDialogStyles } from '../contracts/dialogStyles';
import { ObservationContext } from './ObservationContext';
import { invalidatesAtlasSource, parseTaskOutcome, type ObservationTaskLink, type ObservationTaskOutcome } from './observationTaskContract';
import { TechnicalTaskReference } from './TechnicalTaskReference';
import { useTechnicalStyles } from './technicalStyles';
import { taskReadErrorStatus, taskRoute, useObservationTaskPreview } from './useObservationTaskPreview';
import { h } from '../../app/hearth';

// The dialog reads top to bottom with one rhythm: the privacy note, the observation, what the task will hold, the fields.
const useLayout = makeStyles({
  content: { display: 'grid', gap: '14px', alignContent: 'start' },
  note: { color: h.muted, fontSize: '13px', lineHeight: '19px' },
  task: { display: 'grid', gap: '4px', fontSize: '13.5px' },
  // Short cuts under a field: one tap for the usual answers, the field stays the place to type anything else.
  shortcuts: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' },
  // What the button will create, said in one sentence beside it: the confirmation the old check box asked for.
  summary: { gridColumn: '1 / -1', color: h.text, fontSize: '13.5px', lineHeight: '20px', fontWeight: 600 },
});

/** A due moment `days` from today at 16:00, the end of the working day, as a datetime-local value in the browser's zone. */
function dueIn(days: number): string {
  const due = new Date(); due.setDate(due.getDate() + days); due.setHours(16, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}T16:00`;
}
const dueShortcuts = [['today', 0], ['tomorrow', 1], ['inThreeDays', 3]] as const;

export function ObservationTaskDialog({ customerId, observationId, allowCreate, onClose, onSourceInvalidated, onTask, assignToMe = false }: {
  customerId: string; observationId: string; allowCreate: boolean; onClose: () => void; onSourceInvalidated?: () => void;
  onTask?: (link: ObservationTaskLink) => void;
  /** Opened with the queue's A key: the person is already chosen; they still see the read and confirm with Create task. */
  assignToMe?: boolean;
}) {
  const { t } = useTranslation(); const styles = useDialogStyles(); const layout = useLayout(); const technical = useTechnicalStyles(); const client = useQueryClient();
  const user = useCurrentUser(); const summaryId = useId();
  // The server accepts an active employee who may write activities and read Atlas (SourceTaskApi.IsEligibleAssignee):
  // offer "me" to exactly those.
  const canTakeIt = user.permissions.includes(Permissions.activitiesWrite) && user.permissions.includes(Permissions.parasolAtlasRead);
  const preview = useObservationTaskPreview({ customerId, observationId });
  const [assignee, setAssignee] = useState<UserRef | null>(() => assignToMe && canTakeIt ? { id: user.id, displayName: user.displayName } : null);
  const [dueAt, setDueAt] = useState('');
  const [busy, setBusy] = useState(false);
  // The picker keeps the text it shows; choosing "me" outside it starts it again with the new name.
  const [pickerRevision, setPickerRevision] = useState(0);
  const [outcome, setOutcome] = useState<ObservationTaskOutcome | null>(null); const [writeIssue, setWriteIssue] = useState<string | null>(null);
  const [needsPreview, setNeedsPreview] = useState(false);
  const active = useRef(true); const submitting = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const view = !preview.isFetching && !preview.isError && !needsPreview ? preview.data : undefined;
  const ready = view?.status === 'READY' ? view : null;
  const task = view ? view.task ?? (view.status === 'READY' ? outcome?.task : null) : null;
  const errorStatus = preview.isError ? taskReadErrorStatus(preview.error)
    : view && view.status !== 'READY' ? view.status : null;
  const sourceInvalid = errorStatus && invalidatesAtlasSource(errorStatus);
  useEffect(() => { if (sourceInvalid) onSourceInvalidated?.(); }, [sourceInvalid, onSourceInvalidated]);
  const invalidDue = dueAt !== '' && !Number.isFinite(new Date(dueAt).getTime());
  const canCreate = allowCreate && ready?.canCreate && !task && !outcome && !!assignee && !invalidDue;
  const refresh = () => {
    setOutcome(null); setWriteIssue(null); setNeedsPreview(false); void preview.refetch();
  };
  // The dialog itself is the confirmation: the observation as read just now, and one sentence naming who gets the task and
  // when. The write carries the hash of exactly that preview, so a source that changed since is refused by the server.
  const create = async () => {
    if (!canCreate || preview.isFetching || !ready?.sha256 || !assignee || submitting.current) return;
    submitting.current = true; setBusy(true);
    try {
      const result = parseTaskOutcome((await api.post<unknown>(`${taskRoute(customerId, observationId)}/task`, {
        assigneeId: assignee.id, dueAt: dueAt ? new Date(dueAt).toISOString() : null, expectedSha256: ready.sha256,
      })).data, customerId);
      void client.invalidateQueries({ queryKey: activityKeys.all });
      void client.invalidateQueries({ queryKey: currentUserQueryKey });
      // The row learns of the task now; the name is known only when the task went to the person chosen here.
      if (result.task && ['CREATED', 'EXISTING'].includes(result.status))
        onTask?.({ task: result.task, assigneeName: result.task.assigneeId === assignee.id ? assignee.displayName : null });
      if (!active.current) return;
      setOutcome(result);
      if (!['CREATED', 'EXISTING'].includes(result.status)) {
        setNeedsPreview(true); setWriteIssue('UNCERTAIN');
      }
    } catch (error) {
      const code = error instanceof ApiError ? error.code : undefined;
      const issue = code === 'PARASOL_TASK_SOURCE_CHANGED' ? 'SOURCE_CHANGED'
        : code === 'PARASOL_TASK_SOURCE_TERMINAL' ? 'SOURCE_TERMINAL'
        : code === 'ACT_SOURCE_TASK_ASSIGNEE_INVALID' ? 'ASSIGNEE_INVALID'
        : error instanceof ApiError && [400, 403, 409].includes(error.status) ? 'REVIEW_REQUIRED' : 'UNCERTAIN';
      if (issue === 'UNCERTAIN') void client.invalidateQueries({ queryKey: activityKeys.all });
      if (!active.current) return;
      setNeedsPreview(true); setWriteIssue(issue);
      if ((error instanceof ApiError && error.status === 403) || code === 'PARASOL_TASK_IDENTITY_CHANGED'
        || code === 'PARASOL_TASK_SOURCE_UNAVAILABLE' || code === 'ACT_SOURCE_TASK_CUSTOMER_CHANGED'
        || code === 'PARASOL_CUSTOMER_NOT_FOUND' || code === 'PARASOL_IDENTITY_INCONSISTENT') onSourceInvalidated?.();
    } finally {
      submitting.current = false; if (active.current) setBusy(false);
    }
  };
  return <Dialog open onOpenChange={(_, d) => { if (!d.open && !busy) onClose(); }}>
    <DialogSurface><DialogBody>
      <DialogTitle>{t(allowCreate ? 'parasolWork.title' : 'parasolWork.viewTitle')}</DialogTitle>
      <DialogContent className={layout.content}>
        <Text block className={layout.note}>{t('parasolWork.privacy')}</Text>
        {view?.mode === 'fixture' && <MessageBar intent="warning"><MessageBarBody>{t('parasol.fixture')}</MessageBarBody></MessageBar>}
        {preview.isFetching && <Spinner size="small" label={t('common.loading')} />}
        {errorStatus && <MessageBar intent="warning" className={styles.error}><MessageBarBody>{t(`parasolWork.status.${errorStatus}`)}</MessageBarBody></MessageBar>}
        {writeIssue && <MessageBar intent="warning" className={styles.error}><MessageBarBody>{t(`parasolWork.status.${writeIssue}`)}</MessageBarBody></MessageBar>}
        {outcome && <Text block role="status">{t(`parasolWork.status.${outcome.status}`)}</Text>}
        {ready?.observation && ready.devices && <div className={technical.row}><ObservationContext exact observation={ready.observation} devices={ready.devices} /></div>}
        {task && <TechnicalTaskReference task={task} onNavigate={onClose} />}
        {ready && !task && (!allowCreate || !ready.canCreate) && <Text block>{t(allowCreate ? 'parasolWork.cannotCreate' : 'parasolWork.noLinkedWork')}</Text>}
        {allowCreate && ready?.canCreate && !task && !outcome && <div className={styles.grid}>
          <div className={mergeClasses(styles.wide, layout.task)}>
            <Text block>{t('parasolWork.persistedSubject')}: {t('parasolWork.subject')}</Text>
            <Text block>{t('parasolWork.priority', { priority: t(ready.observation?.priority === 'URGENT' ? 'activities.priorities.High' : 'activities.priorities.Normal') })}</Text>
          </div>
          <div>
            <Field required label={t('parasolWork.assignee')}><UserPicker key={pickerRevision} value={assignee} onChange={setAssignee} /></Field>
            {canTakeIt && <div className={layout.shortcuts}>
              <ToggleButton size="small" shape="circular" checked={assignee?.id === user.id} disabled={busy}
                onClick={() => { setAssignee({ id: user.id, displayName: user.displayName }); setPickerRevision(r => r + 1); }}>
                {t('parasolWork.assignToMe')}</ToggleButton>
            </div>}
          </div>
          <div>
            <Field label={t('parasolWork.due')} validationMessage={invalidDue ? t('parasolWork.invalidDue') : undefined}>
              <Input type="datetime-local" value={dueAt} onChange={(_, d) => setDueAt(d.value)} />
            </Field>
            <div role="group" aria-label={t('parasolWork.dueShortcuts')} className={layout.shortcuts}>
              {dueShortcuts.map(([key, days]) => <ToggleButton key={key} size="small" shape="circular" disabled={busy}
                checked={dueAt === dueIn(days)} onClick={() => setDueAt(dueIn(days))}>{t(`parasolWork.dueIn.${key}`)}</ToggleButton>)}
              <ToggleButton size="small" shape="circular" disabled={busy} checked={dueAt === ''} onClick={() => setDueAt('')}>{t('parasolWork.dueIn.none')}</ToggleButton>
            </div>
          </div>
          {assignee && !invalidDue && <Text block id={summaryId} className={layout.summary}>
            {t(dueAt ? 'parasolWork.summaryDue' : 'parasolWork.summaryNoDue', {
              name: assignee.displayName, due: dueAt ? formatDateTime(new Date(dueAt).toISOString()) : '',
              priority: t(ready.observation?.priority === 'URGENT' ? 'activities.priorities.High' : 'activities.priorities.Normal').toLocaleLowerCase(),
            })}
          </Text>}
        </div>}
      </DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={onClose}>{t('common.close')}</Button>
        <Button disabled={busy || preview.isFetching} onClick={refresh}>{t('parasolWork.previewAgain')}</Button>
        {allowCreate && !task && <Button appearance="primary" disabled={!canCreate || busy || preview.isFetching}
          aria-describedby={canCreate ? summaryId : undefined} onClick={() => void create()}>{t('parasolWork.create')}</Button>}
      </DialogActions>
    </DialogBody></DialogSurface>
  </Dialog>;
}
