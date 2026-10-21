import { useCallback, useState, type KeyboardEvent } from 'react';

const STORAGE_KEY = 'parasoll.queueShortcuts';

function readShortcuts(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** Whether the queue's single-key shortcuts are on: a convenience of this browser, and one the person can turn off (WCAG 2.1.4). */
export function useShortcutSetting(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(readShortcuts);
  const set = useCallback((value: boolean) => {
    setOn(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, value ? 'on' : 'off');
    } catch {
      // Storage is blocked: the choice lasts while the page is open.
    }
  }, []);
  return [on, set];
}

export interface QueueKeyActions {
  open: (key: string) => void;
  assign: (key: string) => void;
  toggle: (key: string) => void;
}

/**
 * The queue's keys, heard only while focus is on a row itself, never while typing in a control inside it. The arrows,
 * Home and End move between rows and Enter opens the row's work; the single letters (J and K to move, A to open it
 * assigned to the person, X to select) work only while the person keeps them on.
 */
export function queueKeyHandler(shortcuts: boolean, actions: QueueKeyActions) {
  return (event: KeyboardEvent<HTMLElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-queue-row]');
    if (!row || event.target !== row || event.altKey || event.ctrlKey || event.metaKey) return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-queue-row]')];
    const index = rows.indexOf(row);
    const key = row.dataset.queueRow!;
    const move = (to: number) => {
      event.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, to))]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown': return move(index + 1);
      case 'ArrowUp': return move(index - 1);
      case 'Home': return move(0);
      case 'End': return move(rows.length - 1);
      case 'Enter': event.preventDefault(); return actions.open(key);
    }
    if (!shortcuts || event.shiftKey) return;
    switch (event.key.toLowerCase()) {
      case 'j': return move(index + 1);
      case 'k': return move(index - 1);
      case 'a': event.preventDefault(); return actions.assign(key);
      case 'x': event.preventDefault(); return actions.toggle(key);
    }
  };
}
