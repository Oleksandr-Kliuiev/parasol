import { Button } from '@fluentui/react-components';
import { CheckmarkCircle24Regular, WrenchScrewdriver24Regular } from '../../app/shellIcons';
import { useTranslation } from 'react-i18next';
import { loginUrl } from '../../api/client';
import { formatDateTime } from '../../shared/utils/format';
import { ErrorCard } from '../errors/ErrorCard';
import type { PublicMaintenance } from './api';

/**
 * Signing in writes (the user is provisioned, a session opened), so while the CRM is read-only only the operators who run the
 * maintenance sign in (DEV-13). Anyone else comes back with <c>?maintenance=signin</c>; this page says why instead of going
 * round in circles, and lets an operator sign in.
 */
export function SignInPausedPage({ state, onCheck }: { state: PublicMaintenance | undefined; onCheck: () => void }) {
  const { t } = useTranslation();
  const over = state?.mode === 'Normal';

  return (
    <ErrorCard
      as="main"
      screen
      icon={over ? <CheckmarkCircle24Regular /> : <WrenchScrewdriver24Regular />}
      tone={over ? 'spruce' : 'saffron'}
      title={over ? t('maintenance.signIn.overTitle') : t('maintenance.signIn.title')}
      actions={
        over ? (
          <Button appearance="primary" onClick={() => window.location.assign(loginUrl('/'))}>
            {t('maintenance.signIn.signIn')}
          </Button>
        ) : (
          <>
            <Button appearance="subtle" onClick={() => window.location.assign(loginUrl('/admin/maintenance'))}>
              {t('maintenance.signIn.operator')}
            </Button>
            <Button appearance="primary" onClick={onCheck}>{t('maintenance.signIn.check')}</Button>
          </>
        )
      }
    >
      <p style={{ margin: 0 }}>
        {over
          ? t('maintenance.signIn.overBody')
          : state?.since
            ? t('maintenance.signIn.bodySince', { since: formatDateTime(state.since) })
            : t('maintenance.signIn.body')}
      </p>
    </ErrorCard>
  );
}
