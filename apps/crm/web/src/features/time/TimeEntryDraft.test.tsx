import { afterEach, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { auxiliary, json } from '../activities/taskTicketTestFixture';
import { TimeEntryDialogHost } from './TimeEntryDialog';

afterEach(() => vi.unstubAllGlobals());

function render() {
  const onClose = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => auxiliary(url) ?? json({ items: [], nextCursor: null, totalCount: 0 })));
  renderRoutes([page(<TimeEntryDialogHost open defaultDate="2026-10-17" onClose={onClose} />)], '/', testUser(['time.own']));
  return onClose;
}

it('closes an untouched form at once on Escape', async () => {
  const onClose = render(); await screen.findByRole('dialog', { name: 'Register hours' });
  await userEvent.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog', { name: 'Discard this entry?' })).not.toBeInTheDocument();
});

it('asks before Escape throws away what the person typed, and keeps the draft on "Keep editing"', async () => {
  const onClose = render(); const form = within(await screen.findByRole('dialog', { name: 'Register hours' }));
  await userEvent.type(form.getByRole('textbox', { name: 'Description' }), 'Synthetic unsaved notes');
  await userEvent.keyboard('{Escape}');
  const ask = within(await screen.findByRole('dialog', { name: 'Discard this entry?' }));
  expect(ask.getByText('What you typed has not been saved.')).toBeVisible();
  await userEvent.click(ask.getByRole('button', { name: 'Keep editing' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Discard this entry?' })).not.toBeInTheDocument());
  // The form stays open with the draft (jsdom does not hand the accessibility tree back to it; a browser test checks that).
  expect(document.querySelector('textarea')).toHaveValue('Synthetic unsaved notes'); expect(onClose).not.toHaveBeenCalled();
});

it('closes after "Discard"', async () => {
  const onClose = render(); const form = within(await screen.findByRole('dialog', { name: 'Register hours' }));
  await userEvent.clear(form.getByRole('textbox', { name: 'Hours' })); await userEvent.type(form.getByRole('textbox', { name: 'Hours' }), '2');
  await userEvent.keyboard('{Escape}');
  await userEvent.click(within(await screen.findByRole('dialog', { name: 'Discard this entry?' })).getByRole('button', { name: 'Discard' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});
