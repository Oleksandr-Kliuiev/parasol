import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input,
  MessageBar, MessageBarBody, Spinner, Text } from '@fluentui/react-components';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import type { UserRef } from '../../api/types';
import { currentUserQueryKey } from '../../auth/CurrentUserContext';
import { UserPicker } from '../../shared/components/UserPicker';
import { activityKeys } from '../activities/api';
import { useDialogStyles } from '../contracts/dialogStyles';
import { ObservationContext } from './ObservationContext';
import { invalidatesAtlasSource, parseTaskOutcome, type ObservationTaskOutcome } from './observationTaskContract';
import { TechnicalTaskReference } from './TechnicalTaskReference';
import { useTechnicalStyles } from './technicalStyles';
import { taskReadErrorStatus, taskRoute, useObservationTaskPreview } from './useObservationTaskPreview';

export function ObservationTaskDialog({ customerId, observationId, allowCreate, onClose, onSourceInvalidated }: {
  customerId: string; observationId: string; allowCreate: boolean; onClose: () => void; onSourceInvalidated?: () => void;
}) {
  const { t } = useTranslation(); const styles = useDialogStyles(); const technical = useTechnicalStyles(); const client = useQueryClient();
  const preview = useObservationTaskPreview({ customerId, observationId });
  const [assignee, setAssignee] = useState<UserRef | null>(null); const [dueAt, setDueAt] = useState('');
  const [confirmed, setConfirmed] = useState<string | null>(null); const [busy, setBusy] = useState(false);
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
  const confirmationKey = ready ? `${ready.sha256}:${assignee?.id ?? ''}:${dueAt}:${preview.dataUpdatedAt}` : '';
  const invalidDue = dueAt !== '' && !Number.isFinite(new Date(dueAt).getTime());
  const canCreate = allowCreate && ready?.canCreate && !task && !outcome && !!assignee && !invalidDue;
  const refresh = () => {
    setOutcome(null); setWriteIssue(null); setNeedsPreview(false); setConfirmed(null); void preview.refetch();
  };
  const create = async () => {
    if (!canCreate || confirmed !== confirmationKey || !ready?.sha256 || !assignee || submitting.current) return;
    submitting.current = true; setBusy(true); setConfirmed(null);
    try {
      const result = parseTaskOutcome((await api.post<unknown>(`${taskRoute(customerId, observationId)}/task`, {
        assigneeId: assignee.id, dueAt: dueAt ? new Date(dueAt).toISOString() : null, expectedSha256: ready.sha256,
      })).data, customerId);
      void client.invalidateQueries({ queryKey: activityKeys.all });
      void client.invalidateQueries({ queryKey: currentUserQueryKey });
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
      <DialogTitle>{t('parasolWork.title')}</DialogTitle>
      <DialogContent>
        <Text block>{t('parasolWork.privacy')}</Text>
        {view?.mode === 'fixture' && <MessageBar intent="warning"><MessageBarBody>{t('parasol.fixture')}</MessageBarBody></MessageBar>}
        {preview.isFetching && <Spinner size="small" label={t('common.loading')} />}
        {errorStatus && <MessageBar intent="warning" className={styles.error}><MessageBarBody>{t(`parasolWork.status.${errorStatus}`)}</MessageBarBody></MessageBar>}
        {writeIssue && <MessageBar intent="warning" className={styles.error}><MessageBarBody>{t(`parasolWork.status.${writeIssue}`)}</MessageBarBody></MessageBar>}
        {outcome && <Text block role="status">{t(`parasolWork.status.${outcome.status}`)}</Text>}
        {ready?.observation && ready.devices && <div className={technical.row}><ObservationContext observation={ready.observation} devices={ready.devices} /></div>}
        {task && <TechnicalTaskReference task={task} onNavigate={onClose} />}
        {ready && !task && !ready.canCreate && <Text block>{t('parasolWork.cannotCreate')}</Text>}
        {allowCreate && ready?.canCreate && !task && !outcome && <div className={styles.grid}>
          <Text block className={styles.wide}>{t('parasolWork.persistedSubject')}: {t('parasolWork.subject')}</Text>
          <Text block className={styles.wide}>{t('parasolWork.priority', { priority: t(ready.observation?.priority === 'URGENT' ? 'activities.priorities.High' : 'activities.priorities.Normal') })}</Text>
          <Field required label={t('parasolWork.assignee')}><UserPicker value={assignee} onChange={u => { setAssignee(u); setConfirmed(null); }} /></Field>
          <Field label={t('parasolWork.due')} validationMessage={invalidDue ? t('parasolWork.invalidDue') : undefined}>
            <Input type="datetime-local" value={dueAt} onChange={(_, d) => { setDueAt(d.value); setConfirmed(null); }} />
          </Field>
          <Checkbox className={styles.wide} label={t('parasolWork.confirm')} checked={confirmed !== null && confirmed === confirmationKey}
            disabled={!canCreate || busy} onChange={(_, d) => setConfirmed(d.checked ? confirmationKey : null)} />
        </div>}
      </DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={onClose}>{t('common.close')}</Button>
        <Button disabled={busy || preview.isFetching} onClick={refresh}>{t('parasolWork.previewAgain')}</Button>
        {allowCreate && !task && <Button appearance="primary" disabled={!canCreate || confirmed !== confirmationKey || busy}
          onClick={() => void create()}>{t('parasolWork.create')}</Button>}
      </DialogActions>
    </DialogBody></DialogSurface>
  </Dialog>;
}
