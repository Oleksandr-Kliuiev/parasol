/** The search shortcut as the keyboard prints it: ⌘K on Apple devices, Ctrl K elsewhere (both work everywhere). */
export const searchShortcut =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent) ? '⌘K' : 'Ctrl K';
