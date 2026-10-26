/** A due moment `days` from today at 16:00, the end of the working day, as a datetime-local value in the browser's zone. */
export function dueIn(days: number, now: Date = new Date()): string {
  const due = new Date(now); due.setDate(due.getDate() + days); due.setHours(16, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}T16:00`;
}

/** The quick due dates of the assign dialog, in the order they are offered. */
export const dueShortcuts = [['today', 0], ['tomorrow', 1], ['inThreeDays', 3]] as const;

/** A datetime-local value that a browser can read, as the ISO time the API takes; null for none or an unreadable value. */
export function dueIso(value: string): string | null {
  if (value === '') return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
