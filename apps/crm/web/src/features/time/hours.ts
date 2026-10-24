import { parseDecimal } from '../../shared/utils/format';

/**
 * Hours as people type them: "1,5" or "1.5", "1:30" (hours and minutes), "45 min" or "45m", "2 h" or "2 t". Empty input
 * gives null and anything else NaN, so the field can say which forms it takes instead of only disabling Register.
 */
export function parseHours(text: string): number | null {
  const value = text.trim().toLowerCase();
  if (value === '') return null;
  const clock = /^(\d{1,2}):([0-5]\d)$/.exec(value);
  if (clock) return Number(clock[1]) + Number(clock[2]) / 60;
  const minutes = /^(\d{1,4})\s*(m|min|minutes?|minutt(?:er|ar)?)$/.exec(value);
  if (minutes) return Number(minutes[1]) / 60;
  const hours = /^([\d.,\s]+?)\s*(h|t|timer|timar|hours?)?$/.exec(value);
  return hours ? parseDecimal(hours[1]!) ?? Number.NaN : Number.NaN;
}

/** Whether the person typed minutes or a clock time, so the form can echo the hours that will be saved. */
export const typedAsMinutes = (text: string) => /:|m/i.test(text.trim());

/** Rounded to the minute, as the entry stores it (two decimals). */
export const roundHours = (hours: number) => Math.round(hours * 100) / 100;
