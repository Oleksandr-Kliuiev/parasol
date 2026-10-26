import { MessageBar, MessageBarBody, Text } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { AppLink } from '../../shared/components/AppLink';
import { ConfirmDialog } from '../../shared/components/ConfirmDialog';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { todayIso } from '../../shared/utils/format';
import { usePeriodActions } from './api';
import { monthName } from './monthName';

/**
 * Closing a month locks its hours (FR-TIM-03) and only Finance can open it again, so the step asks first: it names the month,
 * says when the month has not ended yet, and holds back a close the server refuses while entries wait for approval.
 */
export function ClosePeriodDialog({ open, year, month, waiting, waitingHref, onClosed, onCancel }: {
  open: boolean; year: number; month: number; waiting: number; waitingHref: string; onClosed: () => void; onCancel: () => void;
}) {
  const { t, i18n } = useTranslation();
  const notify = useNotify();
  const actions = usePeriodActions();
  const name = monthName(year, month, i18n.language);
  const [thisYear, thisMonth] = todayIso().split('-').map(Number);
  const ended = year * 12 + month < thisYear! * 12 + thisMonth!;
  const close = async () => {
    try {
      await actions.close.mutateAsync({ year, month });
      notify(t('time.periodClosedDone'));
      onClosed();
    } catch {
      // The dialog stays and says why.
    }
  };
  return (
    <ConfirmDialog open={open} title={t('time.closePeriodTitle', { month: name })} confirm={t('time.closePeriodConfirm', { month: name })}
      busy={actions.close.isPending} blocked={waiting > 0} error={actions.close.error ? errorMessage(actions.close.error, t) : null}
      onConfirm={() => void close()} onCancel={() => { actions.close.reset(); onCancel(); }}>
      <Text block>{t('time.closePeriodBody', { month: name })}</Text>
      {waiting > 0 && (
        <MessageBar intent="warning"><MessageBarBody>
          {t('time.closePeriodWaiting', { count: waiting, month: name })}{' '}
          <AppLink to={waitingHref} onClick={onCancel}>{t('time.closePeriodShowWaiting')}</AppLink>
        </MessageBarBody></MessageBar>
      )}
      {waiting === 0 && !ended && (
        <MessageBar intent="warning"><MessageBarBody>{t('time.closePeriodNotEnded', { month: name })}</MessageBarBody></MessageBar>
      )}
    </ConfirmDialog>
  );
}
