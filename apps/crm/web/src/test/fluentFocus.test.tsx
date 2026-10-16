import { useState } from 'react';
import { Dialog, DialogBody, DialogContent, DialogSurface, DialogTitle } from '@fluentui/react-components';
import { createTabster, disposeTabster } from 'tabster';
import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { page, renderRoutes } from './renderWithProviders';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const settleModalizer = () => act(async () => { await vi.advanceTimersByTimeAsync(500); });

it('uses real Fluent focus and modal hiding through its timer, excluding hidden and disabled controls and restoring the background on close', async () => {
  vi.useFakeTimers();
  function Host() {
    const [open, setOpen] = useState(true);
    return <><button>Background control</button><Dialog open={open} onOpenChange={(_, data) => setOpen(data.open)}>
      <DialogSurface><DialogBody><DialogTitle>Synthetic modal</DialogTitle><DialogContent>
        <button hidden>Hidden control</button>
        <div style={{ display: 'none' }}><button>Display none ancestor control</button></div>
        <div style={{ visibility: 'hidden' }}><button>Invisible ancestor control</button></div>
        <div aria-hidden="true"><button>Aria hidden ancestor control</button></div>
        <button disabled>Disabled control</button>
        <button onClick={() => setOpen(false)}>Continue synthetic work</button>
      </DialogContent></DialogBody></DialogSurface>
    </Dialog></>;
  }
  const view = renderRoutes([page(<Host />)], '/'); await settleModalizer();
  const dialog = screen.getByRole('dialog', { name: 'Synthetic modal' });
  expect(dialog).toBeVisible(); expect(dialog).not.toHaveAttribute('aria-hidden', 'true');
  const action = screen.getByRole('button', { name: 'Continue synthetic work' }); expect(action).toHaveFocus();
  for (const name of ['Hidden control', 'Display none ancestor control', 'Invisible ancestor control', 'Aria hidden ancestor control'])
    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Disabled control' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Background control' })).not.toBeInTheDocument();
  fireEvent.click(action); await settleModalizer();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Background control' })).toBeVisible();
  view.unmount(); await settleModalizer();
});

it('keeps the genuine no-focusable-content fallback instead of inventing a focusable control', async () => {
  vi.useFakeTimers();
  const view = renderRoutes([page(<Dialog open modalType="non-modal"><DialogSurface><DialogBody>
    <DialogTitle action={null}>Synthetic empty dialog</DialogTitle><DialogContent>Read-only text without controls.</DialogContent>
  </DialogBody></DialogSurface></Dialog>)], '/'); await settleModalizer();
  expect(screen.getByRole('dialog', { name: 'Synthetic empty dialog' })).toHaveFocus();
  expect(screen.queryByRole('button')).not.toBeInTheDocument(); view.unmount(); await settleModalizer();
});

it.each(['body', 'html'])('leaves a hidden %s document ineligible to the real Tabster focus API', tag => {
  const element = tag === 'body' ? document.body : document.documentElement;
  const original = element.style.display; const control = document.createElement('button'); control.textContent = 'Synthetic eligible control';
  document.body.append(control); const tabster = createTabster(window, { autoRoot: {} });
  try {
    expect(tabster.focusable.isFocusable(control)).toBe(true);
    element.style.display = 'none';
    expect(document.body.getBoundingClientRect().width).toBe(0);
    expect(tabster.focusable.isFocusable(control)).toBe(false);
    expect(screen.queryByRole('button', { name: 'Synthetic eligible control' })).not.toBeInTheDocument();
  } finally { element.style.display = original; control.remove(); disposeTabster(tabster); }
});
