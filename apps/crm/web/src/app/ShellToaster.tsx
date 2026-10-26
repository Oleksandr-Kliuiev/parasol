import { useEffect } from 'react';
import { Toaster, makeStyles } from '@fluentui/react-components';
import { TOASTER_ID, toasterReady } from './toaster';

// Fluent centres the toasts in the window, which a modal's scroll lock widens by the scrollbar it hides (scrollLock.ts).
// Fluent also hands the Toaster's class to every toast, so only the positioned container moves back.
const useStyles = makeStyles({
  toaster: { '&[data-toaster-position]': { translate: 'calc(var(--h-locked-scrollbar, 0px) / -2)' } },
});

/**
 * Toasts rise near the bottom edge, as in the reference; on phones above the tab bar. Its own chunk, loaded right after
 * start-up (bundle budget in scripts/bundle-budget.mjs); notices dispatched before it mounts wait for it (./toaster).
 */
export function ShellToaster({ phone }: { phone: boolean }) {
  const styles = useStyles();
  // Fluent's Toaster starts listening in its own effect, which runs before this one.
  useEffect(() => toasterReady(), []);
  return <Toaster className={styles.toaster} toasterId={TOASTER_ID} position="bottom" offset={{ vertical: phone ? 96 : 24 }} />;
}
