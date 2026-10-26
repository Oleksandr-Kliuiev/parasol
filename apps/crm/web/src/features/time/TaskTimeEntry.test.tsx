import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { association, auxiliary, json, renderTaskTicket, task, ticket } from '../activities/taskTicketTestFixture';

afterEach(() => vi.unstubAllGlobals());
const openTime = async () => {
  await userEvent.click(await screen.findByRole('button', { name: /^Service ticket for/ }));
  await userEvent.click(await screen.findByRole('button', { name: 'Register hours' }));
  await screen.findByRole('dialog', { name: 'Register hours' });
};
const fillTime = (hours = '0.75', description = 'Synthetic own work notes') => {
  fireEvent.change(screen.getByRole('textbox', { name: 'Hours' }), { target: { value: hours } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), { target: { value: description } });
};

it('prefills only customer and saved ticket; requires explicit hours/notes and registers exactly once as the current employee', async () => {
  let finish!: (value: Response) => void;
  const fetch = vi.fn(async (url: string, init: RequestInit) => init.method === 'POST' ? new Promise<Response>(resolve => { finish = resolve; })
    : auxiliary(url) ?? json(association(ticket)));
  vi.stubGlobal('fetch', fetch); renderTaskTicket(); await openTime();
  expect(screen.getByRole('textbox', { name: 'Organization' })).toHaveValue('Synthetic customer');
  expect(screen.getByRole('textbox', { name: 'Organization' })).toHaveAttribute('readonly');
  expect(screen.getByRole('textbox', { name: 'Ticket' })).toHaveValue('#701 · Synthetic saved ticket');
  expect(screen.getByRole('textbox', { name: 'Ticket' })).toHaveAttribute('readonly');
  expect(screen.getByRole('textbox', { name: 'Hours' })).toHaveValue(''); expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('');
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Hours' })).toHaveFocus());
  expect(screen.getByLabelText(/^Date/)).not.toHaveValue(task.dueAt!.slice(0, 10));
  expect(screen.getByRole('button', { name: 'Register hours' })).toBeDisabled(); fillTime('0.75', ''); expect(screen.getByRole('button', { name: 'Register hours' })).toBeDisabled();
  fillTime(); const submit = screen.getByRole('button', { name: 'Register hours' }); act(() => { fireEvent.click(submit); fireEvent.click(submit); });
  await waitFor(() => expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1));
  const [, init] = fetch.mock.calls.find(([, init]) => init.method === 'POST')!;
  expect(JSON.parse(init.body as string)).toMatchObject({ organizationId: task.organizationId, technicianId: null,
    ticketId: ticket.id, sourceActivityId: task.id, externalTicketId: ticket.externalId, ticketTitle: ticket.title,
    hours: 0.75, description: 'Synthetic own work notes', projectId: null });
  expect(JSON.parse(init.body as string).clientRequestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(screen.getByRole('textbox', { name: 'Hours' })).toBeDisabled(); await act(async () => finish(json({ id: 'time-created' }, 201)));
  expect(await screen.findByText('Hours registered')).toBeVisible(); expect(await screen.findByRole('dialog', { name: 'Task service ticket' })).toBeVisible();
});

it('reuses the same durable create key after an unconfirmed answer, including when the draft is reviewed', async () => {
  const fetch = vi.fn(async (url: string, init: RequestInit) => init.method === 'POST' ? json({ title: 'Synthetic unconfirmed save' }, 503)
    : auxiliary(url) ?? json(association(ticket)));
  vi.stubGlobal('fetch', fetch); renderTaskTicket(); await openTime(); fillTime(); await userEvent.click(screen.getByRole('button', { name: 'Register hours' }));
  await screen.findByText('Synthetic unconfirmed save'); await userEvent.click(screen.getByRole('button', { name: 'Register hours' }));
  await waitFor(() => expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(2));
  const payloads = () => fetch.mock.calls.filter(([, init]) => init.method === 'POST').map(([, init]) => JSON.parse(init.body as string));
  expect(payloads()[0]).toEqual(payloads()[1]); fillTime('1', 'Synthetic reviewed notes'); await userEvent.click(screen.getByRole('button', { name: 'Register hours' }));
  await waitFor(() => expect(payloads()).toHaveLength(3)); expect(payloads()[2].clientRequestId).toBe(payloads()[0].clientRequestId);
  expect(payloads()[2]).toMatchObject({ hours: 1, description: 'Synthetic reviewed notes' });
});

it('uses a new durable create key for a newly opened form', async () => {
  const fetch = vi.fn(async (url: string, init: RequestInit) => init.method === 'POST' ? json({ title: 'Synthetic unconfirmed save' }, 503)
    : auxiliary(url) ?? json(association(ticket)));
  vi.stubGlobal('fetch', fetch); renderTaskTicket(); await openTime(); fillTime(); await userEvent.click(screen.getByRole('button', { name: 'Register hours' }));
  await screen.findByText('Synthetic unconfirmed save'); await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Register hours' })); await screen.findByRole('dialog', { name: 'Register hours' });
  fillTime(); await userEvent.click(screen.getByRole('button', { name: 'Register hours' }));
  await waitFor(() => expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(2));
  const payloads = fetch.mock.calls.filter(([, init]) => init.method === 'POST').map(([, init]) => JSON.parse(init.body as string));
  expect(payloads[0].clientRequestId).not.toBe(payloads[1].clientRequestId);
});

it.each(['Change customer', 'Change employee', 'Change task', 'Drop write and time', 'Drop Service'])('ignores an old time POST after %s without closing or changing a new form', async change => {
  let finish!: (value: Response) => void;
  const fetch = vi.fn(async (url: string, init: RequestInit) => init.method === 'POST' ? new Promise<Response>(resolve => { finish = resolve; })
    : auxiliary(url) ?? json(association(ticket)));
  vi.stubGlobal('fetch', fetch); renderTaskTicket(); await openTime(); fillTime(); await userEvent.click(screen.getByRole('button', { name: 'Register hours' }));
  fireEvent.click(screen.getByText(change));
  if (!['Drop write and time', 'Drop Service'].includes(change)) {
    await userEvent.click(await screen.findByRole('button', { name: 'Register hours' })); await screen.findByRole('dialog', { name: 'Register hours' });
    fillTime('1.25', 'Synthetic replacement draft');
  }
  const reads = fetch.mock.calls.filter(([, init]) => init.method === 'GET').length;
  await act(async () => finish(json({ id: 'old-time-created' }, 201)));
  expect(fetch.mock.calls.filter(([, init]) => init.method === 'GET')).toHaveLength(reads); expect(screen.queryByText('Hours registered')).not.toBeInTheDocument();
  if (!['Drop write and time', 'Drop Service'].includes(change)) {
    expect(screen.getByRole('dialog', { name: 'Register hours' })).toBeVisible(); expect(screen.getByRole('textbox', { name: 'Hours' })).toHaveValue('1.25');
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Synthetic replacement draft');
  }
});

it('shows a useful unavailable-origin failure and preserves entered hours and notes without retrying', async () => {
  const fetch = vi.fn(async (url: string, init: RequestInit) => init.method === 'POST' ? json({ code: 'ACT_TASK_UNAVAILABLE' }, 404)
    : auxiliary(url) ?? json(association(ticket)));
  vi.stubGlobal('fetch', fetch); renderTaskTicket(); await openTime(); fillTime(); await userEvent.click(screen.getByRole('button', { name: 'Register hours' }));
  expect(await screen.findByText('This task is no longer available for this customer. Close this view and refresh the customer activities.')).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Hours' })).toHaveValue('0.75'); expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Synthetic own work notes');
  expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
});

it('permits time.manage as an alternative to time.own without inheriting the task assignee', async () => {
  const fetch = vi.fn(async (url: string) => auxiliary(url) ?? json(association(ticket)));
  vi.stubGlobal('fetch', fetch); renderTaskTicket(['activities.read', 'service.read', 'time.manage']); await openTime();
  expect(screen.getByText('Hours belong to you. Enter the time spent and your notes.')).toBeVisible();
  expect(screen.queryByText('Synthetic other employee')).not.toBeInTheDocument();
});
