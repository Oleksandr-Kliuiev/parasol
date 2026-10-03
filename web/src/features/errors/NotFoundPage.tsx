import { useNavigate } from 'react-router';
import { Button } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../shared/components/PageHeader';
import { EmptyState } from '../../shared/components/EmptyState';

export function NotFoundPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title={t('errors.notFoundTitle')} />
      <EmptyState
        message={t('errors.notFoundBody')}
        action={
          <Button appearance="primary" onClick={() => navigate('/')}>
            {t('nav.myDay')}
          </Button>
        }
      />
    </>
  );
}
