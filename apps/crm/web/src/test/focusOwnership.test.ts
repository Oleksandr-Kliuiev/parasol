/// <reference types="node" />
import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';

interface FocusOwner {
  subscribe(callback: (keyboard: boolean) => void): void;
  setVal(keyboard: boolean): void;
}
interface FocusRuntime {
  createKeyborg(target: Window): FocusOwner;
  disposeKeyborg(owner: FocusOwner): void;
}

// Resolve through the real consumers, so an incompatible transitive graph cannot
// pass by importing a test-only alias or a different copy of the focus library.
const require = createRequire(import.meta.url);
const fluentRequire = createRequire(require.resolve('@fluentui/react-tabster'));
const tabsterRequire = createRequire(require.resolve('tabster'));

it.each(['Fluent first', 'Tabster first'] as const)('shares focus ownership and safely disposes %s', order => {
  expect(fluentRequire.resolve('keyborg')).toBe(tabsterRequire.resolve('keyborg'));
  const fluent = fluentRequire('keyborg') as FocusRuntime;
  const tabster = tabsterRequire('keyborg') as FocusRuntime;
  expect(fluent).toBe(tabster);

  const errors = vi.spyOn(console, 'error');
  const originalFocus = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'focus');
  const fluentOwner = fluent.createKeyborg(window);
  const tabsterOwner = tabster.createKeyborg(window);
  const fluentChanges = vi.fn();
  const tabsterChanges = vi.fn();
  fluentOwner.subscribe(fluentChanges);
  tabsterOwner.subscribe(tabsterChanges);
  let fluentDisposed = false;
  let tabsterDisposed = false;

  try {
    fluentOwner.setVal(true);
    expect(fluentChanges).toHaveBeenCalledExactlyOnceWith(true);
    expect(tabsterChanges).toHaveBeenCalledExactlyOnceWith(true);

    if (order === 'Fluent first') {
      fluent.disposeKeyborg(fluentOwner); fluentDisposed = true;
      tabsterOwner.setVal(false);
      expect(fluentChanges).toHaveBeenCalledTimes(1);
      expect(tabsterChanges).toHaveBeenLastCalledWith(false);
      expect(tabsterChanges).toHaveBeenCalledTimes(2);
    } else {
      tabster.disposeKeyborg(tabsterOwner); tabsterDisposed = true;
      fluentOwner.setVal(false);
      expect(tabsterChanges).toHaveBeenCalledTimes(1);
      expect(fluentChanges).toHaveBeenLastCalledWith(false);
      expect(fluentChanges).toHaveBeenCalledTimes(2);
    }
  } finally {
    if (!fluentDisposed) fluent.disposeKeyborg(fluentOwner);
    if (!tabsterDisposed) tabster.disposeKeyborg(tabsterOwner);
  }

  expect(Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'focus')).toEqual(originalFocus);
  expect(errors).not.toHaveBeenCalled();
});
