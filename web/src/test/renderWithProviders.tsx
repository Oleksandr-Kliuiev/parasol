import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { FluentProvider } from '@fluentui/react-components';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import type { CurrentUser } from '../api/types';
import { CurrentUserContext } from '../auth/CurrentUserContext';
import { lightTheme } from '../app/theme';

export function testUser(permissions: string[]): CurrentUser {
  return { id: 'u1', displayName: 'Kari Nordmann', email: null, preferredLanguage: 'en', roles: ['Crm.Test'], permissions, authMode: 'Development' };
}

/** Renders routes inside the app providers; returns the router to assert navigation. */
export function renderRoutes(routes: RouteObject[], initialPath: string, user: CurrentUser = testUser(['customers.read'])) {
  const router = createMemoryRouter(routes, { initialEntries: [initialPath] });
  const view = render(
    <FluentProvider theme={lightTheme}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CurrentUserContext.Provider value={user}>
          <RouterProvider router={router} />
        </CurrentUserContext.Provider>
      </QueryClientProvider>
    </FluentProvider>,
  );
  return { router, ...view };
}

export function page(element: ReactElement, path = '*'): RouteObject {
  return { path, element };
}
