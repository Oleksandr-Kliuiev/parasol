import { ApiError } from '../../api/client';

export function errorMessage(error: unknown, t: (key: string) => string): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return t('errors.forbidden');
    if (error.status === 404) return t('errors.notFoundBody');
    if (error.status === 412 || error.code === 'CONCURRENCY_CONFLICT') return t('errors.concurrency');
    // A domain error the interface knows is shown in the user's language; others fall back to the server's text.
    if (error.code) {
      const key = `errors.codes.${error.code}`;
      const translated = t(key);
      if (translated !== key) return translated;
    }
    return error.message || t('errors.generic');
  }
  if (error instanceof TypeError) return t('errors.network');
  return t('errors.generic');
}
