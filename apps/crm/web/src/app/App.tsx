import { FluentProvider } from '@fluentui/react-components';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { AuthGate } from '../auth/AuthGate';
import { darkTheme, lightTheme } from './theme';
import { hearthStyleHooks } from './hearthStyles';
import { router } from './router';
import { queryClient } from './queryClient';
import { ThemeModeProvider } from './themeMode';
import { useThemeMode } from './themeModeContext';

function ThemedApp() {
  const { dark } = useThemeMode();
  return (
    <FluentProvider theme={dark ? darkTheme : lightTheme} customStyleHooks_unstable={hearthStyleHooks}>
      <QueryClientProvider client={queryClient}>
        <AuthGate>
          <RouterProvider router={router} />
        </AuthGate>
      </QueryClientProvider>
    </FluentProvider>
  );
}

export function App() {
  return (
    <ThemeModeProvider>
      <ThemedApp />
    </ThemeModeProvider>
  );
}
