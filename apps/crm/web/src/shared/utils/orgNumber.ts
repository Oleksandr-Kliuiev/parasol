const WEIGHTS = [3, 2, 7, 6, 5, 4, 3, 2];

/** Norwegian organisasjonsnummer: 9 digits with a MOD11 check digit (same rule as the API). */
export function isValidOrgNumber(value: string | null | undefined): boolean {
  if (!value) return false;
  const digits = value.replace(/\s/g, '');
  if (!/^\d{9}$/.test(digits)) return false;
  const sum = WEIGHTS.reduce((acc, weight, i) => acc + Number(digits[i]) * weight, 0);
  let check = 11 - (sum % 11);
  if (check === 11) check = 0;
  return check !== 10 && check === Number(digits[8]);
}

export function normalizeOrgNumber(value: string): string {
  return value.replace(/\s/g, '');
}

/** "923609016" → "923 609 016", the conventional Norwegian grouping. */
export function formatOrgNumber(value: string | null | undefined): string {
  if (!value) return '';
  const digits = normalizeOrgNumber(value);
  return /^\d{9}$/.test(digits) ? `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}` : value;
}

export function looksLikeOrgNumber(value: string): boolean {
  return /^[\d\s]{9,11}$/.test(value.trim()) && normalizeOrgNumber(value).length === 9;
}
