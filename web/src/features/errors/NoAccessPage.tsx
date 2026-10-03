import { Button, Text, makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import type { CurrentUser } from '../../api/types';

const useStyles = makeStyles({
  root: {
    minHeight: '100vh',
    display: 'grid',
    placeItems: 'center',
    paddingInline: tokens.spacingHorizontalL,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  card: {
    maxWidth: '520px',
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: tokens.spacingHorizontalXXL,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow8,
  },
  title: { margin: 0, fontSize: tokens.fontSizeBase600, fontWeight: tokens.fontWeightSemibold },
});

export function NoAccessPage({ user }: { user: CurrentUser }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const signOut = async () => {
    const { data } = await api.post<{ signOutUrl: string }>('/bff/logout');
    window.location.assign(data.signOutUrl);
  };
  return (
    <div className={styles.root}>
      <div className={styles.card} role="alert">
        <h1 className={styles.title}>{t('errors.noAccessTitle')}</h1>
        <Text>{t('errors.noAccessBody')}</Text>
        <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
          {user.displayName}
          {user.email ? ` · ${user.email}` : ''}
        </Text>
        <div>
          <Button onClick={() => void signOut()}>{t('header.signOut')}</Button>
        </div>
      </div>
    </div>
  );
}
