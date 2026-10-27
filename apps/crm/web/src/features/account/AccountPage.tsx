import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { Avatar, Button, Text, makeStyles } from '@fluentui/react-components';
import { Person16Regular, SignOut20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import type { CurrentUser } from '../../api/types';
import { h } from '../../app/hearth';
import { useSignOut } from '../../auth/accountActions';
import { useCurrentUser } from '../../auth/CurrentUserContext';
import { PageHeader } from '../../shared/components/PageHeader';
import { FactGrid, Panel } from '../../shared/components/Panel';
import { formatDateTime } from '../../shared/utils/format';
import { NotificationPreferencesPanel } from '../notifications/NotificationPreferencesPanel';
import { AccountSettingsPanel } from './AccountSettingsPanel';
import { AteraTechnicianPanel } from './AteraTechnicianPanel';

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
    gap: '16px',
    alignItems: 'start',
    '@media (max-width: 1000px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  column: { display: 'grid', gap: '16px', minWidth: 0 },
  // The person as the directory knows them: avatar, name, then the address and the title in quieter lines.
  who: { display: 'flex', alignItems: 'center', gap: '14px', minWidth: 0, marginBottom: '16px' },
  whoText: { display: 'grid', gap: '2px', minWidth: 0, overflowWrap: 'anywhere' },
  name: { fontFamily: h.display, fontSize: '20px', lineHeight: '26px', fontWeight: 600, letterSpacing: '-0.01em', color: h.text },
  detail: { color: h.muted, fontSize: '13px', lineHeight: '18px' },
  source: { display: 'block', marginTop: '14px', color: h.muted, fontSize: '12.5px', lineHeight: '18px' },
  // The page's own anchors land below the sticky top bar.
  anchor: { scrollMarginTop: '88px', minWidth: 0 },
});

/** The signed-in person's own page: who Parasoll takes them for, and the settings that are theirs alone. */
export function AccountPage() {
  const styles = useStyles();
  const { t } = useTranslation();
  const user = useCurrentUser();
  const signOut = useSignOut();
  const { hash } = useLocation();

  // A link to one card of the page (the notifications page links to the e-mail settings) shows that card.
  useEffect(() => {
    if (!hash) return;
    document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash]);

  const role = [user.jobTitle, user.department].filter(Boolean).join(' · ');

  return (
    <>
      <PageHeader
        title={t('account.title')}
        subtitle={t('account.subtitle')}
      />

      <div className={styles.grid}>
        <div className={styles.column}>
          {/* Signing out sits with the sign-in it ends, as a quiet action: on a phone it must not be the page's first button. */}
          <Panel
            title={t('account.profile.title')}
            icon={<Person16Regular />}
            actions={<Button size="small" icon={<SignOut20Regular />} onClick={() => void signOut()}>{t('header.signOut')}</Button>}
          >
            <div className={styles.who}>
              <Avatar name={user.displayName} size={56} color="colorful" aria-hidden />
              <span className={styles.whoText}>
                <Text className={styles.name}>{user.displayName}</Text>
                {user.email && <Text className={styles.detail}>{user.email}</Text>}
                {role && <Text className={styles.detail}>{role}</Text>}
              </span>
            </div>
            <FactGrid
              items={[
                { label: t('account.profile.access'), value: accessOf(user, t) },
                { label: t('account.profile.signIn'), value: t(`account.profile.signInModes.${user.authMode}`) },
                {
                  label: t('account.profile.signedInAt'),
                  value: user.lastLoginAt && <time dateTime={user.lastLoginAt}>{formatDateTime(user.lastLoginAt)}</time>,
                },
              ]}
            />
            <Text className={styles.source}>{t(user.authMode === 'Entra' ? 'account.profile.fromEntra' : 'account.profile.fromDevelopment')}</Text>
          </Panel>
          <AccountSettingsPanel />
          <AteraTechnicianPanel />
        </div>
        <div className={styles.column}>
          <div id="notifications" className={styles.anchor}>
            <NotificationPreferencesPanel />
          </div>
        </div>
      </div>
    </>
  );
}

/** Every employee has full access (ADR-030); the narrower roles exist for testing the permission checks. */
function accessOf(user: CurrentUser, t: (key: string) => string): string {
  if (user.roles.includes('Crm.Admin')) return t('account.profile.roles.Admin');
  if (user.roles.length === 0) return t('account.profile.noAccess');
  return user.roles.map((role) => t(`account.profile.roles.${role.replace(/^Crm\./, '')}`)).join(', ');
}
