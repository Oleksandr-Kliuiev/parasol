import {
  Button,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
} from '@fluentui/react-components';
import { Dialog } from '../shared/components/Dialog';
import { useKeptWhileClosing } from '../shared/components/useKeptWhileClosing';
import { useTranslation } from 'react-i18next';

/** The dialog of ReverifyDialog: what it says and the two choices. The state and the event listener stay in ReverifyDialog. */
export function ReverifyDialogView({ mode, unsaved, onClose, onConfirm }: {
  mode: 'closed' | 'required' | 'failed';
  unsaved: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  // What the dialog said stays while it leaves.
  const shown = useKeptWhileClosing(mode, mode !== 'closed');
  return (
    <Dialog open={mode !== 'closed'} modalType="alert" onOpenChange={(_, data) => !data.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{shown === 'failed' ? t('reverify.failedTitle') : t('reverify.title')}</DialogTitle>
          <DialogContent>
            <p>{shown === 'failed' ? t('reverify.failedBody') : t('reverify.body')}</p>
            {shown === 'required' && unsaved && (
              <MessageBar intent="warning" layout="multiline">
                <MessageBarBody>{t('reverify.unsaved')}</MessageBarBody>
              </MessageBar>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={onConfirm}>
              {shown === 'failed' ? t('reverify.tryAgain') : unsaved ? t('reverify.continueAnyway') : t('reverify.confirm')}
            </Button>
            <Button onClick={onClose}>{shown === 'required' && unsaved ? t('reverify.stay') : t('reverify.cancel')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
