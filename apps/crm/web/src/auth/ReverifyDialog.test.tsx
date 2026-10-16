import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FluentProvider } from '@fluentui/react-components';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { REVERIFY_EVENT } from '../api/client';
import { lightTheme } from '../app/theme';
import { useUnsavedChanges } from '../shared/forms/useUnsavedChanges';
import { ReverifyDialog } from './ReverifyDialog';

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

function renderDialog() {
  return render(
    <FluentProvider theme={lightTheme}>
      <ReverifyDialog />
    </FluentProvider>,
  );
}

const refuse = () =>
  act(
    () =>
      void window.dispatchEvent(
        new CustomEvent(REVERIFY_EVENT, {
          detail: { url: '/bff/login?reverify=1' },
        }),
      ),
  );

describe('Confirm your identity (F-G2-08)', () => {
  it('opens when a privileged action is refused and sends the person to Entra and back to this page', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', {
      ...window.location,
      pathname: '/billing/runs/r1',
      search: '?tab=bases',
      hash: '',
      assign,
    });
    const user = userEvent.setup();
    renderDialog();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    refuse();

    expect(
      await screen.findByRole('alertdialog', {
        name: 'Confirm your identity to continue',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/not saved/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm identity' }));
    expect(assign).toHaveBeenCalledWith('/bff/login?reverify=1&returnUrl=%2Fbilling%2Fruns%2Fr1%3Ftab%3Dbases');
  });

  it('can be dismissed without leaving the page', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const user = userEvent.setup();
    renderDialog();
    refuse();

    await user.click(await screen.findByRole('button', { name: 'Not now' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('warns that a form with unsaved changes is lost by the reload, and lets the person stay and save first', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', {
      ...window.location,
      pathname: '/contracts/c1/edit',
      search: '',
      hash: '',
      assign,
    });
    const user = userEvent.setup();
    // A dirty form somewhere on the page, under a router as the real forms are.
    const router = createMemoryRouter([{ path: '*', element: <Probe /> }]);
    function Probe() {
      useUnsavedChanges(true);
      return <ReverifyDialog />;
    }
    render(
      <FluentProvider theme={lightTheme}>
        <RouterProvider router={router} />
      </FluentProvider>,
    );
    refuse();

    expect(await screen.findByText(/changes that are not saved/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stay and save first' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();

    refuse();
    await user.click(await screen.findByRole('button', { name: 'Continue and lose changes' }));
    expect(assign).toHaveBeenCalledWith('/bff/login?reverify=1&returnUrl=%2Fcontracts%2Fc1%2Fedit');
  });

  it('tells the person when the sign-in came back unaccepted, offers another try, and cleans the address', async () => {
    window.history.replaceState(null, '', '/billing/runs?tab=bases&reverify=failed');
    const user = userEvent.setup();
    renderDialog();

    expect(
      await screen.findByRole('alertdialog', {
        name: 'Your identity could not be confirmed',
      }),
    ).toBeInTheDocument();
    expect(window.location.search).toBe('?tab=bases');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});

describe('unsaved changes registry', () => {
  it('forgets a form once it is saved or gone', async () => {
    const { hasUnsavedChanges } = await import('../shared/forms/useUnsavedChanges');
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <RouterProvider router={createMemoryRouter([{ path: '*', element: <>{children}</> }])} />
    );
    const { result, unmount } = renderHook(() => useUnsavedChanges(true), {
      wrapper,
    });
    expect(hasUnsavedChanges()).toBe(true);
    act(() => result.current.markSaved());
    expect(hasUnsavedChanges()).toBe(false);
    unmount();
    expect(hasUnsavedChanges()).toBe(false);
  });
});
