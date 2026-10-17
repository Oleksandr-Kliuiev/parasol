import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, MessageBar, MessageBarBody, Spinner, Text, makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { ErrorState } from '../../shared/components/ErrorState';
import { errorMessage } from '../../shared/utils/errors';
import { formatDateTime } from '../../shared/utils/format';
import { TimeEntryDialog } from '../time/TimeEntryDialog';
import { SavedTicketPicker } from './SavedTicketPicker';
import { useTaskTicket } from './useTaskTicket';
import type { Activity } from './types';
import type { TicketWorkRef } from './taskTicketTypes';

const useStyles = makeStyles({
  content: { display: 'grid', gap: tokens.spacingVerticalM, overflowWrap: 'anywhere', minWidth: 0 },
  actions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  ticket: { display: 'grid', gap: tokens.spacingVerticalXS },
});

interface Props {
  activity: Activity; scope: string; onClose: () => void; canWrite: boolean; canLogTime: boolean;
}

/** Mount the modal only once its code is ready, so its first keyboard focus is usable. */
export default function TaskTicketDialog(props: Props) {
  return <Dialog open onOpenChange={(_, data) => { if (!data.open) props.onClose(); }}>
    <DialogSurface><TaskTicketContent {...props} /></DialogSurface>
  </Dialog>;
}

function TaskTicketContent({ activity, scope, onClose, canWrite, canLogTime }: Props) {
  const { t } = useTranslation(); const styles = useStyles();
  const link = useTaskTicket(activity.id, activity.organizationId, scope);
  const [choosing, setChoosing] = useState(false); const [selected, setSelected] = useState<TicketWorkRef | null>(null);
  const [timeOpen, setTimeOpen] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const returningFromTime = useRef(false);
  useEffect(() => {
    if (!timeOpen && returningFromTime.current) { returningFromTime.current = false; closeButton.current?.focus(); }
  }, [timeOpen]);
  const invalidateSelection = useCallback(() => setSelected(null), []);
  const association = link.association;
  const ticket = association?.available ? association.ticket : null;
  const save = async (ticketId: string | null, trigger: HTMLButtonElement) => {
    if (await link.save(ticketId)) {
      if (document.activeElement === trigger) closeButton.current?.focus();
      setChoosing(false); setSelected(null); link.refresh();
    }
  };
  const refresh = () => { setChoosing(false); setSelected(null); setTimeOpen(false); link.refresh(); };
  if (timeOpen && ticket) return <TimeEntryDialog taskContext={{
    activityId: activity.id, organization: { id: activity.organizationId, name: activity.organizationName ?? activity.organizationId }, ticket,
  }} onClose={() => { returningFromTime.current = true; setTimeOpen(false); link.refresh(); }} />;
  return <DialogBody>
    <DialogTitle>{t('taskTicket.title')}</DialogTitle>
    <DialogContent className={styles.content}>
      <Text weight="semibold">{activity.subject}</Text>
      <Text size={200}>{t('taskTicket.savedHint')}</Text>
      {link.isFetching && <Spinner size="small" label={t('taskTicket.loading')} />}
      {link.error && <ErrorState error={link.error} onRetry={refresh} />}
      {association && <>
        {ticket ? <div className={styles.ticket}>
          <Text weight="semibold">#{ticket.externalId} · {ticket.title}</Text>
          <Text>{ticket.status}</Text>
          <Text size={200}>{t('taskTicket.imported', { at: formatDateTime(ticket.importedAt) })}</Text>
        </div> : <Text role="status">{t(association.ticketId ? 'taskTicket.unavailable' : 'taskTicket.none')}</Text>}
        {canWrite && <div className={styles.actions}>
          <Button disabled={link.pending || link.conflict} disabledFocusable={link.pending || link.conflict}
            onClick={() => { setChoosing(value => !value); setSelected(null); }}>{t(association.ticketId ? 'taskTicket.change' : 'taskTicket.choose')}</Button>
          {association.ticketId && <Button disabled={link.pending || link.conflict} disabledFocusable={link.pending || link.conflict}
            onClick={event => void save(null, event.currentTarget)}>{t('taskTicket.unlink')}</Button>}
        </div>}
        {choosing && canWrite && <SavedTicketPicker key={link.revision} organizationId={activity.organizationId} scope={scope}
          revision={link.revision} selectedId={selected?.id ?? null} onSelect={setSelected} onInvalidate={invalidateSelection} disabled={link.pending || link.conflict} />}
      </>}
      {link.failure && <MessageBar intent="error"><MessageBarBody>{link.conflict ? t('taskTicket.conflict') : errorMessage(link.failure, t)}</MessageBarBody></MessageBar>}
    </DialogContent>
    <DialogActions className={styles.actions}>
      <Button ref={closeButton} onClick={onClose}>{t('common.close')}</Button>
      <Button onClick={refresh} disabled={link.pending || link.isFetching} disabledFocusable={link.pending || link.isFetching}>{t('taskTicket.refresh')}</Button>
      {canWrite && choosing && <Button appearance="primary" disabled={!selected || link.pending || link.conflict || !association}
        disabledFocusable={link.pending || link.conflict} onClick={event => { if (selected) void save(selected.id, event.currentTarget); }}>{t('taskTicket.link')}</Button>}
      {canLogTime && ticket && !choosing && <Button appearance="primary" disabled={link.pending || link.conflict}
        disabledFocusable={link.pending || link.conflict} onClick={() => setTimeOpen(true)}>{t('time.register')}</Button>}
    </DialogActions>
  </DialogBody>;
}
