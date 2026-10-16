/**
 * jsdom has no layout: every offsetParent is null and BODY has a zero rectangle. Tabster then
 * treats every control as display:none, focuses the dialog container and can hide that inactive
 * modalizer on its timer. Model only the visibility inputs its real focus finder needs.
 * This is not layout measurement; browser tests remain authoritative for geometry/accessibility.
 * No aria-hidden, disabled, focus, timers or role-query behavior is overridden here.
 */
export function installSyntheticLayout() {
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const styleOf = (element: Element) => element.ownerDocument.defaultView?.getComputedStyle(element);
  const hasBox = (element: Element) => {
    for (let current: Element | null = element; current; current = current.parentElement)
      if (styleOf(current)?.display === 'none') return false;
    return true;
  };
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value: function (this: HTMLElement): DOMRect {
      if (this === this.ownerDocument.body && this.isConnected && hasBox(this)) return new DOMRect(0, 0, 1024, 768);
      return originalRect.call(this);
    },
  });
  const offsetParentFor = (element: HTMLElement): Element | null => {
    const body = element.ownerDocument.body; const ownStyle = styleOf(element);
    if (!element.isConnected || element === body || element === element.ownerDocument.documentElement
      || ownStyle?.position === 'fixed' || ownStyle?.display === 'contents') return null;
    let positioned: Element | null = null;
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = styleOf(current);
      if (style?.display === 'none') return null;
      if (current.tagName === 'DETAILS' && !current.hasAttribute('open')) {
        const summary = [...current.children].find(child => child.tagName === 'SUMMARY');
        if (element !== current && (!summary || !summary.contains(element))) return null;
      }
      if (current !== element && current !== body && !positioned && style?.display !== 'contents'
        && style?.position && style.position !== 'static') positioned = current;
    }
    return positioned ?? body;
  };
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get: function (this: HTMLElement): Element | null { return offsetParentFor(this); },
  });
}
