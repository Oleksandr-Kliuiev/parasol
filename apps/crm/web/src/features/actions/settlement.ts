import { useState } from 'react';
import { settleAction } from './api';
import type { VendorAction } from './types';

export const SETTLE_REASON_MIN = 10;
export const SETTLE_REASON_MAX = 500;

export type Verdict = 'Succeeded' | 'Failed';

/**
 * A person's verdict on an action without a clear answer (M39.1): whether it happened at the vendor, and what they checked. The same
 * form sits in the action's card and in the confirmation whose follow-up ended without an answer; settling sends nothing.
 */
export function useSettlement() {
  const [verdict, setVerdict] = useState<Verdict | ''>('');
  const [reason, setReason] = useState('');
  const ready = verdict !== '' && reason.trim().length >= SETTLE_REASON_MIN;
  return {
    verdict, setVerdict, reason, setReason, ready,
    settle: (action: VendorAction) => settleAction(action, verdict as Verdict, reason.trim()),
  };
}

export type Settlement = ReturnType<typeof useSettlement>;
