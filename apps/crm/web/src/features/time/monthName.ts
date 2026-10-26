import { localeOf } from '../../i18n';

/** "October 2026" / "Oktober 2026" in the interface language: the name of a time period, capitalised as a title. */
export const monthName = (year: number, month: number, language: string) => {
  const name = new Intl.DateTimeFormat(localeOf(language), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 1)));
  return name.charAt(0).toLocaleUpperCase(localeOf(language)) + name.slice(1);
};
