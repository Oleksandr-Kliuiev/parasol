import { ApiError } from '../../api/client';

export function errorMessage(error: unknown, t: (key: string) => string): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return t('errors.forbidden');
    if (error.status === 404) return t('errors.notFoundBody');
    if (error.status === 412 || error.code === 'CONCURRENCY_CONFLICT') return t('errors.concurrency');
    return error.message || t('errors.generic');
  }
  if (error instanceof TypeError) return t('errors.network');
  return t('errors.generic');
}
