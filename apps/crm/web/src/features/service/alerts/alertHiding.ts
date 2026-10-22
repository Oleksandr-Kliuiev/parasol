import { api } from '../../../api/client';
import type { Alert } from '../types';

/** A day as the date field and the API write it (yyyy-mm-dd), `days` after today in the browser's zone. */
export function dayIn(days: number, now: Date = new Date()): string {
  const day = new Date(now); day.setDate(day.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/** The quick days of the hide dialog, in the order they are offered. */
export const hideShortcuts = [['tomorrow', 1], ['inAWeek', 7], ['inAMonth', 30]] as const;

/** How far ahead the server lets an alert be hidden. */
export const hideMaxDays = 365;

/** A day the server takes: after today and at most a year ahead. */
export const validHideDay = (value: string, now: Date = new Date()) => /^\d{4}-\d{2}-\d{2}$/.test(value) && value > dayIn(0, now) && value <= dayIn(hideMaxDays, now);

/** Hides the alert in Parasoll until the day (M40); the alert's ETag is the one the person read. Answers with the alert as it is now. */
export const hideAlert = (alert: Pick<Alert, 'id'>, etag: string, until: string, reason: string) =>
  api.post<Alert>(`/api/v1/service/alerts/${encodeURIComponent(alert.id)}/hide`, { until, reason }, etag);

/** Shows a hidden alert again: it is read first, so the change goes with the ETag of the alert as it is now. */
export async function showAlert(alert: Pick<Alert, 'id'>) {
  const current = await api.get<Alert>(`/api/v1/service/alerts/${encodeURIComponent(alert.id)}`);
  return api.post<Alert>(`/api/v1/service/alerts/${encodeURIComponent(alert.id)}/show`, {}, current.data.etag ?? null);
}
