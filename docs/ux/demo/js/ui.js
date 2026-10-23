/* Parasol UX demo: shared view components. Every state carries a word and an icon, not colour alone. */
(function () {
  'use strict';

  var P = window.P;
  var h = P.html;
  var t = P.t;
  var D = P.data;
  var UI = (P.ui$ = {});

  var SEV = {
    CRITICAL: { cls: 'pill-crit', icon: 'octagon', rail: 'is-crit' },
    HIGH: { cls: 'pill-high', icon: 'triangle', rail: 'is-high' },
    MEDIUM: { cls: 'pill-med', icon: 'alert', rail: 'is-med' },
    LOW: { cls: '', icon: 'minusCircle', rail: '' },
    INFO: { cls: '', icon: 'info', rail: '' }
  };
  UI.SEV = SEV;

  UI.sev = function (sev) {
    var s = SEV[sev];
    return h`<span class="pill ${s.cls}">${P.icon(s.icon, 'ic-14')}${t('sev.' + sev)}</span>`;
  };

  UI.obsStatus = function (status) {
    var map = { OPEN: ['pill-outline', 'circleDashed'], ACKNOWLEDGED: ['pill-outline', 'eye'], RESOLVED: ['pill-good', 'circleCheck'], SUPPRESSED: ['', 'minusCircle'] };
    var m = map[status];
    return h`<span class="pill ${m[0]}">${P.icon(m[1], 'ic-14')}${t('obsStatus.' + status)}</span>`;
  };

  UI.kind = function (kind) {
    return h`<span class="row small muted">${P.icon(kind === 'SECURITY_INCIDENT' ? 'shield' : 'disk', 'ic-14')}${t('kind.' + kind)}</span>`;
  };

  /* Freshness of one source: OK / STALE / ERROR / MISSING / UNAVAILABLE / FIXTURE */
  UI.fresh = function (status, asOf) {
    var map = {
      OK: ['pill-good', 'circleCheck'], STALE: ['pill-warn', 'clock'], ERROR: ['pill-crit', 'circleX'],
      MISSING: ['pill-outline', 'circleDashed'], UNAVAILABLE: ['pill-outline', 'minusCircle'], FIXTURE: ['pill-accent', 'flask']
    };
    var m = map[status] || map.MISSING;
    var when = asOf ? ' · ' + (P.sameDay(asOf, P.NOW) ? P.fmt.time(asOf) : P.fmt.when(asOf)) : '';
    return h`<span class="pill ${m[0]}">${P.icon(m[1], 'ic-14')}${t('fresh.' + status)}${when}</span>`;
  };

  UI.avatar = function (who, cls) {
    var s = typeof who === 'string' ? D.staff[who] : who;
    if (!s) return '';
    return h`<span class="avatar ${cls || ''}" style="--av: var(--av-${s.av}); --av-ink: var(--av-${s.av}-ink)" title="${s.name}" aria-hidden="true">${s.initials}</span>`;
  };

  UI.custAvatar = function (c, cls) {
    var letters = c.name.replace(/[^A-Za-zÆØÅæøå ]/g, '').split(' ').filter(Boolean);
    var ini = (letters[0].charAt(0) + (letters[1] ? letters[1].charAt(0) : '')).toUpperCase();
    return h`<span class="avatar is-square ${cls || ''}" style="--av: var(--av-${c.av}); --av-ink: var(--av-${c.av}-ink)" aria-hidden="true">${ini}</span>`;
  };

  UI.person = function (id) {
    var s = D.staff[id];
    return s ? h`<span class="row">${UI.avatar(id, 'is-sm')}<span>${s.name}</span></span>` : '';
  };

  /* Money is shown only with finance.read; otherwise say why it is missing instead of leaving a gap */
  UI.money = function (n, opts) {
    if (!P.can('finance')) {
      return h`<span class="locked" title="${t('perm.moneyHint')}">${P.icon('lock', 'ic-14')}${t('perm.hidden')}</span>`;
    }
    var cls = opts && opts.cls ? opts.cls : '';
    return h`<span class="num ${cls}">${P.fmt.money(n)}</span>`;
  };

  UI.hours = function (n) { return h`<span class="num">${P.fmt.hours(n)}</span>`; };

  /* Hour bank meter: warning under 35 %, critical under the 20 % rule */
  UI.bankState = function (bank) {
    var r = bank.left / bank.size;
    return r < 0.2 ? 'is-crit' : r < 0.35 ? 'is-warn' : '';
  };
  UI.bank = function (bank, compact) {
    if (!bank) return h`<span class="muted small">${t('bank.none')}</span>`;
    var pct = Math.max(0, Math.min(1, bank.left / bank.size));
    var label = t('bank.left', { left: P.fmt.num(bank.left), size: P.fmt.num(bank.size) });
    return h`<div class="meter-row" style="min-width:${compact ? 168 : 160}px">
      <div class="meter-label"><span class="strong num">${label}</span>${compact ? '' : h`<span class="muted num">${P.fmt.pct(pct)}</span>`}</div>
      <div class="meter ${UI.bankState(bank)}" role="img" aria-label="${label}"><span style="width:${(pct * 100).toFixed(1)}%"></span></div>
    </div>`;
  };

  UI.customerLink = function (id, cls) {
    var c = D.customer(id);
    if (!c) return h`<span class="muted">${t('common.internal')}</span>`;
    return h`<a class="${cls || 'link-plain'}" href="#/customers/${c.id}">${c.name}</a>`;
  };

  UI.taskSubject = function (task) {
    return task.subject === 'generic' ? t('task.genericSubject') : P.L(task.subject);
  };

  /* The observation behind a task, resolved at render time for people with Atlas access */
  UI.taskSource = function (task) {
    if (!task.source) return '';
    var o = D.observation(task.source);
    if (!P.can('atlas') || !D.canSee(task.customer)) {
      return h`<span class="locked">${P.icon('lock', 'ic-14')}${t('task.sourceHidden')}</span>`;
    }
    var dev = o.device ? D.devices.filter(function (d) { return d.id === o.device; })[0] : null;
    return h`<span class="row-wrap">${UI.sev(o.severity)}<span class="ink-2 small break">${o.summary}${dev ? ' · ' + dev.host : ''}</span></span>`;
  };

  UI.due = function (task) {
    if (task.status === 'Done') return h`<span class="item-time">${P.icon('check', 'ic-14')}</span>`;
    if (!task.due) return h`<span class="item-time muted">${t('task.noDue')}</span>`;
    var late = task.due < P.NOW;
    var sameDay = P.sameDay(task.due, P.NOW);
    var text = sameDay ? P.fmt.time(task.due) : P.fmt.when(task.due);
    return h`<span class="item-time ${late ? 'is-late' : ''}" title="${late ? t('task.overdue') : t('task.due')}">${late ? h`<span class="sr-only">${t('task.overdue')}: </span>` : ''}${text}</span>`;
  };

  UI.ticketTag = function (id) {
    if (!id) return '';
    return h`<button class="tag is-link" type="button" data-action="open-ticket" data-id="${id}">${P.icon('ticket', 'ic-14')}#${id}</button>`;
  };

  UI.typeIcon = function (type) {
    return { Task: 'tasks', Call: 'phone', Meeting: 'users', Note: 'note', Email: 'mail' }[type] || 'tasks';
  };

  UI.card = function (o) {
    return h`<section class="card ${o.cls || ''}" ${o.id ? P.raw('id="' + P.escape(o.id) + '"') : ''} ${o.titleId ? P.raw('aria-labelledby="' + P.escape(o.titleId) + '"') : ''}>
      ${o.title ? h`<header class="card-head">
        <h2 class="card-title" ${o.titleId ? P.raw('id="' + P.escape(o.titleId) + '"') : ''}>${o.icon ? P.icon(o.icon) : ''}<span>${o.title}</span>${o.count != null ? h`<span class="pill pill-outline num">${o.count}</span>` : ''}</h2>
        ${o.tools ? h`<div class="card-tools">${o.tools}</div>` : ''}
      </header>` : ''}
      <div class="card-body ${o.flush ? 'is-flush' : ''}">${o.body}</div>
      ${o.foot ? h`<footer class="card-foot">${o.foot}</footer>` : ''}
    </section>`;
  };

  /* A tile is a link (href), a filter button (action) or plain information; only the first two show an arrow */
  UI.kpi = function (o) {
    var inner = h`<div class="kpi-top"><span class="kpi-icon ${o.tone || ''}">${P.icon(o.icon)}</span>${o.href || o.action ? P.icon(o.action ? 'filter' : 'arrowUpRight', 'ic-16 kpi-arrow') : ''}</div>
      <div class="kpi-main"><span class="kpi-label">${o.label}</span><span class="kpi-value">${o.value}${o.unit ? h`<small>${o.unit}</small>` : ''}</span></div>
      <div class="card-foot">${o.foot}</div>`;
    if (o.href) return h`<a class="card kpi" href="${o.href}">${inner}</a>`;
    if (o.action) return h`<button class="card kpi is-button" type="button" data-action="${o.action}" data-value="${o.value2}" aria-pressed="${o.pressed ? 'true' : 'false'}">${inner}</button>`;
    return h`<div class="card kpi is-static">${inner}</div>`;
  };

  UI.empty = function (icon, title, text, action) {
    return h`<div class="empty">${P.icon(icon)}<p class="empty-title">${title}</p>${text ? h`<p>${text}</p>` : ''}${action || ''}</div>`;
  };

  UI.banner = function (kind, title, text, actions, icon) {
    var ic = icon || { warn: 'triangle', crit: 'octagon', info: 'info', good: 'circleCheck' }[kind] || 'info';
    return h`<div class="banner is-${kind}" role="${kind === 'crit' ? 'alert' : 'status'}">${P.icon(ic)}
      <div><p class="banner-title">${title}</p>${text ? h`<p>${text}</p>` : ''}${actions ? h`<div class="banner-actions">${actions}</div>` : ''}</div><span></span></div>`;
  };

  UI.chip = function (action, value, label, count, pressed, dot) {
    return h`<button class="chip" type="button" data-action="${action}" data-value="${value}" data-focus="${action}-${value}" aria-pressed="${pressed ? 'true' : 'false'}">
      ${dot ? h`<span class="dot" style="background:${dot}"></span>` : ''}${label}${count != null ? h`<span class="count">${P.fmt.num(count)}</span>` : ''}</button>`;
  };

  UI.seg = function (action, options, value, label) {
    return h`<div class="seg" role="group" aria-label="${label || ''}">${options.map(function (o) {
      return h`<button type="button" data-action="${action}" data-value="${o.value}" data-focus="${action}-${o.value}" aria-pressed="${o.value === value ? 'true' : 'false'}">${o.label}${o.count != null ? h`<span class="count">${P.fmt.num(o.count)}</span>` : ''}</button>`;
    })}</div>`;
  };

  UI.tabs = function (items, active, base) {
    return h`<nav class="tabs" aria-label="${t('common.sections')}">${items.map(function (it) {
      return h`<a class="tab" href="${base + it.id}" ${it.id === active ? P.raw('aria-current="page"') : ''}>${it.icon ? P.icon(it.icon, 'ic-16') : ''}${it.label}${it.count != null ? h`<span class="count num">${P.fmt.num(it.count)}</span>` : ''}</a>`;
    })}</nav>`;
  };

  UI.pageHead = function (o) {
    return h`<header class="page-head">
      <div class="page-head-text">${o.back || ''}<h1 class="page-title" id="page-title" tabindex="-1">${o.title}</h1>${o.sub ? h`<p class="page-sub">${o.sub}</p>` : ''}</div>
      ${o.actions ? h`<div class="page-actions">${o.actions}</div>` : ''}
    </header>`;
  };

  /* Source names and statuses for observations */
  UI.sourceName = function (s) { return t('src.' + s); };
})();
