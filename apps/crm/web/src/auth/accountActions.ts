import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { changeLanguage as applyLanguage, type LanguageCode } from '../i18n';
import { currentUserQueryKey } from './CurrentUserContext';

/** The account menu and the account page change the language the same way: saved first, then shown. */
export function useChangeLanguage() {
  const queryClient = useQueryClient();
  return async (code: LanguageCode) => {
    // Save first: switching the UI before the request completes lets a quick reload lose the choice.
    await api.put('/api/v1/identity/me/preferences', { language: code });
    await applyLanguage(code);
    await queryClient.invalidateQueries({ queryKey: currentUserQueryKey });
  };
}

export function useSignOut() {
  const queryClient = useQueryClient();
  return async () => {
    const { data } = await api.post<{ signOutUrl: string }>('/bff/logout');
    // Nothing of this user's stays in memory for whoever uses the browser next (DEV-09).
    queryClient.clear();
    window.location.assign(data.signOutUrl);
  };
}
