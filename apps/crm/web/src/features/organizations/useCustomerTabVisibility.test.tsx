import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useCustomerTabVisibility } from './useCustomerTabVisibility';

// jsdom has no layout: the row is 300 px wide and the Drift tab starts at 280 px, mostly beyond its right edge.
let rects: Record<string, { left: number; right: number }> = {};
let resized: ResizeObserverCallback[] = [];
let observed: Element[] = [];
const scrollBy = vi.fn();
// The test setup's observer is a writable, non-configurable property: replaced by assignment, not by vi.stubGlobal.
const setupObserver = window.ResizeObserver;

beforeEach(() => {
  rects = { row: { left: 0, right: 300 }, overview: { left: 0, right: 120 }, drift: { left: 280, right: 400 } };
  resized = []; observed = [];
  window.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) { resized.push(callback); }
    observe(element: Element) { observed.push(element); }
    unobserve() {}
    disconnect() {}
  };
  // HTMLElement carries a getBoundingClientRect of its own here, in front of Element's.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const { left, right } = rects[this.getAttribute('data-rect') ?? ''] ?? { left: 0, right: 0 };
    return { left, right, top: 0, bottom: 40, width: right - left, height: 40, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollBy', { configurable: true, value: scrollBy });
});
afterEach(() => {
  window.ResizeObserver = setupObserver; vi.restoreAllMocks(); scrollBy.mockReset();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollBy;
});

/** Fluent marks the newly selected tab a render later: in this row the previous tab still says it is the selected one. */
function Row({ tab }: { tab: string }) {
  const ref = useCustomerTabVisibility(tab, 'scope', true);
  return <div ref={ref} role="tablist" data-rect="row">
    <button role="tab" value="overview" aria-selected="true" data-rect="overview">Overview</button>
    <button role="tab" value="drift" aria-selected="false" data-rect="drift">Operations</button>
  </div>;
}

it('reveals the tab the address names while Fluent still marks the previous one as selected', () => {
  render(<Row tab="drift" />);
  expect(scrollBy).toHaveBeenCalledWith({ left: 116, behavior: 'instant' });
});

it('reveals it again when a tab changes size, as when the font arrives and the labels widen', () => {
  render(<Row tab="drift" />);
  expect(observed).toContain(screen.getByRole('tab', { name: 'Operations' }));
  scrollBy.mockClear();
  rects.drift = { left: 300, right: 440 };
  for (const callback of resized) callback([], {} as ResizeObserver);
  expect(scrollBy).toHaveBeenCalledWith({ left: 156, behavior: 'instant' });
});
