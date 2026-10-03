import { Toast, ToastBody, ToastTitle, useToastController, type ToastIntent } from '@fluentui/react-components';
import { useCallback } from 'react';
import { TOASTER_ID } from '../../app/toaster';

export function useNotify() {
  const { dispatchToast } = useToastController(TOASTER_ID);
  return useCallback(
    (title: string, intent: ToastIntent = 'success', body?: string) =>
      dispatchToast(
        <Toast>
          <ToastTitle>{title}</ToastTitle>
          {body && <ToastBody>{body}</ToastBody>}
        </Toast>,
        { intent, timeout: intent === 'error' ? 8000 : 4000 },
      ),
    [dispatchToast],
  );
}
