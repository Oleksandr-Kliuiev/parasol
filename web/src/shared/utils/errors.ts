import { ApiError } from '../../api/client';

export function errorMessage(error: unknown, t: (key: string) => string): string {
  if (error instanceof ApiError) {
    // A domain error the interface knows is shown in the user's language, whatever its status (a refused approval is a 403
    // with a reason of its own); others fall back to the status and then to the server's text.
    if (error.code) {
      const key = `errors.codes.${error.code}`;
      const translated = t(key);
      if (translated !== key) return translated;
    }
    if (error.status === 403) return t('errors.forbidden');
    if (error.status === 404) return t('errors.notFoundBody');
    if (error.status === 412 || error.code === 'CONCURRENCY_CONFLICT') return t('errors.concurrency');
    return error.message || t('errors.generic');
  }
  if (error instanceof TypeError) return t('errors.network');
  return t('errors.generic');
}
