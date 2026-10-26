/* Parasoll UX demo: drawer (bottom sheet on phones), modal, anchored popover and toasts.
   Native <dialog> gives focus containment and Escape; focus returns to the control that opened it. */
(function () {
  'use strict';

  var P = window.P;
  var h = P.html;

  function isPhone() { return window.matchMedia('(max-width: 767px)').matches; }
  P.isPhone = isPhone;

  /* ---------- Drawer and modal share one implementation ---------- */

  function layer(id) {
    var el = document.getElementById(id);
    var state = { render: null, opener: null, onClose: null };
    el.addEventListener('close', function () {
      /* The close event is queued; if the layer was reopened meanwhile, it must not wipe the new content */
      if (el.open) return;
      var fn = state.onClose;
      state.render = null;
      el.innerHTML = '';
      if (fn) fn();
      if (state.opener && document.contains(state.opener)) state.opener.focus();
      else { var main = document.getElementById('page-title'); if (main) main.focus(); }
      state.opener = null;
    });
    el.addEventListener('click', function (e) {
      if (e.target === el) el.close();
    });
    return {
      open: function (render, opts) {
        opts = opts || {};
        var reopening = el.open;
        if (reopening && state.onClose) state.onClose();
        state.render = render;
        state.onClose = opts.onClose || null;
        if (!reopening || !state.opener) state.opener = document.activeElement;
        el.setAttribute('aria-label', opts.label || '');
        el.innerHTML = P.toHtml(render());
        if (!el.open) el.showModal();
        /* Start where the person types; otherwise announce the title without a focus ring */
        var focus = el.querySelector('[autofocus]') || el.querySelector('#sheet-title');
        if (focus) focus.focus();
      },
      refresh: function () {
        if (!state.render || !el.open) return;
        var active = document.activeElement;
        var key = active && active.getAttribute('data-focus');
        var scroll = el.querySelector('.sheet-body');
        var top = scroll ? scroll.scrollTop : 0;
        el.innerHTML = P.toHtml(state.render());
        var body = el.querySelector('.sheet-body');
        if (body) body.scrollTop = top;
        if (key) { var again = el.querySelector('[data-focus="' + key + '"]'); if (again) again.focus(); }
      },
      close: function () { if (el.open) el.close(); },
      isOpen: function () { return el.open; },
      el: el
    };
  }

  P.initOverlays = function () {
    P.drawer = layer('drawer');
    P.modal = layer('modal');
  };

  P.on('close-layer', function (el) {
    var d = el.closest('dialog');
    if (d) d.close();
  });

  /* Standard drawer frame */
  P.sheet = function (o) {
    return h`<div class="sheet">
      <header class="sheet-head">
        <div class="sheet-title">${o.eyebrow ? h`<span class="eyebrow">${o.eyebrow}</span>` : ''}<h2 id="sheet-title" tabindex="-1">${o.title}</h2>${o.meta || ''}</div>
        <button class="icon-btn is-quiet" type="button" data-action="close-layer" aria-label="${P.t('common.close')}" title="${P.t('common.close')}">${P.icon('x')}</button>
      </header>
      <div class="sheet-body">${o.body}</div>
      ${o.foot ? h`<footer class="sheet-foot">${o.foot}</footer>` : ''}
    </div>`;
  };

  /* ---------- Anchored popover (falls back to the bottom sheet on phones) ---------- */

  var pop = { el: null, anchor: null, render: null };

  function placePopover() {
    if (!pop.el || !pop.anchor) return;
    var r = pop.anchor.getBoundingClientRect();
    var w = pop.el.offsetWidth;
    var hgt = pop.el.offsetHeight;
    var left = Math.min(Math.max(16, r.right - w), window.innerWidth - w - 16);
    if (pop.align === 'start') left = Math.min(Math.max(16, r.left), window.innerWidth - w - 16);
    var top = r.bottom + 8;
    if (top + hgt > window.innerHeight - 16 && r.top - hgt - 8 > 16) top = r.top - hgt - 8;
    /* Never let the confirm button fall below the screen: slide the popover up instead */
    top = Math.min(top, window.innerHeight - hgt - 16);
    pop.el.style.left = left + 'px';
    pop.el.style.top = Math.max(16, top) + 'px';
  }

  P.popover = {
    open: function (anchor, render, opts) {
      opts = opts || {};
      if (isPhone() && !opts.keepOnPhone) {
        P.drawer.open(function () { return P.sheet({ title: opts.title || '', body: render(), foot: opts.foot ? opts.foot() : '' }); }, { label: opts.title });
        return;
      }
      P.popover.close();
      /* A labelled section is a region landmark; menus keep role="menu" on their own list */
      var el = document.createElement('section');
      el.className = 'popover' + (opts.wide ? ' is-wide' : '');
      if (opts.role !== 'menu') el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', opts.title || '');
      el.setAttribute('data-kind', opts.role || 'dialog');
      el.innerHTML = P.toHtml(h`${opts.title ? h`<div class="pop-head"><strong>${opts.title}</strong></div>` : ''}${render()}${opts.foot ? h`<div class="pop-foot">${opts.foot()}</div>` : ''}`);
      document.body.appendChild(el);
      pop.el = el; pop.anchor = anchor; pop.render = render; pop.opts = opts; pop.align = opts.align;
      anchor.setAttribute('aria-expanded', 'true');
      placePopover();
      var first = el.querySelector('[autofocus]') || el.querySelector('button, a, input, select');
      if (first) first.focus();
    },
    refresh: function () {
      if (!pop.el) return;
      var o = pop.opts;
      pop.el.innerHTML = P.toHtml(h`${o.title ? h`<div class="pop-head"><strong>${o.title}</strong></div>` : ''}${pop.render()}${o.foot ? h`<div class="pop-foot">${o.foot()}</div>` : ''}`);
      placePopover();
    },
    close: function (restore) {
      if (!pop.el) return;
      var after = pop.opts && pop.opts.onClose;
      pop.el.remove();
      if (pop.anchor) {
        pop.anchor.setAttribute('aria-expanded', 'false');
        if (restore && document.contains(pop.anchor)) pop.anchor.focus();
      }
      pop.el = null; pop.anchor = null; pop.render = null; pop.opts = null;
      if (after) after();
    },
    isOpen: function () { return !!pop.el; }
  };

  document.addEventListener('mousedown', function (e) {
    if (pop.el && !pop.el.contains(e.target) && !(pop.anchor && pop.anchor.contains(e.target))) P.popover.close();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && pop.el) { e.preventDefault(); P.popover.close(true); }
    if (pop.el && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && pop.el.getAttribute('data-kind') === 'menu') {
      var items = P.$$('.menu-item:not([disabled])', pop.el);
      var i = items.indexOf(document.activeElement);
      var next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      if (items[next]) { e.preventDefault(); items[next].focus(); }
    }
  });
  window.addEventListener('resize', placePopover);
  window.addEventListener('scroll', function () { if (pop.el) placePopover(); }, true);

  /* ---------- Toasts: polite live region, optional single action ---------- */

  var toastSeq = 0;
  var toastActions = {};
  P.toast = function (text, opts) {
    opts = opts || {};
    toastSeq += 1;
    var id = 'toast-' + toastSeq;
    if (opts.action) toastActions[id] = opts.action.fn;
    var wrap = document.getElementById('toasts');
    var el = document.createElement('div');
    el.className = 'toast' + (opts.tone === 'warn' ? ' is-warn' : '');
    el.id = id;
    el.innerHTML = P.toHtml(h`${P.icon(opts.tone === 'warn' ? 'triangle' : 'circleCheck')}<span>${text}</span>
      ${opts.action ? h`<button class="btn btn-link btn-sm" type="button" data-action="toast-action" data-id="${id}">${opts.action.label}</button>` : h`<span></span>`}`);
    wrap.appendChild(el);
    setTimeout(function () { el.remove(); delete toastActions[id]; }, opts.action ? 9000 : 5000);
  };
  P.on('toast-action', function (el) {
    var id = el.getAttribute('data-id');
    var fn = toastActions[id];
    var node = document.getElementById(id);
    if (node) node.remove();
    delete toastActions[id];
    if (fn) fn();
  });
})();
