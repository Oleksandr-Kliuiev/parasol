/* Parasoll UX demo: navigation rail, top bar, phone tab bar, profile/demo menu and notifications.
   Navigation is grouped by work, not by module, and only shows what the current role may open. */
(function () {
  'use strict';

  var P = window.P;
  var h = P.html;
  var t = P.t;
  var D = P.data;
  var M = P.model;
  var UI = P.ui$;

  P.nav = function () {
    var urgent = P.can('service') ? M.urgentUnassigned().length : 0;
    var today = M.openTasks().filter(function (x) { return x.due && (x.due < P.NOW || P.sameDay(x.due, P.NOW)); }).length;
    var sections = [
      { label: 'nav.work', items: [
        { id: 'day', icon: 'sun', label: 'nav.day' },
        { id: 'alerts', icon: 'pulse', label: 'nav.alerts', perm: 'service', count: urgent, hot: true, hint: 'nav.alertsHint' },
        { id: 'tasks', icon: 'tasks', label: 'nav.tasks', perm: 'activities', count: today, hint: 'nav.tasksHint' },
        { id: 'time', icon: 'clock', label: 'nav.time', perm: 'time.own' }
      ] },
      { label: 'nav.clients', items: [
        { id: 'customers', icon: 'building', label: 'nav.customers' },
        { id: 'contracts', icon: 'contract', label: 'nav.contracts', perm: 'contracts' },
        { id: 'sales', icon: 'trend', label: 'nav.sales', perm: 'sales' },
        { id: 'projects', icon: 'kanban', label: 'nav.projects', perm: 'projects' }
      ] },
      { label: 'nav.money', items: [
        { id: 'billing', icon: 'receipt', label: 'nav.billing', perm: 'billing' },
        { id: 'invoices', icon: 'files', label: 'nav.invoices', perm: 'billing' },
        { id: 'reports', icon: 'chart', label: 'nav.reports', perm: 'reports' }
      ] },
      { label: 'nav.system', items: [
        { id: 'connections', icon: 'plug', label: 'nav.connections', perm: 'service' },
        { id: 'admin', icon: 'sliders', label: 'nav.admin', perm: 'admin' }
      ] }
    ];
    return sections.map(function (s) {
      return { label: s.label, items: s.items.filter(function (i) { return !i.perm || P.can(i.perm); }) };
    }).filter(function (s) { return s.items.length; });
  };

  P.navId = function (route) {
    return { customer: 'customers' }[route.name] || route.name;
  };

  function navItem(item, current) {
    var label = t(item.label);
    var count = item.count ? h`<span class="nav-count ${item.hot ? 'is-hot' : ''}" aria-label="${t(item.hint, { n: item.count })}">${P.fmt.num(item.count)}</span>` : '';
    return h`<a class="nav-item" href="#/${item.id}" title="${label}" ${current === item.id ? P.raw('aria-current="page"') : ''}>${P.icon(item.icon)}<span class="nav-text">${label}</span>${count}</a>`;
  }

  P.renderRail = function (route) {
    var me = P.me();
    var current = P.navId(route);
    var mini = document.querySelector('.app').getAttribute('data-rail') === 'mini';
    return h`
      <div class="rail-brand">
        <span class="brand-mark">${P.icon('umbrella')}</span>
        <span class="brand-text"><span class="brand-name">Parasoll</span><span class="brand-sub">Vardahei AS</span></span>
        <button class="icon-btn is-sm on-rail rail-collapse" type="button" data-action="toggle-rail"
          aria-label="${mini ? t('shell.expandNav') : t('shell.collapseNav')}" title="${mini ? t('shell.expandNav') : t('shell.collapseNav')}">${P.icon(mini ? 'chevronRight' : 'chevronLeft', 'ic-16')}</button>
      </div>
      <button class="rail-search" type="button" data-action="open-palette" aria-label="${t('shell.search')}" title="${t('shell.search')}">
        ${P.icon('search', 'ic-16')}<span>${t('shell.search')}</span><span class="kbd">${navigator.platform.indexOf('Mac') !== -1 ? '⌘K' : 'Ctrl K'}</span>
      </button>
      <nav class="rail-scroll" aria-label="${t('shell.mainNav')}">
        ${P.nav().map(function (s) {
          return h`<div class="nav-section"><p class="nav-label">${t(s.label)}</p>${s.items.map(function (i) { return navItem(i, current); })}</div>`;
        })}
      </nav>
      <button class="rail-user" type="button" data-action="open-profile" aria-haspopup="menu" aria-expanded="false" title="${me.name}">
        ${UI.avatar(me.id)}
        <span class="who"><strong>${me.name}</strong><span>${t(D.roles[P.state.role].label)}</span></span>
        ${P.icon('upDown', 'ic-16')}
      </button>`;
  };

  P.renderTabbar = function (route) {
    var current = P.navId(route);
    var nav = [].concat.apply([], P.nav().map(function (s) { return s.items; }));
    var want = ['day', 'alerts', 'customers', 'time'].map(function (id) {
      return nav.filter(function (i) { return i.id === id; })[0];
    }).filter(Boolean);
    var inMore = want.every(function (i) { return i.id !== current; });
    return h`${want.map(function (i) {
      return h`<a class="tab-link" href="#/${i.id}" ${i.id === current ? P.raw('aria-current="page"') : ''}>${P.icon(i.icon)}${i.count ? h`<span class="nav-count ${i.hot ? 'is-hot' : ''}">${P.fmt.num(i.count)}</span>` : ''}<span>${t(i.label + 'Short')}</span></a>`;
    })}<button class="tab-link" type="button" data-action="open-more" ${inMore ? P.raw('aria-current="page"') : ''}>${P.icon('menu')}<span>${t('nav.more')}</span></button>`;
  };

  P.renderTopbar = function (route, crumbs) {
    var unread = (D.notifications[P.me().id] || []).some(function (n) { return n.unread; });
    var dark = document.documentElement.getAttribute('data-theme') === 'dark' ||
      (P.state.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var last = crumbs[crumbs.length - 1];
    return h`
      <nav class="crumbs" aria-label="${t('shell.breadcrumbs')}">
        ${crumbs.map(function (c, i) {
          var isLast = i === crumbs.length - 1;
          return h`${i ? P.icon('chevronRight', 'ic-14') : ''}${isLast ? h`<span aria-current="page">${c.label}</span>` : h`<a href="${c.href}">${c.label}</a>`}`;
        })}
      </nav>
      <p class="topbar-mobile-title">${last.label}</p>
      <div class="topbar-tools">
        <button class="pill pill-accent hide-phone" type="button" data-action="demo-info" style="border:0">${P.icon('flask', 'ic-14')}${t('shell.demoBadge')}</button>
        <button class="icon-btn is-quiet show-phone" type="button" data-action="open-palette" aria-label="${t('shell.search')}" title="${t('shell.search')}">${P.icon('search')}</button>
        <button class="icon-btn hide-phone" type="button" data-action="toggle-theme" aria-label="${dark ? t('shell.lightTheme') : t('shell.darkTheme')}" title="${dark ? t('shell.lightTheme') : t('shell.darkTheme')}">${P.icon(dark ? 'sun' : 'moon')}</button>
        <button class="icon-btn" type="button" data-action="open-notifications" aria-haspopup="dialog" aria-expanded="false"
          aria-label="${unread ? t('shell.notificationsUnread') : t('shell.notifications')}" title="${t('shell.notifications')}">${P.icon('bell')}${unread ? h`<span class="bell-dot"></span>` : ''}</button>
        <button class="btn create-btn" type="button" data-action="open-create" aria-haspopup="menu" aria-expanded="false" aria-label="${t('shell.create')}">${P.icon('plus')}<span class="hide-phone">${t('shell.create')}</span></button>
      </div>`;
  };

  /* ---------- Menus ---------- */

  function radio(action, value, current, label, sub) {
    var on = value === current;
    return h`<button class="menu-item" type="button" role="menuitemradio" aria-checked="${on ? 'true' : 'false'}" data-action="${action}" data-value="${value}">
      <span>${label}${sub ? h`<span class="menu-sub">${sub}</span>` : ''}</span>${on ? h`<span class="check-mark">${P.icon('check', 'ic-16')}</span>` : ''}</button>`;
  }

  P.profileMenu = function () {
    var roles = Object.keys(D.roles);
    return h`<div class="menu" role="menu">
      <p class="menu-label eyebrow">${t('profile.viewAs')}</p>
      ${roles.map(function (r) { var s = D.staff[D.roles[r].staff]; return radio('set-role', r, P.state.role, s.name, t(D.roles[r].label)); })}
      <div class="menu-sep"></div>
      <p class="menu-label eyebrow">${t('profile.language')}</p>
      ${P.languages.map(function (l) { return radio('set-lang', l.code, P.state.lang, l.label); })}
      <div class="menu-sep"></div>
      <p class="menu-label eyebrow">${t('profile.theme')}</p>
      ${['system', 'light', 'dark'].map(function (v) { return radio('set-theme', v, P.state.theme, t('theme.' + v)); })}
      <div class="menu-sep"></div>
      <p class="menu-label eyebrow">${t('profile.density')}</p>
      ${['comfortable', 'compact'].map(function (v) { return radio('set-density', v, P.state.density, t('density.' + v)); })}
      <div class="menu-sep"></div>
      <button class="menu-item" type="button" role="menuitem" data-action="open-shortcuts">${P.icon('keyboard')}${t('profile.shortcuts')}</button>
      <button class="menu-item" type="button" role="menuitem" disabled>${P.icon('logout')}<span>${t('profile.signOut')}<span class="menu-sub">${t('profile.signOutDemo')}</span></span></button>
    </div>`;
  };

  P.createMenu = function () {
    return h`<div class="menu" role="menu">
      ${P.can('activities') ? h`<button class="menu-item" type="button" role="menuitem" data-action="new-task">${P.icon('tasks')}<span>${t('create.task')}<span class="menu-sub">N</span></span></button>` : ''}
      ${P.can('time.own') ? h`<button class="menu-item" type="button" role="menuitem" data-action="log-time">${P.icon('timer')}<span>${t('create.time')}<span class="menu-sub">T</span></span></button>` : ''}
      <button class="menu-item" type="button" role="menuitem" disabled>${P.icon('ticket')}<span>${t('create.ticket')}<span class="menu-sub">${t('create.ticketOff')}</span></span></button>
      <button class="menu-item" type="button" role="menuitem" disabled>${P.icon('building')}<span>${t('create.customer')}<span class="menu-sub">${t('create.notInDemo')}</span></span></button>
    </div>`;
  };

  function notifText(n) {
    var c = n.customer ? D.customer(n.customer).name : '';
    switch (n.kind) {
      case 'assigned': return { icon: 'tasks', title: t('notif.assigned', { who: D.staff[n.from].name }), text: c, href: '#/tasks' };
      case 'bankLow': return { icon: 'hourglass', title: t('notif.bankLow', { customer: c }), text: t('bank.left', { left: P.fmt.num(n.left), size: P.fmt.num(n.size) }), href: '#/customers/' + n.customer + '/contract' };
      case 'weekShort': return { icon: 'clock', title: t('notif.weekShort', { week: n.week }), text: t('notif.weekShortText', { hours: P.fmt.hours(n.missing) }), href: '#/time' };
      case 'approvals': return { icon: 'listChecks', title: t('notif.approvals', { n: n.count, who: D.staff[n.staff].name }), text: t('notif.weekHours', { week: n.week, hours: P.fmt.hours(n.hours) }), href: '#/time/approve' };
      case 'ticketQuiet': return { icon: 'ticket', title: t('notif.ticketQuiet', { id: n.ticket, n: n.days }), text: c, href: '#/customers/' + n.customer + '/work' };
      case 'overdue': return { icon: 'files', title: t('notif.overdue', { no: n.invoice }), text: c, href: '#/customers/' + n.customer + '/finance' };
      case 'exportErrors': return { icon: 'send', title: t('notif.exportErrors'), text: t('notif.exportErrorsText', { failed: n.failed, reconcile: n.reconcile }), href: '#/billing' };
      case 'notice': return { icon: 'contract', title: t('notif.notice', { contract: n.contract }), text: c + ' · ' + P.fmt.date(n.date), href: '#/contracts' };
      default: return { icon: 'bell', title: n.kind, text: '', href: '#/day' };
    }
  }

  P.notificationsPanel = function () {
    var list = D.notifications[P.me().id] || [];
    return h`<div>
      ${list.length ? list.map(function (n, i) {
        var x = notifText(n);
        return h`<a class="notif ${n.unread ? 'is-unread' : ''}" href="${x.href}" data-action="read-notif" data-id="${i}">
          <span class="tl-icon">${P.icon(x.icon, 'ic-16')}</span>
          <span class="notif-text"><strong>${x.title}</strong><span class="small muted" style="display:block">${x.text}${x.text ? ' · ' : ''}${P.fmt.ago(n.at)}</span></span></a>`;
      }) : UI.empty('bell', t('notif.empty'), '')}
    </div>`;
  };
})();
