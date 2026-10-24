import { Button, makeStyles } from '@fluentui/react-components';
import { LockClosed24Regular } from '../../app/shellIcons';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { CurrentUser } from '../../api/types';
import { h } from '../../app/hearth';
import { ErrorCard } from './ErrorCard';

const useStyles = makeStyles({
  text: { margin: 0 },
  who: { margin: 0, color: h.muted, fontSize: '13px', lineHeight: '18px' },
});

export function NoAccessPage({ user }: { user: CurrentUser }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const signOut = async () => {
    const { data } = await api.post<{ signOutUrl: string }>('/bff/logout');
    queryClient.clear();
    window.location.assign(data.signOutUrl);
  };
  return (
    <ErrorCard
      icon={<LockClosed24Regular />}
      tone="saffron"
      title={t('errors.noAccessTitle')}
      role="alert"
      screen
      actions={<Button onClick={() => void signOut()}>{t('header.signOut')}</Button>}
    >
      <p className={styles.text}>{t('errors.noAccessBody')}</p>
      <p className={styles.who}>
        {user.displayName}
        {user.email ? ` · ${user.email}` : ''}
      </p>
    </ErrorCard>
  );
}
