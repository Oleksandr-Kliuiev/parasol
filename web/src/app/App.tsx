import { useEffect, useState } from 'react';
import { FluentProvider } from '@fluentui/react-components';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { AuthGate } from '../auth/AuthGate';
import { darkTheme, lightTheme } from './theme';
import { router } from './router';
import { queryClient } from './queryClient';

function usePrefersDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setDark(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return dark;
}

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
