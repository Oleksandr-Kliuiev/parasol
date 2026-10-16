import { useEffect, useRef } from 'react';
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import type { useUnsavedChanges } from './useUnsavedChanges';

export function UnsavedChangesDialog({ blocker }: { blocker: ReturnType<typeof useUnsavedChanges>['blocker'] }) {
  const { t } = useTranslation();
  // The dialog is opened by navigation, not by a trigger, so it cannot return focus by itself: remember where it was.
  const origin = useRef<HTMLElement | null>(null);
  const wasBlocked = useRef(false);
  useEffect(() => {
    // The last thing focused outside a dialog: the control that started the navigation.
    const track = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && !event.target.closest('[role=dialog], [role=alertdialog]')) origin.current = event.target;
    };
    document.addEventListener('focusin', track);
    return () => document.removeEventListener('focusin', track);
  }, []);
  useEffect(() => {
    if (blocker.state === 'blocked') {
      wasBlocked.current = true;
      return;
    }
    if (wasBlocked.current) {
      // The user stayed: give the dialog's own focus handling a moment to finish, then go back to where they were.
      wasBlocked.current = false;
      const timer = setTimeout(() => origin.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  });
  return (
    <Dialog open={blocker.state === 'blocked'} modalType="alert">
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{t('forms.unsaved.title')}</DialogTitle>
          <DialogContent>{t('forms.unsaved.body')}</DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={() => blocker.state === 'blocked' && blocker.reset()}>
              {t('forms.unsaved.stay')}
            </Button>
            <Button onClick={() => blocker.state === 'blocked' && blocker.proceed()}>{t('forms.unsaved.leave')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
