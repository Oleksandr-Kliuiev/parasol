import { useRef, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { Button, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input } from '@fluentui/react-components';
import { page, renderRoutes } from '../../test/renderWithProviders';
import { trackUsedControls } from '../../app/usedControls';
import { ConfirmDialog } from './ConfirmDialog';
import { Dialog } from './Dialog';

// jsdom, like Firefox and Safari, sends no blur when the focused field is removed, so Fluent alone leaves focus on the
// page after Escape; Chromium's blur gets it back through Fluent (e2e/dialog-focus.spec.ts covers the three engines).
let stopTracking: () => void;
beforeEach(() => { vi.useFakeTimers(); stopTracking = trackUsedControls(); });
afterEach(() => { stopTracking(); vi.clearAllTimers(); vi.useRealTimers(); });
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(500); });

function NameDialog({ focusElsewhere = false }: { focusElsewhere?: boolean }) {
  const [open, setOpen] = useState(false);
  const elsewhere = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); if (focusElsewhere) elsewhere.current?.focus(); };
  return <>
    <Button ref={elsewhere}>Elsewhere</Button>
    <Button onClick={() => setOpen(true)}>Rename</Button>
    <Dialog open={open} onOpenChange={(_, data) => { if (!data.open) close(); }}>
      <DialogSurface><DialogBody>
        <DialogTitle>Synthetic rename</DialogTitle>
        <DialogContent><Field label="Name"><Input /></Field></DialogContent>
        <DialogActions><Button onClick={close}>Cancel</Button></DialogActions>
      </DialogBody></DialogSurface>
    </Dialog>
  </>;
}

async function openRename(focusFirst: boolean) {
  const rename = screen.getByRole('button', { name: 'Rename' });
  // Chromium and Firefox focus a clicked button, Safari does not.
  if (focusFirst) rename.focus();
  fireEvent.click(rename);
  await settle();
  expect(screen.getByLabelText('Name')).toHaveFocus();
  return rename;
}

it.each([['focused first', true], ['only clicked, as in Safari', false]])('gives focus back to the button after Escape from a field (%s)', async (_, focusFirst) => {
  const view = renderRoutes([page(<NameDialog />)], '/');
  await settle();
  const rename = await openRename(focusFirst);

  fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape' });
  await settle();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(rename).toHaveFocus();
  view.unmount(); await settle();
});

it('leaves focus to the app and the browser when the dialog closes another way or focus has moved on', async () => {
  const view = renderRoutes([page(<NameDialog focusElsewhere />)], '/');
  await settle();
  await openRename(true);
  fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape' });
  await settle();
  // The app put focus elsewhere on close: it stays there.
  expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus();
  view.unmount(); await settle();

  const again = renderRoutes([page(<NameDialog />)], '/');
  await settle();
  await openRename(true);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await settle();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  // Not Escape: as before, Fluent decides (in Chromium it gives focus back through the blur of the removed field).
  expect(document.body).toHaveFocus();
  again.unmount(); await settle();
});

it('gives focus back inside the dialog that is still open when a question over it is closed with Escape', async () => {
  function Host() {
    const [asking, setAsking] = useState(false);
    return <Dialog open>
      <DialogSurface><DialogBody>
        <DialogTitle>Synthetic form</DialogTitle>
        <DialogContent><Field label="Note"><Input /></Field><Button onClick={() => setAsking(true)}>Remove</Button></DialogContent>
      </DialogBody>
      <ConfirmDialog open={asking} title="Remove the note?" confirm="Remove" onConfirm={() => setAsking(false)} onCancel={() => setAsking(false)} />
      </DialogSurface>
    </Dialog>;
  }
  const view = renderRoutes([page(<Host />)], '/');
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  await settle();
  const question = screen.getByRole('dialog', { name: 'Remove the note?' });
  fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
  await settle();
  expect(question).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Remove' })).toHaveFocus();
  view.unmount(); await settle();
});
