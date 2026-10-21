import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePrefersDark } from './usePrefersDark';
import { ThemeModeContext, type ThemeMode, type ThemeModeValue } from './themeModeContext';

const STORAGE_KEY = 'parasoll-theme';

function readStored(): ThemeMode {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

/**
 * The colour scheme follows the system until the person picks one in the top bar; the choice is a per-browser
 * convenience (localStorage), not a profile setting. `data-theme` on <html> switches the CSS tones in styles.css.
 */
export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const prefersDark = usePrefersDark();
  const [mode, setModeState] = useState<ThemeMode>(readStored);
  const dark = mode === 'system' ? prefersDark : mode === 'dark';

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);

  const value = useMemo<ThemeModeValue>(
    () => ({
      mode,
      dark,
      setMode: (next) => {
        setModeState(next);
        try {
          if (next === 'system') window.localStorage.removeItem(STORAGE_KEY);
          else window.localStorage.setItem(STORAGE_KEY, next);
        } catch {
          // Private windows may refuse storage; the choice then lasts for this page only.
        }
      },
    }),
    [mode, dark],
  );
  return <ThemeModeContext.Provider value={value}>{children}</ThemeModeContext.Provider>;
}
