import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, renderHook, screen, waitFor } from '@testing-library/react';
import type { SearchResponse } from '../api/types';
import { renderRoutes } from '../test/renderWithProviders';
import { GlobalSearch } from './GlobalSearch';
import { useSearchTypeAhead } from './searchTypeAhead';

const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(window, { key, ...init });

afterEach(() => vi.unstubAllGlobals());

describe('useSearchTypeAhead', () => {
  it('keeps the keys typed while the palette loads and hands them to its field once', () => {
    const { result } = renderHook(() => useSearchTypeAhead(vi.fn()));
    press('a');
    result.current.start();
    for (const key of ['s', 'o', 'l', 'x', 'Backspace', ' ', 'v']) press(key);
    press('Shift');
    press('c', { ctrlKey: true });

    expect(result.current.take()).toBe('sol v');
    press('q');
    expect(result.current.take()).toBe('');
  });

  it('does not collect while the field is there, and collects again after it is gone', () => {
    const { result } = renderHook(() => useSearchTypeAhead(vi.fn()));
    result.current.start();
    result.current.take();
    result.current.start();
    press('x');
    expect(result.current.take()).toBe('');

    result.current.release();
    result.current.start();
    press('y');
    expect(result.current.take()).toBe('y');
  });

  it('cancels the opening on Escape and stops collecting on a click', () => {
    const setOpen = vi.fn();
    const { result } = renderHook(() => useSearchTypeAhead(setOpen));
    result.current.start();
    press('a');
    press('Escape');
    expect(setOpen).toHaveBeenCalledWith(false);
    press('b');
    expect(result.current.take()).toBe('');

    result.current.release();
    result.current.start();
    press('c');
    fireEvent.pointerDown(window);
    expect(fireEvent.keyDown(window, { key: 'd' })).toBe(true);
    expect(result.current.take()).toBe('');
  });

  it('lets keys reach the page while nothing is opening', () => {
    renderHook(() => useSearchTypeAhead(vi.fn()));
    expect(fireEvent.keyDown(window, { key: 'a' })).toBe(true);
  });
});

describe('GlobalSearch in the palette', () => {
  it('shows what was typed before its field had focus and searches for it', async () => {
    const response: SearchResponse = { query: 'solveig', groups: [{ group: 'contacts', items: [{ id: 'c1', title: 'Solveig Berg', subtitle: 'Kystlys AS', url: '/contacts/c1' }] }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 })));
    const release = vi.fn();
    const take = vi.fn().mockReturnValueOnce('solveig').mockReturnValue('');
    const { unmount } = renderRoutes([{ path: '*', element: <GlobalSearch inline typeAhead={{ take, release }} /> }], '/');

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Search organizations' })).toHaveValue('solveig'));
    expect(await screen.findByRole('option', { name: /Solveig Berg/ })).toBeInTheDocument();
    unmount();
    expect(release).toHaveBeenCalled();
  });
});
