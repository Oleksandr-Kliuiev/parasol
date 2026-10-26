import { Button, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { errorMessage } from '../utils/errors';

/**
 * A read that failed. A refusal (403) is not a failure to try again: it says the page is not this person's to see and
 * whom to ask, in the same words wherever it happens (UX 2026), and offers no retry that would be refused again.
 */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  const refused = error instanceof ApiError && error.status === 403 && error.code !== 'AUTH_REVERIFY_REQUIRED';
  return (
    <MessageBar intent={refused ? 'warning' : 'error'} layout="multiline">
      <MessageBarBody>
        <MessageBarTitle>{t(refused ? 'errors.forbiddenTitle' : 'errors.generic')}</MessageBarTitle>
        {refused ? t('errors.forbiddenRead') : errorMessage(error, t)}
      </MessageBarBody>
      {onRetry && !refused && (
        <MessageBarActions>
          <Button onClick={onRetry}>{t('common.retry')}</Button>
        </MessageBarActions>
      )}
    </MessageBar>
  );
}
