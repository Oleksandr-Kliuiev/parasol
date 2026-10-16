import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import en from '../../i18n/locales/en.json';
import { anomalyText } from './anomalyText';

// A minimal interpolating stand-in for i18next, enough to see which text a code resolves to.
const t = ((key: string, args?: Record<string, string>) => {
  const text = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], en) as string;
  return text.replace(/{{(\w+)}}/g, (_, name: string) => args?.[name] ?? '');
}) as unknown as TFunction;

describe('anomalyText (DEV-19)', () => {
  it('renders the new quantity anomalies from their values', () => {
    expect(anomalyText(t, { code: 'BIL_STALE_QUANTITY', message: 'x', args: { product: 'Atera', date: '01.10.2026' } })).toBe(
      'Atera: the quantity comes from a reading of 01.10.2026, which is older than the limit.',
    );
    expect(anomalyText(t, { code: 'BIL_INCOMPLETE_HOURS', message: 'x', args: { date: '02.10.2026 08:00' } })).toContain('02.10.2026 08:00');
  });

  it('keeps the subsidiary prefix of a group basis', () => {
    expect(anomalyText(t, { code: 'BIL_NO_DEVICE_SNAPSHOT', message: 'x', args: { product: 'Atera', subsidiary: 'Datter AS' } })).toMatch(/^Datter AS: Atera is billed per device/);
  });

  it('shows the server message for any other code', () => {
    expect(anomalyText(t, { code: 'BIL_NO_SUBSCRIPTION', message: 'No subscription.' })).toBe('No subscription.');
  });
});
