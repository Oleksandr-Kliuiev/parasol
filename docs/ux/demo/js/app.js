/* Parasol UX demo: boot, view registry, render loop, global actions and keyboard shortcuts. */
(function () {
  'use strict';

  var P = window.P;
  var t = P.t;
  var D = P.data;

  P.views = P.views || {};
  var app = (P.app = {});
  var lastRoute = null;

  function applyPrefs() {
    var root = document.documentElement;
    if (P.state.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', P.state.theme);
    if (P.state.density === 'compact') root.setAttribute('data-density', 'compact');
    else root.removeAttribute('data-density');
    P.applyLang();
  }

  /* Rail: full on wide screens (or mini by choice), icons-only on tablets, hidden on phones */
  function applyRail() {
    var shell = document.querySelector('.app');
    var w = window.innerWidth;
    var mode = w >= 1100 ? P.state.railPref : (P.state.railOpen ? 'open' : 'mini');
    shell.setAttribute('data-rail', mode);
  }

  app.render = function () {
    var route = P.parseRoute();
    var view = P.views[route.name] || P.views.missing;
    var allowed = !view.perm || P.can(view.perm);
    var page;
    try {
      page = allowed ? view.render(route) : P.views.denied.render(route, view);
    } catch (err) {
      /* A failing view shows a plain error state instead of a blank screen */
      if (window.console) console.error(err);
      page = { title: t('error.title'), body: P.ui$.card({ body: P.ui$.empty('alert', t('error.title'), t('error.text'),
        P.html`<a class="btn btn-primary" href="#/day">${t('nav.day')}</a>`) }) };
    }
    applyRail();
    P.$('#rail').innerHTML = P.toHtml(P.renderRail(route));
    P.$('#topbar').innerHTML = P.toHtml(P.renderTopbar(route, page.crumbs || [{ label: page.title }]));
    P.$('#tabbar').innerHTML = P.toHtml(P.renderTabbar(route));
    P.$('#view').innerHTML = P.toHtml(page.body);
    document.title = page.title + ' · Parasol';
    P.$('#skip-link').textContent = t('shell.skip');
    P.$('#tabbar').setAttribute('aria-label', t('shell.mainNav'));
    if (view.mounted) view.mounted(route);
    var changed = !lastRoute || lastRoute.path !== route.path;
    if (changed) {
      if (!lastRoute || lastRoute.name !== route.name || route.name !== 'customer' || lastRoute.params[0] !== route.params[0]) window.scrollTo(0, 0);
      if (lastRoute) { var title = P.$('#page-title'); if (title) title.focus({ preventScroll: true }); }
    }
    lastRoute = route;
    P.markScrollEdges();
    P.charts.fit();
  };

  /* Re-render after a state change without moving focus away from the control the person used */
  app.refresh = function () {
    var active = document.activeElement;
    var key = active && active.getAttribute('data-focus');
    var y = window.scrollY;
    app.render();
    window.scrollTo(0, y);
    if (key) { var el = document.querySelector('[data-focus="' + key + '"]'); if (el) el.focus({ preventScroll: true }); }
    if (P.drawer.isOpen()) P.drawer.refresh();
  };

  /* Tables that scroll sideways get an edge shadow so hidden columns are discoverable */
  P.markScrollEdges = function () {
    P.$$('.table-wrap, .tabs').forEach(function (w) {
      var update = function () { w.classList.toggle('has-more-right', w.scrollLeft + w.clientWidth < w.scrollWidth - 4); };
      update();
      if (!w.dataset.edges) { w.dataset.edges = '1'; w.addEventListener('scroll', update, { passive: true }); }
    });
  };

  /* ---------- Global actions ---------- */

  P.on('toggle-rail', function () {
    if (window.innerWidth >= 1100) P.set({ railPref: P.state.railPref === 'mini' ? 'full' : 'mini' });
    else P.set({ railOpen: !P.state.railOpen });
  });
  P.on('close-rail', function () { P.set({ railOpen: false }); });
  /* The skip link must not touch the hash: the hash is the route */
  P.on('skip-to-main', function () { var main = P.$('#view'); main.focus(); main.scrollIntoView({ block: 'start' }); });
  P.on('toggle-theme', function () {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark' ||
      (P.state.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    P.set({ theme: dark ? 'light' : 'dark' });
  });
  P.on('set-theme', function (el) { P.popover.close(); P.set({ theme: el.dataset.value }); });
  P.on('set-density', function (el) { P.popover.close(); P.set({ density: el.dataset.value }); });
  P.on('set-lang', function (el) { P.popover.close(); P.drawer.close(); P.set({ lang: el.dataset.value }); });
  P.on('set-role', function (el) {
    P.popover.close();
    P.drawer.close();
    P.state.ui = {};
    P.set({ role: el.dataset.value });
    var route = P.parseRoute();
    var view = P.views[route.name];
    if (view && view.perm && !P.can(view.perm)) P.go('/day');
    P.toast(t('profile.roleChanged', { who: P.me().name, role: t(D.roles[P.state.role].label) }));
  });

  P.on('open-profile', function (el) {
    P.popover.open(el, P.profileMenu, { role: 'menu', align: 'start', title: P.me().name });
  });
  P.on('open-create', function (el) { P.popover.open(el, P.createMenu, { role: 'menu', title: t('shell.create') }); });
  P.on('open-notifications', function (el) {
    P.popover.open(el, P.notificationsPanel, { wide: true, title: t('shell.notifications'), foot: function () {
      return P.html`<button class="btn btn-sm" type="button" data-action="read-all">${P.icon('check', 'ic-16')}${t('notif.markAll')}</button>`;
    } });
  });
  P.on('read-all', function () {
    (D.notifications[P.me().id] || []).forEach(function (n) { n.unread = false; });
    P.popover.close(); P.drawer.close(); app.refresh();
  });
  P.on('read-notif', function (el) {
    var n = (D.notifications[P.me().id] || [])[Number(el.dataset.id)];
    if (n) n.unread = false;
    P.popover.close(); P.drawer.close();
    var href = el.getAttribute('href');
    if (href) P.go(href.slice(1));
  });
  P.on('open-more', function () {
    P.drawer.open(function () {
      var me = P.me();
      return P.sheet({ title: t('nav.more'), body: P.html`
        <div class="row">${P.ui$.avatar(me.id)}<div class="stack" style="gap:0"><strong>${me.name}</strong><span class="small muted">${t(D.roles[P.state.role].label)}</span></div></div>
        <nav class="menu" aria-label="${t('shell.mainNav')}">${P.nav().map(function (s) {
          return P.html`<p class="menu-label eyebrow">${t(s.label)}</p>${s.items.map(function (i) {
            return P.html`<a class="menu-item" href="#/${i.id}" data-action="nav-from-sheet">${P.icon(i.icon)}${t(i.label)}</a>`;
          })}`;
        })}</nav>
        ${P.profileMenu()}` });
    }, { label: t('nav.more') });
  });
  P.on('nav-from-sheet', function (el) { P.go(el.getAttribute('href').slice(1)); });
  P.on('demo-info', function (el) {
    P.popover.open(el, function () {
      return P.html`<div class="pop-body"><p>${t('demo.about')}</p><p class="small muted">${t('demo.aboutData')}</p>
        <button class="btn btn-sm" type="button" data-action="open-profile-from-info">${P.icon('users', 'ic-16')}${t('demo.switchRole')}</button></div>`;
    }, { title: t('shell.demoBadge') });
  });
  P.on('open-profile-from-info', function () {
    P.popover.close();
    var btn = P.$('.rail-user');
    if (btn && btn.offsetParent) P.actions['open-profile'](btn); else P.actions['open-more']();
  });
  P.on('open-shortcuts', function () {
    P.popover.close(); P.drawer.close();
    P.modal.open(function () {
      var rows = [['⌘K / Ctrl K', 'keys.palette'], ['/', 'keys.search'], ['N', 'keys.newTask'], ['T', 'keys.logTime'],
        ['G → D', 'keys.goDay'], ['G → O', 'keys.goObs'], ['G → C', 'keys.goCustomers'], ['G → V', 'keys.goTime'], ['Esc', 'keys.close']];
      return P.sheet({ title: t('profile.shortcuts'), body: P.html`<dl class="kv">${rows.map(function (r) {
        return P.html`<dt><span class="kbd">${r[0]}</span></dt><dd>${t(r[1])}</dd>`;
      })}</dl>` });
    }, { label: t('profile.shortcuts') });
  });

  /* ---------- Keyboard ---------- */

  var gPending = false;
  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    var typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); P.actions['open-palette'](); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey || P.drawer.isOpen() || P.modal.isOpen()) return;
    var k = e.key.toLowerCase();
    if (gPending) {
      gPending = false;
      var map = { d: '/day', o: '/observations', c: '/customers', v: '/time', t: '/tasks' };
      if (map[k]) { e.preventDefault(); P.go(map[k]); }
      return;
    }
    if (k === 'g') { gPending = true; setTimeout(function () { gPending = false; }, 1200); return; }
    if (k === '/') { e.preventDefault(); P.actions['open-palette'](); }
    if (k === 'n' && P.can('activities')) { e.preventDefault(); P.actions['new-task'](); }
    if (k === 't' && P.can('time.own')) { e.preventDefault(); P.actions['log-time'](); }
    if (k === '?') { e.preventDefault(); P.actions['open-shortcuts'](); }
  });

  /* ---------- Boot ---------- */

  function boot() {
    P.initOverlays();
    applyPrefs();
    P.subscribe(function () { applyPrefs(); app.refresh(); });
    window.addEventListener('hashchange', function () { P.memPath = null; P.popover.close(); if (P.drawer.isOpen()) P.drawer.close(); app.render(); });
    var resizeTimer = null;
    var lastWide = window.innerWidth >= 1100;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        var wide = window.innerWidth >= 1100;
        if (wide !== lastWide) { lastWide = wide; P.state.railOpen = false; app.refresh(); } else { applyRail(); P.markScrollEdges(); }
      }, 120);
    });
    window.addEventListener('scroll', function () {
      document.body.classList.toggle('is-scrolled', window.scrollY > 4);
    }, { passive: true });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { if (P.state.theme === 'system') app.refresh(); });
    app.render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
