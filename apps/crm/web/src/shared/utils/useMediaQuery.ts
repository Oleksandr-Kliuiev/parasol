import { useSyncExternalStore } from 'react';

export const NARROW_SCREEN = '(max-width: 600px)';

/** Subscribes to a CSS media query, e.g. to render a card list instead of a wide table on phones. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
