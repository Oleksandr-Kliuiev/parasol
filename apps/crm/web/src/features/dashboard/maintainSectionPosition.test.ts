import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { maintainSectionPosition } from './maintainSectionPosition';

let resize!: ResizeObserverCallback;
const observe = vi.fn(), disconnect = vi.fn();
let target: HTMLDivElement, host: HTMLDivElement, other: HTMLButtonElement;
let scroll: Mock<(arg?: boolean | ScrollIntoViewOptions) => void>, stop: (() => void) | undefined;
const originalObserver = window.ResizeObserver;
beforeEach(() => {
  observe.mockClear(); disconnect.mockClear();
  window.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe = observe; disconnect = disconnect; unobserve() {}
  };
  host = document.createElement('div'); target = document.createElement('div'); target.tabIndex = -1;
  scroll = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>(); target.scrollIntoView = scroll;
  other = document.createElement('button'); host.append(target, other); document.body.append(host); target.focus();
});
afterEach(() => { stop?.(); stop = undefined; host?.remove(); window.ResizeObserver = originalObserver; });
const change = () => resize([], {} as ResizeObserver);

it('follows the shared column growing above a focused section without changing focus', () => {
  stop = maintainSectionPosition(target);
  expect(observe).toHaveBeenCalledWith(host); change(); change();
  expect(scroll).toHaveBeenCalledTimes(2); expect(scroll).toHaveBeenLastCalledWith({ block: 'start' });
  expect(document.activeElement).toBe(target);
});

it.each(['wheel', 'touchstart', 'pointerdown', 'keydown'])('stops competing as soon as the user acts (%s)', event => {
  stop = maintainSectionPosition(target); change();
  window.dispatchEvent(new Event(event)); change();
  expect(scroll).toHaveBeenCalledTimes(1); expect(disconnect).toHaveBeenCalledTimes(1);
});

it('stops when keyboard focus enters a control or another part of the page', () => {
  stop = maintainSectionPosition(target); other.focus(); change();
  expect(scroll).not.toHaveBeenCalled(); expect(disconnect).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(other);
});

it('removes its listeners and ignores an already queued callback after owner cleanup', () => {
  const add = vi.spyOn(window, 'addEventListener'), remove = vi.spyOn(window, 'removeEventListener');
  stop = maintainSectionPosition(target); stop(); stop(); change();
  expect(scroll).not.toHaveBeenCalled(); expect(disconnect).toHaveBeenCalledTimes(1);
  const registrations = add.mock.calls.filter(([event]) => ['wheel', 'touchstart', 'pointerdown', 'keydown'].includes(event));
  expect(registrations).toHaveLength(4);
  for (const [event, listener] of registrations) expect(remove.mock.calls).toContainEqual([event, listener, true]);
  add.mockRestore(); remove.mockRestore();
});
