import { createContext, useContext } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';

export interface ThemeModeValue {
  mode: ThemeMode;
  /** The scheme in effect: the chosen one, or the system's when the mode is "system". */
  dark: boolean;
  setMode: (mode: ThemeMode) => void;
}

export const ThemeModeContext = createContext<ThemeModeValue>({ mode: 'system', dark: false, setMode: () => {} });

export function useThemeMode() {
  return useContext(ThemeModeContext);
}
