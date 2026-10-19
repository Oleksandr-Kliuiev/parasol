/* Parasoll UX demo: lighter secondary pages (agreements, sales, projects, reports) and the
   "not found" / "no access" states, which say what is missing and where to go instead. */
(function () {
  'use strict';

  var P = window.P;
  var h = P.html;
  var t = P.t;
  var D = P.data;
  var M = P.model;
  var UI = P.ui$;

  function crumbs(key) { return [{ label: 'Parasoll', href: '#/day' }, { label: t(key) }]; }

  /* ---------- Agreements ---------- */

  function kMatch(k, mode) {
    var c = D.customer(k.customer);
    var days = P.dayDiff(k.notice, P.NOW);
    if (mode === 'renewal') return days >= 0 && days <= 60;
    if (mode === 'bank') return !!c.hourBank && c.hourBank.left / c.hourBank.size < 0.2;
    return true;
  }
  function kCount(mode) { return D.contracts.filter(function (k) { return kMatch(k, mode); }).length; }

  P.views.contracts = {
    perm: 'contracts',
    render: function () {
      var mode = P.state.ui.kMode || 'all';
      var list = D.contracts.filter(function (k) { return kMatch(k, mode); });
      var body = h`${UI.pageHead({ title: t('nav.contracts'), sub: t('k.sub', { n: D.contracts.length }) })}
        <div class="toolbar">${UI.seg('k-mode', [{ value: 'all', label: t('k.all'), count: kCount('all') }, { value: 'renewal', label: t('k.renewal'), count: kCount('renewal') }, { value: 'bank', label: t('k.bank'), count: kCount('bank') }], mode, t('k.filter'))}</div>
        ${UI.card({ flush: true, body: h`<div class="table-wrap"><table class="table"><caption class="sr-only">${t('nav.contracts')}</caption>
          <thead><tr><th scope="col">${t('k.col')}</th><th scope="col">${t('task.customer')}</th><th scope="col">${t('contract.notice')}</th><th scope="col">${t('contract.renewal')}</th><th scope="col">${t('cust.colBank')}</th><th scope="col" class="t-num">${t('contract.monthly')}</th></tr></thead>
          <tbody>${list.map(function (k) {
            var c = D.customer(k.customer);
            var days = P.dayDiff(k.notice, P.NOW);
            var total = k.lines.reduce(function (s, l) { return s + l.qty * l.unit; }, 0);
            return h`<tr><td><div class="cell-main"><a class="cell-title num" href="#/customers/${c.id}/contract">${k.id}</a><span class="cell-sub">${k.name} · SLA ${k.sla.replace('x', '×')}</span></div></td>
              <td>${c.name}</td><td class="nowrap num">${P.fmt.date(k.notice)}${days >= 0 && days <= 60 ? h` <span class="pill ${days <= 30 ? 'pill-warn' : 'pill-outline'}">${t('contract.inDays', { n: days })}</span>` : ''}</td>
              <td class="nowrap num">${P.fmt.date(k.renewal)}</td><td>${UI.bank(c.hourBank, true)}</td><td class="t-num">${UI.money(total)}</td></tr>`;
          })}</tbody></table></div><div class="list-foot"><span>${t('k.foot')}</span></div>` })}`;
      return { title: t('nav.contracts'), crumbs: crumbs('nav.contracts'), body: body };
    }
  };
  P.on('k-mode', function (el) { P.state.ui.kMode = el.dataset.value; P.app.refresh(); });

  /* ---------- Sales pipeline ---------- */

  var DEALS = [
    ['qualify', 'lindas', 'Microsoft 365 Business Premium', 38000, 18], ['qualify', 'c22', 'Managed Workstation', 64000, 40],
    ['quote', 'havbris', 'Klippekort 40 t', 46000, 9], ['quote', 'granlund', 'Backup Microsoft 365', 12400, 25],
    ['negotiate', 'fjordlys', 'Fornyelse K-2026-0001', 139000, 13], ['negotiate', 'c37', 'Managed Workstation', 52000, 30],
    ['won', 'skarvoy', 'Brannmur og Wi-Fi', 74500, -6]
  ];
  P.views.sales = {
    perm: 'sales',
    render: function () {
      var stages = ['qualify', 'quote', 'negotiate', 'won'];
      var body = h`${UI.pageHead({ title: t('nav.sales'), sub: t('sales.sub') })}
        <div class="kanban">${stages.map(function (s) {
          var deals = DEALS.filter(function (d) { return d[0] === s; });
          var sum = deals.reduce(function (x, d) { return x + d[3]; }, 0);
          return h`<section class="kanban-col" aria-labelledby="st-${s}"><header class="kanban-head"><h2 id="st-${s}" class="card-title">${t('sales.' + s)}</h2><span class="pill pill-outline num">${deals.length}</span><span class="spacer"></span><span class="small muted">${UI.money(sum)}</span></header>
            ${deals.map(function (d) {
              var c = D.customer(d[1]);
              var close = P.at(d[4]);
              return h`<article class="card deal-card"><p class="strong">${d[2]}</p><p class="small muted">${c.name}</p>
                <div class="row-wrap"><span class="strong">${UI.money(d[3])}</span><span class="spacer"></span><span class="small ${d[4] < 0 ? 'muted' : ''}">${s === 'won' ? t('sales.wonOn', { date: P.fmt.date(close) }) : t('sales.closes', { date: P.fmt.date(close) })}</span></div></article>`;
            })}</section>`;
        })}</div>
        <p class="footnote">${P.icon('info', 'ic-14')}${t('sales.foot')}</p>`;
      return { title: t('nav.sales'), crumbs: crumbs('nav.sales'), body: body };
    }
  };

  /* ---------- Projects ---------- */

  var PROJECTS = [
    ['P-2026-0004', 'granlund', 'Flytting av kontor', 120, 86, 'jonas'],
    ['P-2026-0006', 'nordlys', 'Ny Hyper-V-klynge', 80, 31, 'ingrid'],
    ['P-2026-0007', 'eikeli', 'Overgang til Intune', 60, 58.5, 'ingrid']
  ];
  P.views.projects = {
    perm: 'projects',
    render: function () {
      var body = h`${UI.pageHead({ title: t('nav.projects'), sub: t('proj.sub') })}
        ${UI.card({ body: h`<div class="rows">${PROJECTS.map(function (p) {
          var c = D.customer(p[1]);
          var ratio = p[4] / p[3];
          return h`<div class="item"><span class="tl-icon">${P.icon('kanban', 'ic-16')}</span>
            <div class="item-main"><span class="item-title"><span class="num">${p[0]}</span> · ${p[2]}</span><span class="small muted">${c.name} · ${D.staff[p[5]].name}</span>
              <div class="meter ${ratio > 0.9 ? 'is-warn' : 'is-ink'}" style="max-width:320px" role="img" aria-label="${t('proj.used', { used: P.fmt.num(p[4]), plan: P.fmt.num(p[3]) })}"><span style="width:${Math.min(100, ratio * 100).toFixed(0)}%"></span></div></div>
            <div class="item-side small num">${t('proj.used', { used: P.fmt.num(p[4]), plan: P.fmt.num(p[3]) })}</div></div>`;
        })}</div>`, foot: h`<span>${t('proj.foot')}</span>` })}`;
      return { title: t('nav.projects'), crumbs: crumbs('nav.projects'), body: body };
    }
  };

  /* ---------- Reports ---------- */

  P.views.reports = {
    perm: 'reports',
    render: function () {
      var staff = Object.keys(D.staff);
      var body = h`${UI.pageHead({ title: t('nav.reports'), sub: t('rep.sub') })}
        <div class="kpis kpis-3">
          ${UI.kpi({ icon: 'clock', label: t('rep.sla'), value: P.fmt.pct(0.94), foot: t('rep.slaFoot', { n: 2 }) })}
          ${UI.kpi({ icon: 'banknote', label: t('rep.billed'), value: UI.money(412850), foot: t('rep.billedFoot') })}
          ${UI.kpi({ href: '#/contracts', icon: 'hourglass', label: t('rep.banks'), value: P.fmt.num(M.lowBanks().length), foot: t('rep.banksFoot') })}
        </div>
        ${UI.card({ flush: true, title: t('rep.util'), icon: 'users', titleId: 'rp-util', body: h`<div class="table-wrap"><table class="table"><caption class="sr-only">${t('rep.util')}</caption>
          <thead><tr><th scope="col">${t('time.who')}</th><th scope="col" class="t-num">${t('rep.hours')}</th><th scope="col" class="t-num">${t('rep.billable')}</th><th scope="col">${t('rep.share')}</th></tr></thead>
          <tbody>${staff.map(function (s) {
            var list = M.timeFor(s, -7, -1);
            var all = M.sumHours(list);
            var bill = M.sumHours(list.filter(function (e) { return e.billable; }));
            var share = all ? bill / all : 0;
            return h`<tr><td>${UI.person(s)}</td><td class="t-num">${P.fmt.hours(all)}</td><td class="t-num">${P.fmt.hours(bill)}</td>
              <td><div class="row"><div class="meter is-ink" style="width:160px" role="img" aria-label="${P.fmt.pct(share)}"><span style="width:${(share * 100).toFixed(0)}%"></span></div><span class="small num">${P.fmt.pct(share)}</span></div></td></tr>`;
          })}</tbody></table></div><div class="list-foot"><span>${t('rep.foot', { week: 42 })}</span></div>` })}`;
      return { title: t('nav.reports'), crumbs: crumbs('nav.reports'), body: body };
    }
  };

  /* ---------- Not found and no access ---------- */

  P.views.missing = {
    render: function () {
      return { title: t('missing.title'), crumbs: [{ label: 'Parasoll', href: '#/day' }, { label: t('missing.title') }],
        body: UI.card({ body: UI.empty('search', t('missing.title'), t('missing.text'), h`<a class="btn btn-primary" href="#/day">${t('nav.day')}</a>`) }) };
    }
  };
  P.views.denied = {
    render: function (route, view) {
      return { title: t('denied.title'), crumbs: [{ label: 'Parasoll', href: '#/day' }, { label: t('denied.title') }],
        body: UI.card({ body: UI.empty('lock', t('denied.title'), t('denied.text', { perm: t('perm.name.' + view.perm), role: t(D.roles[P.state.role].label) }),
          h`<a class="btn btn-primary" href="#/day">${t('nav.day')}</a>`) }) };
    }
  };
})();
