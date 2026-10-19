import { Spinner, Text } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { ErrorState } from '../../shared/components/ErrorState';

/** Unavailable mirror data must never be presented as a successful empty read. */
export function SavedServiceReadState({ checking, error, onRetry }: { checking: boolean; error: unknown; onRetry: () => void }) {
  const { t } = useTranslation();
  if (checking) return <Spinner size="small" label={t('service.loadingSaved')} />;
  if (error) return <><Text role="status">{t('service.readFailed')}</Text><ErrorState error={error} onRetry={onRetry} /></>;
  return null;
}
