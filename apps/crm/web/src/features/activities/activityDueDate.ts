export interface ActivityDueDraft {
  original: string | null;
  input: string;
}

/** datetime-local displays the browser's wall time, while the API stores an instant. */
export function activityDueDraft(original: string | null | undefined): ActivityDueDraft {
  if (!original) return { original: null, input: '' };
  const date = new Date(original);
  const pad = (value: number) => String(value).padStart(2, '0');
  return { original, input: `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}` };
}

export function activityDueValue(input: string, initial: ActivityDueDraft): string | null {
  // The control cannot represent the original seconds, offset or repeated DST hour.
  // Preserve that exact instant whenever the displayed value has not changed.
  if (input === initial.input) return initial.original;
  if (!input) return null;
  const date = new Date(input);
  if (!Number.isFinite(date.valueOf())) throw new RangeError('Invalid local due date.');
  if (activityDueDraft(date.toISOString()).input !== input) throw new RangeError('Local due date was normalized.');
  return date.toISOString();
}
