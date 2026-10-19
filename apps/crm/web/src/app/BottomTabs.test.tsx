import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoutes, testUser } from '../test/renderWithProviders';
import { BottomTabs } from './BottomTabs';

describe('BottomTabs', () => {
  it('shows day, customers and time for someone who can open them, and marks the current one', () => {
    renderRoutes([{ path: '*', element: <BottomTabs selected="organizations" moreOpen={false} onMore={() => {}} /> }], '/', testUser(['time.own']));

    const nav = screen.getByRole('navigation', { name: 'Main sections' });
    expect(Array.from(nav.querySelectorAll('a, button')).map((el) => el.textContent)).toEqual(['My day', 'Customers', 'Time', 'More']);
    expect(screen.getByRole('link', { name: 'Customers' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'My day' })).not.toHaveAttribute('aria-current');
  });

  it('leaves out the time tab without a time right and opens the full menu from More', async () => {
    const onMore = vi.fn();
    renderRoutes([{ path: '*', element: <BottomTabs selected="my-day" moreOpen={false} onMore={onMore} /> }], '/', testUser(['customers.read']));

    expect(screen.queryByRole('link', { name: 'Time' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'More' }));
    expect(onMore).toHaveBeenCalledOnce();
  });
});
