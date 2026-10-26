import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { keepFocusInPanel } from './panelFocus';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  document.body.innerHTML = `
    <div role="dialog" aria-label="#4711 Printer is down">
      <div data-bar><button>Close ticket</button><button>Change priority</button></div>
      <button>Send the reply</button>
    </div>
    <div role="dialog" aria-label="Reply in #4711"><button>Close</button></div>`;
});
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

const button = (name: string) => [...document.querySelectorAll('button')].find((element) => element.textContent === name)!;
const bar = () => ({ current: document.querySelector<HTMLElement>('[data-bar]') });
const idle = { current: false };

it('waits while the closing confirmation keeps focus, then puts it on the panel\'s first change once it falls to the page', () => {
  // WebKit on Linux focuses a pressed button: Close keeps focus while the confirmation fades out, longer than a fixed pause.
  const close = button('Close'); close.focus();
  keepFocusInPanel(bar(), idle);
  vi.advanceTimersByTime(500);
  expect(close).toHaveFocus();

  close.blur(); close.closest('[role="dialog"]')!.remove();
  vi.advanceTimersByTime(20);
  expect(button('Close ticket')).toHaveFocus();
});

it('leaves focus that came back into the panel by itself, and focus that the next confirmation took', () => {
  button('Send the reply').focus();
  keepFocusInPanel(bar(), idle);
  vi.advanceTimersByTime(100);
  expect(button('Send the reply')).toHaveFocus();

  button('Close').focus();
  keepFocusInPanel(bar(), { current: true });
  button('Close').blur();
  vi.advanceTimersByTime(100);
  expect(document.body).toHaveFocus();
});

it('stops looking after a few seconds, so a later loss of focus is left alone', () => {
  const close = button('Close'); close.focus();
  keepFocusInPanel(bar(), idle);
  vi.advanceTimersByTime(3_100);
  close.blur();
  vi.advanceTimersByTime(100);
  expect(document.body).toHaveFocus();
});
