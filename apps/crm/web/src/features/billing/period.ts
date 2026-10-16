/** "September 2026" in the user's language, from an ISO date. */
export function monthLabel(isoDate: string, language: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return isoDate;
  const formatted = new Intl.DateTimeFormat(language, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}
