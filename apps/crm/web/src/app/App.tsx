import { FluentProvider } from '@fluentui/react-components';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { AuthGate } from '../auth/AuthGate';
import { darkTheme, lightTheme } from './theme';
import { router } from './router';
import { queryClient } from './queryClient';
import { usePrefersDark } from './usePrefersDark';

export function App() {
  const dark = usePrefersDark();
  return (
    <FluentProvider theme={dark ? darkTheme : lightTheme}>
      <QueryClientProvider client={queryClient}>
        <AuthGate>
          <RouterProvider router={router} />
        </AuthGate>
      </QueryClientProvider>
    </FluentProvider>
  );
}
