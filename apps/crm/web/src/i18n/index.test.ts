import { afterEach, describe, expect, it } from 'vitest';
import i18n, { changeLanguage } from './index';

afterEach(async () => { await changeLanguage('en'); });

describe('the language announced by the document', () => {
  it('matches the loaded bootstrap language before the application renders', () => {
    expect(i18n.t('parasolQueue.title')).toBe('Observation queue and history');
    expect(document.documentElement.lang).toBe('en');
  });

  it.each([
    ['nb', 'Observasjonskø og historikk'],
    ['en', 'Observation queue and history'],
    ['ru', 'Очередь наблюдений и история'],
  ] as const)('follows the effective %s translations after a language change', async (code, title) => {
    await changeLanguage(code);
    expect(i18n.t('parasolQueue.title')).toBe(title);
    expect(document.documentElement.lang).toBe(code);
  });
});
