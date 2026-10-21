export const TOASTER_ID = 'crm-toaster';

// The shell's toaster comes in its own chunk right after start-up (ShellToaster). A notice dispatched before it listens
// would be lost, and a save straight after a reload is that quick, so notices wait while the shell is loading it.
let waiting: Array<() => void> | undefined;

/** The shell has started loading its toaster: notices wait until {@link toasterReady}. */
export function toasterLoading() {
  waiting ??= [];
}

/** The toaster listens: the notices that waited are shown in order. */
export function toasterReady() {
  const queued = waiting ?? [];
  waiting = undefined;
  for (const show of queued) show();
}

export function whenToasterReady(show: () => void) {
  if (waiting) waiting.push(show);
  else show();
}
