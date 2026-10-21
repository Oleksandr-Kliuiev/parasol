/* Parasoll UX demo: namespace, escaped HTML templates, state, hash routing and formatting.
   Classic scripts (no modules) so the demo also opens straight from the file system. */
(function () {
  'use strict';

  var P = (window.P = window.P || {});
  P.views = P.views || {};

  /* ---------- Escaped templates: every interpolated value is text unless wrapped in raw() ---------- */

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escape(value) {
    return String(value).replace(/[&<>"']/g, function (c) { return ESC[c]; });
  }

  function Raw(s) { this.s = s; }
  Raw.prototype.toString = function () { return this.s; };

  function raw(s) { return new Raw(s == null ? '' : String(s)); }

  function flat(v) {
    if (v == null || v === false || v === true) return '';
    if (v instanceof Raw) return v.s;
    if (Array.isArray(v)) return v.map(flat).join('');
    return escape(v);
  }

  function html(strings) {
    var out = strings[0];
    for (var i = 1; i < arguments.length; i++) out += flat(arguments[i]) + strings[i];
    return new Raw(out);
  }

  P.html = html;
  P.raw = raw;
  P.escape = escape;
  P.toHtml = flat;

  /* ---------- Preferences (per viewer, best effort) ---------- */

  var PREF_KEY = 'parasol-ux-demo';
  function readPrefs() {
    try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  P.savePrefs = function () {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({
        lang: P.state.lang, theme: P.state.theme, role: P.state.role,
        density: P.state.density, railPref: P.state.railPref
      }));
    } catch (e) { /* storage can be blocked; the demo works without it */ }
  };

  var prefs = readPrefs();
  P.state = {
    lang: prefs.lang === 'ru' || !prefs.lang ? 'nb' : prefs.lang,
    theme: prefs.theme || document.documentElement.getAttribute('data-theme') || 'system',
    role: prefs.role || 'technician',
    density: prefs.density || 'comfortable',
    railPref: prefs.railPref || 'full',
    railOpen: false,
    ui: {}
  };

  var listeners = [];
  P.subscribe = function (fn) { listeners.push(fn); };
  P.set = function (patch) {
    Object.keys(patch).forEach(function (k) { P.state[k] = patch[k]; });
    P.savePrefs();
    listeners.forEach(function (fn) { fn(P.state); });
  };
  /* View-local UI state that survives re-renders but not reloads */
  P.ui = function (key, init) {
    if (!(key in P.state.ui)) P.state.ui[key] = typeof init === 'function' ? init() : init;
    return P.state.ui[key];
  };

  /* ---------- Hash router ---------- */

  var ROUTES = [
    ['day', /^\/?(day)?$/],
    ['alerts', /^\/alerts$/],
    ['tasks', /^\/tasks$/],
    ['time', /^\/time(?:\/([\w-]+))?$/],
    ['customers', /^\/customers$/],
    ['customer', /^\/customers\/([\w-]+)(?:\/([\w-]+))?$/],
    ['contracts', /^\/contracts$/],
    ['sales', /^\/sales$/],
    ['projects', /^\/projects$/],
    ['billing', /^\/billing$/],
    ['invoices', /^\/invoices$/],
    ['reports', /^\/reports$/],
    ['connections', /^\/connections$/],
    ['admin', /^\/admin$/]
  ];

  /* Old addresses that still open the same page, like the CRM keeps ?tab=service: the address is rewritten in place */
  var ALIASES = [[/^\/customers\/([\w-]+)\/technical$/, '/customers/$1/operations']];

  P.memPath = null; /* used when the host frame does not let the page change its own hash */
  P.parseRoute = function () {
    var path = P.memPath || (location.hash || '').replace(/^#/, '') || '/day';
    ALIASES.forEach(function (a) {
      if (!a[0].test(path)) return;
      path = path.replace(a[0], a[1]);
      if (P.memPath) P.memPath = path;
      try { if (location.hash !== '#' + path) history.replaceState(null, '', '#' + path); } catch (e) { /* keep the in-memory route */ }
    });
    for (var i = 0; i < ROUTES.length; i++) {
      var m = path.match(ROUTES[i][1]);
      if (m) return { name: ROUTES[i][0], params: m.slice(1), path: path };
    }
    return { name: 'missing', params: [], path: path };
  };

  P.go = function (path) {
    /* Leaving a page closes what was opened on it */
    if (P.popover) P.popover.close();
    if (P.drawer && P.drawer.isOpen()) P.drawer.close();
    if (P.modal && P.modal.isOpen()) P.modal.close();
    P.memPath = path;
    try { if (location.hash !== '#' + path) history.pushState(null, '', '#' + path); } catch (e) { /* keep the in-memory route */ }
    if (P.app) P.app.render();
  };
  window.addEventListener('popstate', function () { P.memPath = null; if (P.app) P.app.render(); });
  /* Every in-app link goes through P.go, so navigation does not depend on hashchange */
  document.addEventListener('click', function (event) {
    var a = event.target.closest && event.target.closest('a[href^="#/"]');
    if (!a || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    P.go(a.getAttribute('href').slice(1));
  });

  /* ---------- Demo clock: Monday 19 October 2026, 08:40 in Oslo (wall-clock values) ---------- */

  P.NOW = new Date(2026, 9, 19, 8, 40);
  P.at = function (dayOffset, h, m) {
    return new Date(2026, 9, 19 + dayOffset, h || 0, m || 0);
  };
  P.sameDay = function (a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  };
  P.dayDiff = function (a, b) {
    var A = new Date(a.getFullYear(), a.getMonth(), a.getDate());
    var B = new Date(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((A - B) / 86400000);
  };
  P.isoWeek = function (d) {
    var t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    var dayNum = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - dayNum);
    var yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  };

  /* ---------- Locale-aware formatting ---------- */

  var LOCALE = { nb: 'nb-NO', nn: 'nn-NO', en: 'en-GB' };
  /* A browser without Nynorsk data (some headless builds) formats dates and money in English: use Bokmål then */
  P.locale = function () {
    var wanted = LOCALE[P.state.lang] || 'nb-NO';
    return Intl.DateTimeFormat.supportedLocalesOf([wanted]).length ? wanted : 'nb-NO';
  };

  var nfCache = {};
  function nf(opts) {
    var key = P.state.lang + JSON.stringify(opts);
    if (!nfCache[key]) nfCache[key] = new Intl.NumberFormat(P.locale(), opts);
    return nfCache[key];
  }

  var pad = function (n) { return String(n).padStart(2, '0'); };

  P.fmt = {
    num: function (n, digits) {
      return nf({ minimumFractionDigits: 0, maximumFractionDigits: digits == null ? 2 : digits }).format(n);
    },
    hours: function (h) {
      return P.fmt.num(h, 2) + ' ' + P.t('unit.h');
    },
    money: function (n) {
      var whole = Math.abs(n % 1) < 0.005;
      return nf({ style: 'currency', currency: 'NOK', minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(n);
    },
    pct: function (n) { return nf({ style: 'percent', maximumFractionDigits: 0 }).format(n); },
    /* Identifiers such as K-2026-0001 never break across lines */
    id: function (s) { return String(s).replace(/-/g, '\u2011'); },
    date: function (d) { return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear(); },
    dm: function (d) { return pad(d.getDate()) + '.' + pad(d.getMonth() + 1); },
    time: function (d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); },
    dateTime: function (d) { return P.fmt.date(d) + ' ' + P.fmt.time(d); },
    weekday: function (d, style) {
      return new Intl.DateTimeFormat(P.locale(), { weekday: style || 'short' }).format(d).replace('.', '');
    },
    longDay: function (d) {
      var s = new Intl.DateTimeFormat(P.locale(), { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
      return s.charAt(0).toUpperCase() + s.slice(1);
    },
    month: function (y, m) {
      var s = new Intl.DateTimeFormat(P.locale(), { month: 'long', year: 'numeric' }).format(new Date(y, m, 1));
      return s.charAt(0).toUpperCase() + s.slice(1);
    },
    /* "08:40", "i går 23:10", "fre 16.10", "03.09.2026" depending on distance */
    when: function (d) {
      var diff = P.dayDiff(d, P.NOW);
      if (diff === 0) return P.t('when.today') + ' ' + P.fmt.time(d);
      if (diff === -1) return P.t('when.yesterday') + ' ' + P.fmt.time(d);
      if (diff === 1) return P.t('when.tomorrow') + ' ' + P.fmt.time(d);
      if (Math.abs(diff) < 7) return P.fmt.weekday(d) + ' ' + P.fmt.dm(d);
      return P.fmt.date(d);
    },
    ago: function (d) {
      var mins = Math.round((P.NOW - d) / 60000);
      var rtf = new Intl.RelativeTimeFormat(P.locale(), { numeric: 'auto', style: 'short' });
      if (Math.abs(mins) < 1) return P.t('when.now');
      if (Math.abs(mins) < 60) return rtf.format(-mins, 'minute');
      var hours = Math.round(mins / 60);
      if (Math.abs(hours) < 24) return rtf.format(-hours, 'hour');
      return rtf.format(-Math.round(hours / 24), 'day');
    }
  };

  /* ---------- Small DOM helpers ---------- */

  P.$ = function (sel, root) { return (root || document).querySelector(sel); };
  P.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  P.uid = (function () { var n = 0; return function (p) { n += 1; return (p || 'id') + '-' + n; }; })();

  /* Delegated actions: <button data-action="name" data-id="..."> */
  P.actions = {};
  P.on = function (name, fn) { P.actions[name] = fn; };
  document.addEventListener('click', function (event) {
    var el = event.target.closest('[data-action]');
    if (!el || el.matches('[disabled],[aria-disabled="true"]')) return;
    var fn = P.actions[el.getAttribute('data-action')];
    if (!fn) return;
    if (el.tagName === 'A') event.preventDefault();
    fn(el, event);
  });
})();
