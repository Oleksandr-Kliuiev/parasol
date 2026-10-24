import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RegistryOrganization } from '../../api/types';
import { holdSearch } from '../../test/heldSearch';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { RegistryLookup } from './RegistryLookup';

afterEach(() => vi.unstubAllGlobals());

const entity = (orgNumber: string, name: string): RegistryOrganization => ({
  orgNumber, name, legalForm: 'AS', legalFormDescription: 'Aksjeselskap', naceCode: null, naceDescription: null, website: null, email: null,
  phone: null, businessAddress: null, postalAddress: null, status: 'Active',
});

describe('registry lookup', () => {
  // The search is read after a pause in typing; a click on an entry must not get lost while its answer is on the way (M42 e2e).
  it('keeps the entries in place while another search is read, so Use still takes the click, and shows none under two letters', async () => {
    const { fetch, requested, answer } = holdSearch((url) => url.includes('name=Fjord+IT'),
      () => new Response(JSON.stringify([entity('923609016', 'FJORD IT AS'), entity('974760673', 'FJORDKRAFT AS')]), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const onSelect = vi.fn();
    renderRoutes([page(<RegistryLookup onSelect={onSelect} />)], '/', testUser(['customers.write']));
    const search = screen.getByRole('textbox', { name: 'Name or organization number' });
    fireEvent.change(search, { target: { value: 'Fjord' } });
    const item = (await screen.findByText('FJORD IT AS')).closest('li')!;

    fireEvent.change(search, { target: { value: 'Fjord IT' } });
    await requested();
    // The same entry with its button, not an emptied list that moves the form below; it is not the new answer, so the list is busy.
    expect(screen.getByText('FJORD IT AS').closest('li')).toBe(item);
    expect(item.closest('ul')).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(within(item).getByRole('button', { name: 'Use' }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ orgNumber: '923609016' }));

    await answer([entity('923609016', 'FJORD IT AS')]);
    await waitFor(() => expect(screen.queryByText('FJORDKRAFT AS')).not.toBeInTheDocument());
    // Under two letters nothing is searched, and the entries of the earlier search do not stay.
    fireEvent.change(search, { target: { value: 'F' } });
    await waitFor(() => expect(screen.queryByText('FJORD IT AS')).not.toBeInTheDocument());
  }, 15_000);
});
