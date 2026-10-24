import { afterEach, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import { page, renderRoutes } from '../../test/renderWithProviders';
import { AppLink } from './AppLink';
import { ConfirmDialog } from './ConfirmDialog';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(500); });

it('puts the first focus on the way out even when the body starts with a link', async () => {
  vi.useFakeTimers();
  const view = renderRoutes([page(
    <ConfirmDialog open title="Close October 2026?" confirm="Close October 2026" blocked onConfirm={vi.fn()} onCancel={vi.fn()}>
      6 entries still wait for approval. <AppLink to="/time/entries">Show waiting entries</AppLink>
    </ConfirmDialog>,
  )], '/');
  await settle();
  // Fluent alone would focus the link: Enter would then leave the page, and a link at the end of a long line scrolls the body.
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Close October 2026' })).toBeDisabled();
  view.unmount(); await settle();
});
