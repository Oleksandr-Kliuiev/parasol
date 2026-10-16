import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { REVERIFY_EVENT, reverifyHref } from '../api/client';
import { hasUnsavedChanges } from '../shared/forms/useUnsavedChanges';

const FAILED_PARAMETER = 'reverify';

type Mode = { kind: 'closed' } | { kind: 'required'; url: unknown } | { kind: 'failed' };

/**
 * "Confirm your identity to continue" (F-G2-08). A privileged action the server refused with AUTH_REVERIFY_REQUIRED opens it;
 * confirming is a full-page sign-in with Entra that comes back to this page, so the person repeats the action afterwards. A page
 * reload loses what is typed into a form, so when some form holds unsaved changes the dialog says so and the person chooses:
 * stay and save first, or continue. Nothing is dropped silently. It also reports the sign-in coming back unaccepted
 * (`?reverify=failed`), with another try.
 */
export function ReverifyDialog() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>(() =>
    new URLSearchParams(window.location.search).get(FAILED_PARAMETER) === 'failed' ? { kind: 'failed' } : { kind: 'closed' },
  );
  const [unsaved, setUnsaved] = useState(false);
  // The dialog is opened by an event, not by a trigger, so it cannot return focus by itself: remember where it was.
  const origin = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // The failure marker is for this one view; the address goes back to what the person was looking at.
    const params = new URLSearchParams(window.location.search);
    if (params.get(FAILED_PARAMETER) === 'failed') {
      params.delete(FAILED_PARAMETER);
      const search = params.toString();
      window.history.replaceState(window.history.state, '', window.location.pathname + (search ? `?${search}` : '') + window.location.hash);
    }
  }, []);

  useEffect(() => {
    const open = (event: Event) => {
      origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setUnsaved(hasUnsavedChanges());
      setMode({
        kind: 'required',
        url: (event as CustomEvent<{ url?: unknown }>).detail?.url,
      });
    };
    window.addEventListener(REVERIFY_EVENT, open);
    return () => window.removeEventListener(REVERIFY_EVENT, open);
  }, []);

  const close = () => {
    setMode({ kind: 'closed' });
    setTimeout(() => origin.current?.focus(), 50);
  };
  const confirm = () => window.location.assign(reverifyHref(mode.kind === 'required' ? mode.url : undefined));

  return (
    <Dialog open={mode.kind !== 'closed'} modalType="alert" onOpenChange={(_, data) => !data.open && close()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{mode.kind === 'failed' ? t('reverify.failedTitle') : t('reverify.title')}</DialogTitle>
          <DialogContent>
            <p>{mode.kind === 'failed' ? t('reverify.failedBody') : t('reverify.body')}</p>
            {mode.kind === 'required' && unsaved && (
              <MessageBar intent="warning" layout="multiline">
                <MessageBarBody>{t('reverify.unsaved')}</MessageBarBody>
              </MessageBar>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={confirm}>
              {mode.kind === 'failed' ? t('reverify.tryAgain') : unsaved ? t('reverify.continueAnyway') : t('reverify.confirm')}
            </Button>
            <Button onClick={close}>{mode.kind === 'required' && unsaved ? t('reverify.stay') : t('reverify.cancel')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
