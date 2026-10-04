import { useEffect, useRef, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Spinner, makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { api, ApiError, loginUrl } from '../api/client';
import type { CurrentUser } from '../api/types';
import i18n, { changeLanguage, detectLanguage } from '../i18n';
import { CurrentUserContext, currentUserQueryKey } from './CurrentUserContext';
import { NoAccessPage } from '../features/errors/NoAccessPage';
import { ErrorState } from '../shared/components/ErrorState';

const useStyles = makeStyles({
  center: { display: 'grid', placeItems: 'center', minHeight: '100vh', backgroundColor: tokens.colorNeutralBackground2 },
});

export function AuthGate({ children }: { children: ReactNode }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data, error, isPending, refetch } = useQuery({
    queryKey: currentUserQueryKey,
    queryFn: async ({ signal }) => (await api.get<CurrentUser>('/bff/user', signal)).data,
    retry: false,
    staleTime: 5 * 60_000,
    // Asked again whenever the window gets focus, so a different sign-in on this browser is noticed at once (below).
    refetchOnWindowFocus: 'always',
  });

  // Someone else signed in on this browser (another tab, a shared PC): nothing cached for the previous user may be shown,
  // so the cache is dropped and the app starts over for the new one (DEV-09).
  const signedIn = useRef<string | null>(null);
  useEffect(() => {
    if (!data) return;
    if (signedIn.current !== null && signedIn.current !== data.id) {
      queryClient.clear();
      window.location.reload();
    }
    signedIn.current = data.id;
  }, [data, queryClient]);

  const unauthenticated = error instanceof ApiError && error.status === 401;

  useEffect(() => {
    if (unauthenticated) window.location.assign(loginUrl());
  }, [unauthenticated]);

  useEffect(() => {
    const language = data ? detectLanguage(data.preferredLanguage) : null;
    if (language && language !== i18n.language) void changeLanguage(language);
  }, [data]);

  if (isPending || unauthenticated) {
    return (
      <div className={styles.center}>
        <Spinner label={t('common.loading')} />
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.center}>
        <ErrorState error={error} onRetry={() => void refetch()} />
      </div>
    );
  }

  if (data.roles.length === 0) {
    return <NoAccessPage user={data} />;
  }

  return <CurrentUserContext.Provider value={data}>{children}</CurrentUserContext.Provider>;
}
