import { useRouteError } from 'react-router';
import { Button, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle, makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';

const useStyles = makeStyles({
  root: { paddingInline: tokens.spacingHorizontalXXL, paddingBlock: tokens.spacingVerticalXXL, maxWidth: '720px' },
});

/** Shown instead of a blank page when rendering a route throws; the details go to the console, not the screen. */
export function RouteErrorPage() {
  const styles = useStyles();
  const { t } = useTranslation();
  const error = useRouteError();
  console.error(error);
  return (
    <div className={styles.root} role="alert">
      <MessageBar intent="error" layout="multiline">
        <MessageBarBody>
          <MessageBarTitle>{t('errors.generic')}</MessageBarTitle>
          {t('errors.pageCrashed')}
        </MessageBarBody>
        <MessageBarActions>
          <Button onClick={() => window.location.reload()}>{t('common.reload')}</Button>
        </MessageBarActions>
      </MessageBar>
    </div>
  );
}
