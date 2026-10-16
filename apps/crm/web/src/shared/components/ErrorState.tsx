import { Button, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../utils/errors';

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <MessageBar intent="error" layout="multiline">
      <MessageBarBody>
        <MessageBarTitle>{t('errors.generic')}</MessageBarTitle>
        {errorMessage(error, t)}
      </MessageBarBody>
      {onRetry && (
        <MessageBarActions>
          <Button onClick={onRetry}>{t('common.retry')}</Button>
        </MessageBarActions>
      )}
    </MessageBar>
  );
}
