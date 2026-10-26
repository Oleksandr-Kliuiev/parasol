import { useRouteError } from 'react-router';
import { Button } from '@fluentui/react-components';
import { ErrorCircle24Regular } from '../../app/shellIcons';
import { useTranslation } from 'react-i18next';
import { ErrorCard } from './ErrorCard';

/** Shown instead of a blank page when rendering a route throws; the details go to the console, not the screen. */
export function RouteErrorPage() {
  const { t } = useTranslation();
  const error = useRouteError();
  console.error(error);
  return (
    <ErrorCard
      icon={<ErrorCircle24Regular />}
      tone="ember"
      title={t('errors.generic')}
      role="alert"
      actions={<Button appearance="primary" onClick={() => window.location.reload()}>{t('common.reload')}</Button>}
    >
      <p style={{ margin: 0 }}>{t('errors.pageCrashed')}</p>
    </ErrorCard>
  );
}
