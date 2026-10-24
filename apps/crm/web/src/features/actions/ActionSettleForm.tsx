import { Field, Radio, RadioGroup, Textarea } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { systemName } from '../integrations/labels';
import { SETTLE_REASON_MAX, SETTLE_REASON_MIN, type Settlement, type Verdict } from './settlement';
import type { VendorAction } from './types';

/** The two answers and the reason, labelled as a question (WCAG 1.3.1, 3.3.2); the dialog around it holds the button that saves. */
export function SettleFields({ action, settlement, disabled }: { action: VendorAction; settlement: Settlement; disabled?: boolean }) {
  const { t } = useTranslation();
  const system = systemName(t, action.system);
  return <>
    <Field label={t('actions.settle.question')} required>
      <RadioGroup value={settlement.verdict} disabled={disabled} onChange={(_, data) => settlement.setVerdict(data.value as Verdict)}>
        <Radio value="Succeeded" label={t('actions.settle.done', { system })} />
        <Radio value="Failed" label={t('actions.settle.notDone', { system })} />
      </RadioGroup>
    </Field>
    <Field label={t('actions.settle.reason')} required hint={t('actions.dialog.reasonHint', { min: SETTLE_REASON_MIN, max: SETTLE_REASON_MAX })}>
      <Textarea value={settlement.reason} disabled={disabled} onChange={(_, data) => settlement.setReason(data.value)} maxLength={SETTLE_REASON_MAX}
        resize="vertical" />
    </Field>
  </>;
}
