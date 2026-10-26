import { useNavigate } from 'react-router';
import { Button } from '@fluentui/react-components';
import { LockClosed24Regular } from '../../app/shellIcons';
import { useTranslation } from 'react-i18next';
import { ErrorCard } from './ErrorCard';

/**
 * A page the person's permissions do not open. Said as it is (not "does not exist"), with whom to ask and a way back (UX 2026);
 * it speaks of access, not of roles, since every employee has full access (M38).
 * A record outside the person's scope stays "not found" (DEV-09): there the server does not confirm the record exists.
 */
export function ForbiddenPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <ErrorCard
      icon={<LockClosed24Regular />}
      tone="saffron"
      title={t('errors.forbiddenTitle')}
      pageTitle
      actions={
        <Button appearance="primary" onClick={() => navigate('/')}>
          {t('nav.myDay')}
        </Button>
      }
    >
      <p style={{ margin: 0 }}>{t('errors.forbiddenPage')}</p>
    </ErrorCard>
  );
}
