import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { DialogBody, DialogSurface, DialogTitle, FluentProvider } from '@fluentui/react-components';
import { Dialog } from '../shared/components/Dialog';
import { watchScrollLock } from './scrollLock';
import { lightTheme } from './theme';

const html = document.documentElement;
let stop: (() => void) | undefined;

/**
 * jsdom has no layout: the content of a scrolling 100 px probe reports `width` px less, taken by the scrollbar, and the
 * page is `pageHeight` px tall (the window is 768 px).
 */
function scrollbarOf(width: number, pageHeight = 768) {
  const rect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === document.body) return new DOMRect(0, 0, 1024, pageHeight);
    return this.parentElement?.style.overflow === 'scroll' ? new DOMRect(0, 0, 100 - width, 0) : rect.call(this);
  });
}

// The page's own lock, as Fluent's react-dialog puts it on <html>; MutationObserver callbacks run as microtasks.
const lockStyle = Object.assign(document.createElement('style'), { textContent: '.test-lock { overflow-y: clip; scrollbar-gutter: stable; }' });
const lock = () => html.classList.add('test-lock');
const unlock = () => html.classList.remove('test-lock');
const settle = () => new Promise((resolve) => setTimeout(resolve));

const pageStyles = () => ({
  gutter: html.style.getPropertyValue('scrollbar-gutter'),
  padding: html.style.getPropertyValue('padding-right'),
  locked: html.style.getPropertyValue('--h-locked-scrollbar'),
  body: document.body.style.getPropertyValue('overflow-y'),
});
const untouched = { gutter: '', padding: '', locked: '', body: '' };

afterEach(() => {
  stop?.();
  stop = undefined;
  unlock();
  lockStyle.remove();
});

describe('watchScrollLock', () => {
  it('swaps the empty gutter of a locked page for the scrollbar width as padding, and gives it back on unlock', async () => {
    scrollbarOf(15);
    document.head.append(lockStyle);
    stop = watchScrollLock();

    lock();
    await settle();
    expect(pageStyles()).toEqual({ gutter: 'auto', padding: '15px', locked: '15px', body: 'visible' });

    unlock();
    await settle();
    expect(pageStyles()).toEqual(untouched);
  });

  it('keeps the fraction of a pixel a scrollbar takes under browser zoom', async () => {
    scrollbarOf(15.5);
    document.head.append(lockStyle);
    stop = watchScrollLock();

    lock();
    await settle();
    expect(pageStyles()).toMatchObject({ padding: '15.5px', locked: '15.5px' });
  });

  it('adds no room where scrollbars overlay the page or are hidden', async () => {
    scrollbarOf(0);
    document.head.append(lockStyle);
    stop = watchScrollLock();

    lock();
    await settle();
    expect(pageStyles()).toEqual({ gutter: 'auto', padding: '0px', locked: '0px', body: 'visible' });
  });

  it('ignores other changes of the class list and leaves the page as it was once stopped', async () => {
    scrollbarOf(15);
    document.head.append(lockStyle);
    stop = watchScrollLock();

    html.classList.add('unrelated');
    await settle();
    expect(pageStyles()).toEqual(untouched);
    html.classList.remove('unrelated');

    lock();
    await settle();
    stop();
    stop = undefined;
    expect(pageStyles()).toEqual(untouched);
  });

  it("follows Fluent's own lock while a modal dialog is open", async () => {
    // Fluent locks only a page taller than the window.
    scrollbarOf(15, 2400);
    stop = watchScrollLock();

    const dialog = (open: boolean) => (
      <FluentProvider theme={lightTheme}>
        <Dialog open={open}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Pause Atera</DialogTitle>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </FluentProvider>
    );
    const view = render(dialog(true));
    await settle();
    expect(getComputedStyle(html).overflowY).toMatch(/^(clip|hidden)$/);
    expect(pageStyles()).toEqual({ gutter: 'auto', padding: '15px', locked: '15px', body: 'visible' });

    view.rerender(dialog(false));
    await settle();
    expect(pageStyles()).toEqual(untouched);
  });
});
