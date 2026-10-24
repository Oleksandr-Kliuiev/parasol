import type { TFunction } from 'i18next';
import type { Anomaly } from './types';

/**
 * Anomalies whose text the interface owns (DEV-19): the server sends the code and the values, the reader sees their own
 * language. Any other code, or a missing translation, shows the server's English message.
 */
const translatedAnomalies = new Set(['BIL_STALE_QUANTITY', 'BIL_NO_DEVICE_SNAPSHOT', 'BIL_INCOMPLETE_HOURS', 'BIL_NO_AGENT_READING', 'BIL_NO_SEAT_READING']);

export function anomalyText(t: TFunction, anomaly: Anomaly): string {
  if (!translatedAnomalies.has(anomaly.code)) return anomaly.message;
  const args = anomaly.args ?? {};
  const text = t(`billing.anomalyTexts.${anomaly.code}`, args);
  return args.subsidiary ? `${args.subsidiary}: ${text}` : text;
}
