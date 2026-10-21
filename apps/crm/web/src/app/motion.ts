import { createContext, useContext, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/*
 * Motion of the visual system, after the choreography of the reference (docs/ux/UX-CONCEPT.md §8): the shell slides in
 * once, every page rises in order (title letters, header, tiles, cards, rows), numbers count up, bars grow, the menu
 * pill follows the current page and icon buttons lean towards the pointer. It runs on the Web Animations API, so it needs
 * no library and stops completely when the person asks for reduced motion. jsdom has no Element.animate: in unit tests
 * every helper is a no-op and the final state renders at once.
 */

const reducedMotion =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : undefined;
const finePointer =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(hover: hover) and (pointer: fine)') : undefined;

export function motionAllowed(): boolean {
  return typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function' && !reducedMotion?.matches;
}

/** The eases of the reference (GSAP names in the comments) as CSS timing functions. */
export const ease = {
  out: 'cubic-bezier(0.33, 1, 0.68, 1)', // power3.out
  outStrong: 'cubic-bezier(0.25, 1, 0.5, 1)', // power4.out
  outSoft: 'cubic-bezier(0.5, 1, 0.89, 1)', // power2.out
  in: 'cubic-bezier(0.11, 0, 0.5, 0)', // power2.in
  inOut: 'cubic-bezier(0.65, 0, 0.35, 1)', // power3.inOut
} as const;

const supportsLinear =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('animation-timing-function', 'linear(0, 1)');
const backCache = new Map<number, string>();

/** back.out(overshoot): exact through CSS linear() where the browser has it, a close bezier elsewhere. */
export function backOut(overshoot = 1.7): string {
  let value = backCache.get(overshoot);
  if (!value) {
    if (supportsLinear) {
      const points: string[] = [];
      for (let i = 0; i <= 32; i++) {
        const t = i / 32 - 1;
        points.push((1 + (overshoot + 1) * t ** 3 + overshoot * t ** 2).toFixed(4));
      }
      value = `linear(${points.join(', ')})`;
    } else {
      value = `cubic-bezier(0.34, ${(1 + overshoot * 0.33).toFixed(2)}, 0.64, 1)`;
    }
    backCache.set(overshoot, value);
  }
  return value;
}

export interface From {
  x?: number;
  y?: number;
  yPercent?: number;
  rotate?: number;
  scale?: number;
  opacity?: number;
}

function transformOf(from: From): string {
  const parts: string[] = [];
  if (from.x || from.y) parts.push(`translate(${from.x ?? 0}px, ${from.y ?? 0}px)`);
  if (from.yPercent) parts.push(`translateY(${from.yPercent}%)`);
  if (from.rotate) parts.push(`rotate(${from.rotate}deg)`);
  if (from.scale !== undefined && from.scale !== 1) parts.push(`scale(${from.scale})`);
  return parts.join(' ') || 'none';
}

export interface RevealOptions {
  duration?: number;
  delay?: number;
  stagger?: number;
  easing?: string;
}

/**
 * Moves elements in from `from` to where they are, one after another. Only the start is given: the end is the element's
 * own style, and nothing stays on the element afterwards (no inline transform left behind).
 */
export function reveal(
  targets: Iterable<Element> | Element | null | undefined,
  from: From,
  { duration = 550, delay = 0, stagger = 45, easing = ease.out }: RevealOptions = {},
): Animation[] {
  if (!targets || !motionAllowed()) return [];
  const list = targets instanceof Element ? [targets] : [...targets];
  const start: Keyframe = { offset: 0, transform: transformOf(from) };
  if (from.opacity !== 1) start.opacity = from.opacity ?? 0;
  return list.map((element, index) =>
    element.animate([start], { duration, delay: delay + index * stagger, easing, fill: 'backwards' }),
  );
}

/** The small "pop" of an icon after a click (theme, search, notifications). */
export function popIcon(button: Element | null | undefined) {
  const icon = button?.querySelector('svg');
  if (!icon || !motionAllowed()) return;
  icon.animate([{ transform: 'scale(0.72)' }, { transform: 'none' }], { duration: 550, easing: backOut(3) });
}

/** A changed value flashes in ember and bounces once, so the eye finds what moved. */
export function flashValue(element: HTMLElement | null | undefined) {
  if (!element || !motionAllowed()) return;
  element.animate([{ color: 'var(--h-ember-t)' }, {}], { duration: 900, easing: ease.out });
  element.animate([{ transform: 'translateY(-4px) scale(1.06)' }, { transform: 'none' }], { duration: 550, easing: backOut(2.4) });
}

/**
 * Pages rise in order: each card, tile and header part that mounts takes the next slot of the current page, so the first
 * screen builds up from top to bottom. Parts that arrive much later (a slow list, a tab opened later) start a new run.
 */
const RevealScope = createContext('');
export const RevealScopeProvider = RevealScope.Provider;

let scopeKey: string | undefined;
let scopeStart = 0;
let scopeCount = 0;

function nextSlot(key: string): number {
  const now = performance.now();
  if (key !== scopeKey || now - scopeStart > 1200) {
    scopeKey = key;
    scopeStart = now;
    scopeCount = 0;
  }
  return scopeCount++;
}

const kinds = {
  tile: { from: { y: 26, scale: 0.985 }, duration: 900, delay: 80, stagger: 70 },
  card: { from: { y: 34, scale: 0.985 }, duration: 900, delay: 120, stagger: 70 },
  item: { from: { y: 14 }, duration: 550, delay: 120, stagger: 60 },
} satisfies Record<string, { from: From; duration: number; delay: number; stagger: number }>;

export type RevealKind = keyof typeof kinds;

/**
 * Lets the element rise into place when it mounts, in page order. `ready` is for an element that the component renders
 * only later (after its data): the entrance runs once, when it turns true.
 */
export function useReveal(ref: RefObject<HTMLElement | null>, kind: RevealKind = 'card', ready = true) {
  const key = useContext(RevealScope);
  const done = useRef(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!ready || done.current || !element || !motionAllowed()) return;
    done.current = true;
    const spec = kinds[kind];
    const [animation] = reveal(element, spec.from, {
      duration: spec.duration,
      delay: spec.delay + Math.min(nextSlot(key), 9) * spec.stagger,
    });
    return () => animation?.cancel();
    // Once: a re-render must not replay the entrance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
}

/** Icon buttons lean towards the pointer and spring back (mouse and trackpad only). */
export function useMagnetic<T extends HTMLElement>(strength = 0.26): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || !finePointer?.matches || !motionAllowed()) return;
    const move = (event: PointerEvent) => {
      const box = element.getBoundingClientRect();
      const x = (event.clientX - box.left - box.width / 2) * strength;
      const y = (event.clientY - box.top - box.height / 2) * strength * 1.2;
      element.style.translate = `${x.toFixed(1)}px ${y.toFixed(1)}px`;
    };
    const leave = () => {
      element.style.translate = '';
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerleave', leave);
    return () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerleave', leave);
      element.style.translate = '';
    };
  }, [strength]);
  return ref;
}

/** A value tweened on every frame (the moving menu pill); ends at `to` at once when motion is reduced. */
export function tween(from: number, to: number, duration: number, easing: (t: number) => number, onUpdate: (value: number) => void) {
  if (!motionAllowed() || from === to) {
    onUpdate(to);
    return () => {};
  }
  const start = performance.now();
  let frame = requestAnimationFrame(function step(now) {
    const t = Math.min(1, (now - start) / duration);
    onUpdate(from + (to - from) * easing(t));
    if (t < 1) frame = requestAnimationFrame(step);
  });
  return () => cancelAnimationFrame(frame);
}

export const easeFn = {
  out: (t: number) => 1 - (1 - t) ** 3,
  inOut: (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
};
