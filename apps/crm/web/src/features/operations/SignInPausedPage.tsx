import { Button, Text, makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { loginUrl } from '../../api/client';
import { formatDateTime } from '../../shared/utils/format';
import type { PublicMaintenance } from './api';

const useStyles = makeStyles({
  center: { display: 'grid', placeItems: 'center', minHeight: '100vh', backgroundColor: tokens.colorNeutralBackground2 },
  card: {
    maxWidth: '480px',
    margin: tokens.spacingHorizontalL,
    padding: tokens.spacingHorizontalXXL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  title: { margin: 0, fontSize: tokens.fontSizeBase500, fontWeight: tokens.fontWeightSemibold },
});

/**
 * Signing in writes (the user is provisioned, a session opened), so while the CRM is read-only only the operators who run the
 * maintenance sign in (DEV-13). Anyone else comes back with <c>?maintenance=signin</c>; this page says why instead of going
 * round in circles, and lets an operator sign in.
 */
export function SignInPausedPage({ state, onCheck }: { state: PublicMaintenance | undefined; onCheck: () => void }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const over = state?.mode === 'Normal';

  return (
    <main className={styles.center}>
      <div className={styles.card}>
        <h1 className={styles.title}>{over ? t('maintenance.signIn.overTitle') : t('maintenance.signIn.title')}</h1>
        <Text block>
          {over
            ? t('maintenance.signIn.overBody')
            : state?.since
              ? t('maintenance.signIn.bodySince', { since: formatDateTime(state.since) })
              : t('maintenance.signIn.body')}
        </Text>
        <div>
          {over ? (
            <Button appearance="primary" onClick={() => window.location.assign(loginUrl('/'))}>
              {t('maintenance.signIn.signIn')}
            </Button>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <Button onClick={onCheck}>{t('maintenance.signIn.check')}</Button>
              <Button appearance="subtle" onClick={() => window.location.assign(loginUrl('/admin/maintenance'))}>
                {t('maintenance.signIn.operator')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
