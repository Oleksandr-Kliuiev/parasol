import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

export const languages = [
  { code: 'nb', label: 'Norsk bokmål', locale: 'nb-NO' },
  { code: 'nn', label: 'Norsk nynorsk', locale: 'nn-NO' },
  { code: 'en', label: 'English', locale: 'en-GB' },
] as const;

export type LanguageCode = (typeof languages)[number]['code'];

// One language is downloaded at a time; the others are fetched when the user switches (keeps the first load small).
const loaders: Record<LanguageCode, () => Promise<{ default: Record<string, unknown> }>> = {
  nb: () => import('./locales/nb.json'),
  nn: () => import('./locales/nn.json'),
  en: () => import('./locales/en.json'),
};

export function detectLanguage(preferred?: string | null): LanguageCode {
  const candidates = [preferred, ...navigator.languages.map((l) => l.slice(0, 2))];
  for (const candidate of candidates) {
    const normalized = candidate === 'no' ? 'nb' : candidate;
    const match = languages.find((l) => l.code === normalized);
    if (match) return match.code;
  }
  return 'nb';
}

export function localeOf(language: string): string {
  return languages.find((l) => l.code === language)?.locale ?? 'nb-NO';
}

const loaded = new Set<LanguageCode>();

async function loadResources(code: LanguageCode): Promise<void> {
  if (loaded.has(code)) return;
  const module = await loaders[code]();
  i18n.addResourceBundle(code, 'translation', module.default, true, true);
  loaded.add(code);
}

/** Loads the language's texts and switches to it. */
export async function changeLanguage(code: LanguageCode): Promise<void> {
  await loadResources(code);
  await i18n.changeLanguage(code);
  document.documentElement.lang = code;
}

export async function initI18n(preferred?: string | null): Promise<void> {
  const language = detectLanguage(preferred);
  // i18next only accepts resource bundles once it is initialized, so it starts empty and the texts follow immediately.
  await i18n.use(initReactI18next).init({
    lng: language,
    resources: {},
    // Keys are identical in every language (a test checks it), so a missing file never falls back to another language.
    fallbackLng: false,
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  await loadResources(language);
  document.documentElement.lang = language;
}

export default i18n;
