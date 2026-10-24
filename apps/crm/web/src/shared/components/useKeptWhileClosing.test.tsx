import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button, DialogActions, DialogBody, DialogSurface, DialogTitle } from '@fluentui/react-components';
import { page, renderRoutes } from '../../test/renderWithProviders';
import { Dialog } from './Dialog';
import { useKeptWhileClosing } from './useKeptWhileClosing';

describe('useKeptWhileClosing', () => {
  it('follows the value and keeps the last one after it is cleared', () => {
    const { result, rerender } = renderHook(({ value }) => useKeptWhileClosing(value), { initialProps: { value: null as string | null } });
    expect(result.current).toBeNull();
    rerender({ value: 'A' });
    expect(result.current).toBe('A');
    rerender({ value: null });
    expect(result.current).toBe('A');
    rerender({ value: 'B' });
    expect(result.current).toBe('B');
  });

  it('follows an unset value while the dialog is open', () => {
    // A dialog that creates a record after one that edited A must not show A again.
    const { result, rerender } = renderHook(({ value, open }) => useKeptWhileClosing(value, open), {
      initialProps: { value: 'A' as string | undefined, open: true },
    });
    rerender({ value: undefined, open: false });
    expect(result.current).toBe('A');
    rerender({ value: undefined, open: true });
    expect(result.current).toBeUndefined();
    rerender({ value: undefined, open: false });
    expect(result.current).toBeUndefined();
  });
});

describe('a dialog rendered from the kept value', () => {
  // jsdom has no Web Animations: every animation runs until the test finishes it, as the 220 ms exit would in a browser.
  const running: { finish: () => void }[] = [];
  beforeEach(() => {
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      value: () => {
        const animation = {
          playState: 'running', onfinish: null as (() => void) | null, oncancel: null as (() => void) | null,
          persist() {}, pause() {}, play() {}, reverse() {},
          cancel() { animation.playState = 'idle'; animation.oncancel?.(); },
          finish() { animation.playState = 'finished'; animation.onfinish?.(); },
        };
        running.push(animation);
        return animation;
      },
    });
  });
  afterEach(() => {
    running.length = 0;
    delete (Element.prototype as { animate?: unknown }).animate;
  });
  const finishMotion = () => act(async () => { running.splice(0).forEach((animation) => animation.finish()); });

  function Host() {
    const [record, setRecord] = useState<string | null>(null);
    const shown = useKeptWhileClosing(record);
    return <>
      <button onClick={() => setRecord('Synthetic record A')}>Open</button>
      <Dialog open={record !== null} onOpenChange={(_, data) => !data.open && setRecord(null)}>
        <DialogSurface>{shown && <DialogBody>
          <DialogTitle>{shown}</DialogTitle>
          <DialogActions><Button onClick={() => setRecord(null)}>Cancel</Button></DialogActions>
        </DialogBody>}</DialogSurface>
      </Dialog>
    </>;
  }

  it('keeps its content until the exit motion has finished', async () => {
    const user = userEvent.setup();
    renderRoutes([page(<Host />)], '/');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await finishMotion();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    // Leaving: the surface is still there, and so is what it showed.
    expect(screen.getByRole('dialog')).toHaveTextContent('Synthetic record A');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();

    await finishMotion();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
