import { makeStyles, mergeClasses, type FluentProviderCustomStyleHooks } from '@fluentui/react-components';
import { controlStyleHooks } from './hearthControls';
import { surfaceStyleHooks } from './hearthSurfaces';

/*
 * Component shapes of the visual system that theme tokens cannot express, applied to every Fluent component through the
 * provider's custom style hooks, so pages keep using plain Fluent components: controls in hearthControls.ts, surfaces
 * and floating layers in hearthSurfaces.ts, avatars here.
 */

export { CompactControls } from './compactControls';

// Avatars in the four pastel tints of the reference instead of Fluent's colourful palette; a name keeps its tint.
const useAvatar = makeStyles({
  t0: { backgroundColor: '#F7CDBB', color: '#1D1915' },
  t1: { backgroundColor: '#D4D1F6', color: '#1D1915' },
  t2: { backgroundColor: '#C4E7DD', color: '#1D1915' },
  t3: { backgroundColor: '#F3DFAE', color: '#1D1915' },
});
const avatarTints = ['t0', 't1', 't2', 't3'] as const;

export const hearthStyleHooks: FluentProviderCustomStyleHooks = {
  ...controlStyleHooks,
  ...surfaceStyleHooks,
  useAvatarStyles_unstable: (state) => {
    const s = state as {
      root: { className?: string; 'aria-label'?: string };
      color: string;
      initials?: { children?: unknown; className?: string };
      image?: { src?: unknown };
    };
    const styles = useAvatar();
    if (s.color === 'neutral' || s.color === 'brand' || s.image?.src) return;
    // The full name (Fluent puts it in the root's aria-label), so "Synthetic Client 01" and "… 02" differ.
    const key = s.root['aria-label'] ?? String(s.initials?.children ?? '');
    let hash = 0;
    for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    // Fluent paints the colour on the initials slot, not on the root.
    const tint = styles[avatarTints[hash % avatarTints.length]!];
    s.root.className = mergeClasses(s.root.className, tint);
    if (s.initials) s.initials.className = mergeClasses(s.initials.className, tint);
  },
};
