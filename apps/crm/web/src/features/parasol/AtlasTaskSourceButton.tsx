import { useState } from 'react';
import {
  Button,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan, useCurrentUser } from '../../auth/CurrentUserContext';
import { ObservationContext } from './ObservationContext';
import { TechnicalTaskReference } from './TechnicalTaskReference';
import { useTechnicalStyles } from './technicalStyles';
import { taskReadErrorStatus, useObservationTaskPreview } from './useObservationTaskPreview';

export function AtlasTaskSourceButton({ activityId }: { activityId: string }) {
  const { t } = useTranslation(); const user = useCurrentUser(); const [open, setOpen] = useState(false);
  const canRead = useCan(Permissions.activitiesRead); const canAtlas = useCan(Permissions.parasolAtlasRead);
  const restoreFocus = useRestoreFocusTarget();
  if (!canRead || !canAtlas) return null;
  return <>
    <Button {...restoreFocus} appearance="subtle" size="small" onClick={() => setOpen(true)}>{t('parasolWork.source')}</Button>
    {open && <SourceDialog key={`${user.id}:${activityId}`} activityId={activityId} onClose={() => setOpen(false)} />}
  </>;
}

function SourceDialog({ activityId, onClose }: { activityId: string; onClose: () => void }) {
  const { t } = useTranslation(); const styles = useTechnicalStyles(); const preview = useObservationTaskPreview({ activityId });
  const view = !preview.isFetching && !preview.isError ? preview.data : undefined;
  const ready = view?.status === 'READY' ? view : null;
  const error = preview.isError ? taskReadErrorStatus(preview.error)
    : view && view.status !== 'READY' ? view.status : null;
  return <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
    <DialogSurface><DialogBody>
      <DialogTitle>{t('parasolWork.source')}</DialogTitle>
      <DialogContent>
        <Text block>{t('parasolWork.sourceNote')}</Text>
        {preview.isFetching && <Spinner size="small" label={t('common.loading')} />}
        {view?.mode === 'fixture' && <MessageBar intent="warning"><MessageBarBody>{t('parasol.fixture')}</MessageBarBody></MessageBar>}
        {error && <MessageBar intent="warning"><MessageBarBody>{t(`parasolWork.status.${error}`)}</MessageBarBody></MessageBar>}
        {ready?.observation && ready.devices && <div className={styles.row}><ObservationContext exact observation={ready.observation} devices={ready.devices} /></div>}
        {view?.task && <TechnicalTaskReference task={view.task} onNavigate={onClose} />}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.close')}</Button>
        <Button disabled={preview.isFetching} onClick={() => void preview.refetch()}>{t('parasol.refresh')}</Button>
      </DialogActions>
    </DialogBody></DialogSurface>
  </Dialog>;
}
