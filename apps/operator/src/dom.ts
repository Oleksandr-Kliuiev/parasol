// Minimal safe DOM construction: elements, fixed class names and textContent only. No innerHTML, attribute values from
// data, URLs or inline styles; callers pass only literal class names and validated or display-shortened text.
import { displayText } from './validate-core.ts';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string | null, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  return node;
}

export function byId<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error('CONSOLE_MARKUP_MISSING');
  return node;
}

/** Text shortened for display, with a visible marker and a screen-reader note. */
export function shortenedText(text: string, shortened: boolean): (Node | string)[] {
  return shortened ? [text, el('span', 'shortened', '…'), el('span', 'visually-hidden', ' (shortened)')] : [text];
}

/** Untrusted text (source/user/server strings): text nodes only, at most the display cap, visibly marked when shortened. */
export function untrusted(value: string): (Node | string)[] {
  const shown = displayText(value);
  return shortenedText(shown.text, shown.shortened);
}

export function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

/**
 * Replaces a region's children. When focus was inside it and the focused node is gone afterwards, focus moves to the
 * `preferred` replacement (the same row) or else to `fallback` (the region heading) instead of being lost to the page.
 * Focus elsewhere is never moved.
 */
export function rebuild(region: HTMLElement, fallback: HTMLElement, children: Node[], preferred: HTMLElement | null = null): void {
  const had = region.contains(document.activeElement);
  region.replaceChildren(...children);
  if (!had || region.contains(document.activeElement)) return;
  (preferred ?? fallback).focus();
}
