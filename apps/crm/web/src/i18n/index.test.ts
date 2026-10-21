import { afterEach, describe, expect, it } from 'vitest';
import i18n, { changeLanguage } from './index';

afterEach(async () => { await changeLanguage('en'); });

describe('the language announced by the document', () => {
  it('matches the loaded bootstrap language before the application renders', () => {
    expect(i18n.t('connectionStatus.title')).toBe('Connection status');
    expect(document.documentElement.lang).toBe('en');
  });

  it.each([
    ['nb', 'Tilkoblingsstatus'],
    ['en', 'Connection status'],
    ['nn', 'Tilkoplingsstatus'],
  ] as const)('follows the effective %s translations after a language change', async (code, title) => {
    await changeLanguage(code);
    expect(i18n.t('connectionStatus.title')).toBe(title);
    expect(i18n.t('nav.organizations')).toBe({ nb: 'Organisasjoner', nn: 'Organisasjonar', en: 'Organizations' }[code]);
    expect(document.documentElement.lang).toBe(code);
  });
});
