import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { Button, DialogBody, DialogContent, DialogSurface, DialogTitle, DialogTrigger, Field, Input } from '@fluentui/react-components';
import { Dialog } from '../shared/components/Dialog';
import { page, renderRoutes } from '../test/renderWithProviders';
import { restoreMissingFocusin } from './focusin';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  document.body.replaceChildren();
  vi.useRealTimers();
});

/** Safari's behaviour: a date, time or datetime-local field takes focus with a focus event and no focusin. */
function likeSafari() {
  const swallow = (event: FocusEvent) => {
    if (event.isTrusted && event.target instanceof Element && event.target.matches('input[type=date], input[type=time], input[type=datetime-local]')) {
      event.stopImmediatePropagation();
    }
  };
  window.addEventListener('focusin', swallow, true);
  cleanups.push(() => window.removeEventListener('focusin', swallow, true));
}

function restoring() {
  cleanups.push(restoreMissingFocusin());
}

/** Every focusin the page hears, as "element <- element that had focus" ("-" for none; jsdom may name the body). */
function focusins() {
  const heard: string[] = [];
  const label = (target: EventTarget | null) => (target instanceof HTMLElement && target !== document.body ? target.dataset.name ?? target.tagName : '-');
  const listen = (event: FocusEvent) => heard.push(`${label(event.target)} <- ${label(event.relatedTarget)}`);
  document.addEventListener('focusin', listen);
  cleanups.push(() => document.removeEventListener('focusin', listen));
  return heard;
}

function control(name: string, type?: string) {
  const element = document.createElement(type ? 'input' : 'button');
  if (element instanceof HTMLInputElement && type) element.type = type;
  element.dataset.name = name;
  return document.body.appendChild(element);
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('restoreMissingFocusin', () => {
  it('sends the focusin Safari leaves out for date, time and datetime-local fields, once, from the control that had focus', async () => {
    likeSafari();
    restoring();
    const heard = focusins();
    const start = control('start');
    const fields = [control('date', 'date'), control('time', 'time'), control('when', 'datetime-local')];

    start.focus();
    for (const field of fields) {
      const before = document.activeElement;
      field.focus();
      expect(heard.at(-1)).not.toMatch(new RegExp(`^${field.dataset.name} `));
      await settle();
      expect(heard.at(-1)).toBe(`${field.dataset.name} <- ${(before as HTMLElement).dataset.name}`);
    }
    expect(heard).toEqual(['start <- -', 'date <- start', 'time <- date', 'when <- time']);
  });

  it('leaves a browser that sends focusin alone', async () => {
    restoring();
    const heard = focusins();
    const start = control('start');
    const date = control('date', 'date');
    const text = control('text', 'text');

    start.focus();
    date.focus();
    text.focus();
    await settle();
    expect(heard).toEqual(['start <- -', 'date <- start', 'text <- date']);
  });

  it('sends nothing for a field that lost focus before the browser was done, and nothing once stopped', async () => {
    likeSafari();
    const stop = restoreMissingFocusin();
    const heard = focusins();
    const date = control('date', 'date');
    const start = control('start');

    date.focus();
    start.focus();
    await settle();
    expect(heard).toEqual(['start <- date']);

    stop();
    date.focus();
    await settle();
    expect(heard).toEqual(['start <- date']);
  });

  it('announces a date field again each time it takes focus back', async () => {
    likeSafari();
    restoring();
    const heard = focusins();
    const date = control('date', 'date');

    date.focus();
    await settle();
    date.blur();
    date.focus();
    await settle();
    expect(heard).toEqual(['date <- -', 'date <- -']);
  });
});

describe('a dialog that opens on a date field in Safari', () => {
  // Fluent's modal hiding runs on tabster's timer (fluentFocus.test.tsx).
  const settleModalizer = () => act(async () => { await vi.advanceTimersByTimeAsync(500); });

  function renderDateDialog() {
    return renderRoutes([page(<>
      <Button>Background control</Button>
      <Dialog>
        <DialogTrigger disableButtonEnhancement><Button>Pick a day</Button></DialogTrigger>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Synthetic day</DialogTitle>
            <DialogContent>
              <Field label="Day"><Input type="date" /></Field>
              <Field label="Note"><Input /></Field>
              <DialogTrigger disableButtonEnhancement><Button>Done</Button></DialogTrigger>
            </DialogContent>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>)], '/');
  }

  // Focus going back to the button on close is the shared Dialog's (Dialog.test.tsx, e2e/dialog-focus.spec.ts).
  it('becomes the active modal on its first field and hides the page behind it', async () => {
    vi.useFakeTimers();
    likeSafari();
    restoring();
    const view = renderDateDialog();
    await settleModalizer();
    const trigger = screen.getByRole('button', { name: 'Pick a day' });
    trigger.focus();
    fireEvent.click(trigger);
    await settleModalizer();

    expect(screen.getByRole('dialog', { name: 'Synthetic day' })).not.toHaveAttribute('aria-hidden');
    expect(screen.getByLabelText('Day')).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Background control' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await settleModalizer();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Background control' })).toBeVisible();
    view.unmount();
    await settleModalizer();
  });

  it('stays hidden from assistive technology without the missing focusin (the failure this guards against)', async () => {
    vi.useFakeTimers();
    likeSafari();
    const view = renderDateDialog();
    await settleModalizer();
    const trigger = screen.getByRole('button', { name: 'Pick a day' });
    trigger.focus();
    fireEvent.click(trigger);
    await settleModalizer();

    expect(screen.getByLabelText('Day', { selector: 'input' })).toHaveFocus();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.querySelector('[role=dialog]')!.closest('[aria-hidden=true]')).not.toBeNull();
    view.unmount();
    await settleModalizer();
  });
});
