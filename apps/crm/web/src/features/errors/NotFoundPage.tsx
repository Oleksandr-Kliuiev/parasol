import { useNavigate } from 'react-router';
import { Button } from '@fluentui/react-components';
import { DocumentQuestionMark24Regular } from '../../app/shellIcons';
import { useTranslation } from 'react-i18next';
import { ErrorCard } from './ErrorCard';

export function NotFoundPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <ErrorCard
      icon={<DocumentQuestionMark24Regular />}
      tone="iris"
      title={t('errors.notFoundTitle')}
      pageTitle
      actions={
        <Button appearance="primary" onClick={() => navigate('/')}>
          {t('nav.myDay')}
        </Button>
      }
    >
      <p style={{ margin: 0 }}>{t('errors.notFoundBody')}</p>
    </ErrorCard>
  );
}
