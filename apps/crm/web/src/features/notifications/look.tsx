import type { ReactElement } from 'react';
import {
  Alert16Regular,
  ArrowRepeatAll20Regular,
  CalendarCancel20Regular,
  CalendarClock20Regular,
  DocumentText20Regular,
  Handshake20Regular,
  HourglassHalf20Regular,
  Receipt20Regular,
} from '@fluentui/react-icons';
import type { Tone } from '../../app/hearth';
import type { Notification, NotificationKind } from './types';

/** The chip of each kind of notice: the icon names the subject, the tone how urgent it usually is. */
const kindLook: Record<NotificationKind, { icon: ReactElement; tone: Tone }> = {
  ContractEnding: { icon: <DocumentText20Regular />, tone: 'iris' },
  NoticeDeadline: { icon: <CalendarClock20Regular />, tone: 'saffron' },
  HourBankLow: { icon: <HourglassHalf20Regular />, tone: 'saffron' },
  SubscriptionCancellationWindow: { icon: <CalendarCancel20Regular />, tone: 'iris' },
  SubscriptionRenewal: { icon: <ArrowRepeatAll20Regular />, tone: 'spruce' },
  StaleOpportunity: { icon: <Handshake20Regular />, tone: 'neutral' },
  InvoiceOverdue: { icon: <Receipt20Regular />, tone: 'ember' },
};

/** The icon and tone of a notice, the same on the notifications page and in the bell. */
export function lookOf(notification: Notification) {
  const look = kindLook[notification.kind] ?? { icon: <Alert16Regular />, tone: 'neutral' as Tone };
  // A notice the server marks as a warning is always shown in the attention tone.
  return notification.warning ? { ...look, tone: 'ember' as Tone } : look;
}
