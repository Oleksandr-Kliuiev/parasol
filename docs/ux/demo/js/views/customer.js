/* Parasoll UX demo: customer card. The header answers "who, what agreement, how healthy, what is owed";
   tabs follow the work (technical, work, finance, agreement) instead of the source modules. */
(function () {
  'use strict';

  var P = window.P;
  var h = P.html;
  var t = P.t;
  var D = P.data;
  var M = P.model;
  var UI = P.ui$;
  var R = P.rows;

  P.customerTabs = {};

  function tabsFor(c) {
    var urgent = D.canSee(c.id) ? P.views.customers.urgentFor(c).length : null;
    var open = D.tasks.filter(function (x) { return x.customer === c.id && x.status === 'Open'; }).length;
    return [
      { id: 'overview', label: t('ctab.overview') },
      { id: 'technical', label: t('ctab.technical'), count: urgent || null },
      { id: 'work', label: t('ctab.work'), count: open || null },
      P.can('billing') && { id: 'finance', label: t('ctab.finance') },
      P.can('contracts') && { id: 'contract', label: t('ctab.contract') },
      { id: 'contacts', label: t('ctab.contacts') },
      { id: 'journal', label: t('ctab.journal') }
    ].filter(Boolean);
  }

  function header(c) {
    var k = D.contractOf(c.id);
    var sla = k ? D.slaPolicies[k.sla] : null;
    var m365 = D.m365[c.id];
    var out = P.views.customers.outstandingFor(c);
    var overdue = D.invoices.filter(function (x) { return x.customer === c.id && D.invoiceStatus(x) === 'Overdue'; }).length;
    return h`<section class="card cust-head" aria-labelledby="page-title">
      <div class="cust-head-main">
        ${UI.custAvatar(c, 'is-lg')}
        <div class="cust-head-text">
          <h1 class="page-title" id="page-title" tabindex="-1">${c.name}</h1>
          <p class="muted num">${t('customer.orgnr')} ${c.orgnr} · ${c.city} · ${P.L(c.sector)}</p>
          <div class="row-wrap">
            <span class="pill pill-outline">${t('status.' + c.status)}</span>
            ${k ? h`<span class="pill pill-outline">${P.icon('contract', 'ic-14')}${k.id} · ${k.name}</span>` : ''}
            ${sla ? h`<span class="pill pill-outline">${P.icon('clock', 'ic-14')}${t('sla.short', { win: k.sla.replace('x', '×'), p1: sla.p1 })}</span>` : ''}
            ${c.atlas === 'READY' ? h`<span class="pill pill-good">${P.icon('link', 'ic-14')}${t('cust.atlasLinked')}</span>` : h`<span class="pill pill-warn">${P.icon('link', 'ic-14')}${t('cust.atlasNotLinked')}</span>`}
          </div>
        </div>
        <div class="page-actions cust-actions">
          ${P.can('time.own') ? h`<button class="btn" type="button" data-action="log-time">${P.icon('timer', 'ic-16')}${t('create.time')}</button>` : ''}
          ${P.can('activities') ? h`<button class="btn btn-primary" type="button" data-action="new-task">${P.icon('plus', 'ic-16')}${t('create.task')}</button>` : ''}
        </div>
      </div>
      <dl class="facts cust-facts">
        <div class="fact"><dt>${t('cust.am')}</dt><dd>${UI.person(c.am)}</dd></div>
        <div class="fact"><dt>${t('cust.tech')}</dt><dd>${UI.person(c.tech)}</dd></div>
        <div class="fact"><dt>${t('cust.devices')}</dt><dd>${c.atlas !== 'READY' ? t('cust.noAtlas') : D.canSee(c.id) ? h`<span class="num">${P.fmt.num(D.devicesOf(c.id).length)}</span>` : h`<span class="locked">${P.icon('lock', 'ic-14')}${t('perm.noAtlas')}</span>`}</dd></div>
        <div class="fact"><dt>${t('cust.m365')}</dt><dd>${m365 && D.canSee(c.id) ? t('m365.usersShort', { n: m365.users }) : h`<span class="muted">${t('m365.none')}</span>`}</dd></div>
        <div class="fact"><dt>${t('cust.bank')}</dt><dd>${UI.bank(c.hourBank, true)}</dd></div>
        <div class="fact"><dt>${t('cust.outstanding')}</dt><dd>${out ? h`${UI.money(out)}${overdue && P.can('finance') ? h` <span class="pill pill-crit">${t('fin.overdueN', { n: overdue })}</span>` : ''}` : P.can('finance') ? t('fin.nothing') : UI.money(0)}</dd></div>
      </dl>
    </section>`;
  }

  /* ---------- Overview ---------- */

  P.customerTabs.overview = function (c) {
    var urgent = D.canSee(c.id) ? M.sortObs(P.views.customers.urgentFor(c)) : [];
    var tasks = M.sortTasks(D.tasks.filter(function (x) { return x.customer === c.id && x.status === 'Open'; }));
    var tickets = D.ticketsOf(c.id).filter(function (x) { return x.status === 'Open' || x.status === 'Pending'; });
    var m365 = D.m365[c.id];
    var month = D.time.filter(function (e) { return e.customer === c.id && e.date.getMonth() === 9; });
    var left = h`
      ${UI.card({ title: t('cust.now'), icon: 'pulse', titleId: 'co-now', count: urgent.length,
        tools: c.atlas === 'READY' && D.canSee(c.id) ? h`<a class="btn btn-link" href="#/customers/${c.id}/technical">${t('cust.allTechnical')}</a>` : '',
        body: c.atlas !== 'READY' ? UI.empty('link', t('cust.noAtlasTitle'), t('cust.noAtlasText'))
          : !D.canSee(c.id) ? UI.empty('lock', t('perm.noAtlasTitle'), t('perm.atlasHint'))
          : urgent.length ? h`<div class="rows">${urgent.map(function (o) { return R.obsRow(o, { hideCustomer: true }); })}</div>`
          : UI.empty('shieldCheck', t('cust.noUrgentTitle'), t('cust.noUrgentText')),
        foot: c.atlas === 'READY' && D.canSee(c.id) ? h`<span>${t('day.kAtlasRead', { time: P.fmt.time(D.atlasReadAt) })}</span>` : '' })}
      ${UI.card({ title: t('cust.openWork'), icon: 'tasks', titleId: 'co-work', count: tasks.length + tickets.length,
        tools: h`<a class="btn btn-link" href="#/customers/${c.id}/work">${t('cust.allWork')}</a>`,
        body: tasks.length || tickets.length ? h`<div class="rows">${tasks.map(function (x) { return R.taskRow(x, { hideCustomer: true, showAssignee: true }); })}${tickets.filter(function (tk) {
          return !tasks.some(function (x) { return x.ticket === tk.id; });
        }).map(R.ticketRow)}</div>` : UI.empty('tasks', t('cust.noWork'), ''),
        foot: h`<span>${t('day.ticketsSaved', { time: P.fmt.time(D.ticketsReadAt) })}</span>` })}`;
    var right = h`
      ${UI.card({ title: t('cust.bankCard'), icon: 'hourglass', titleId: 'co-bank',
        body: c.hourBank ? h`${UI.bank(c.hourBank)}<p class="small muted">${t('cust.bankMonth', { hours: P.fmt.hours(M.sumHours(month)) })}</p>
          ${UI.bankState(c.hourBank) === 'is-crit' ? UI.banner('warn', t('cust.bankLowTitle'), t('cust.bankLowText')) : ''}` : h`<p class="muted">${t('cust.noBankText')}</p>` })}
      ${UI.card({ title: t('cust.m365Card'), icon: 'cloud', titleId: 'co-m365',
        body: m365 && D.canSee(c.id) ? h`<dl class="kv"><dt>${t('m365.users')}</dt><dd class="num">${P.fmt.num(m365.users)}</dd>
            <dt>${t('m365.registrations')}</dt><dd class="num">${P.fmt.num(m365.registrations)}</dd>
            <dt>${t('m365.signins')}</dt><dd>${t('m365.coverage.' + m365.coverage)}</dd>
            <dt>${t('m365.asOf')}</dt><dd>${UI.fresh(P.dayDiff(P.NOW, m365.asOf) > 0 ? 'STALE' : 'OK', m365.asOf)}</dd></dl>
          <p class="small muted">${t('m365.note')}</p>` : h`<p class="muted">${t('m365.noneText')}</p>` })}
      ${P.can('billing') ? UI.card({ title: t('cust.finCard'), icon: 'wallet', titleId: 'co-fin', body: finSummary(c),
        tools: h`<a class="btn btn-link" href="#/customers/${c.id}/finance">${t('ctab.finance')}</a>`,
        foot: h`<span>${t('fin.syncedAt', { time: P.fmt.time(D.financeReadAt) })}</span>` }) : ''}`;
    return h`<div class="split"><div class="stack-4">${left}</div><div class="stack-4">${right}</div></div>`;
  };

  function finSummary(c) {
    var inv = D.invoicesOf(c.id).filter(function (x) { return x.kind === 'Invoice'; });
    var last = inv[0];
    var out = P.views.customers.outstandingFor(c);
    return h`<dl class="kv"><dt>${t('fin.outstanding')}</dt><dd>${UI.money(out)}</dd>
      ${last ? h`<dt>${t('fin.lastInvoice')}</dt><dd><span class="num">${last.no}</span> · ${P.fmt.date(last.date)}</dd>
      <dt>${t('fin.status')}</dt><dd>${P.views.finance.statusPill(last)}</dd>` : ''}</dl>`;
  }

  P.views.customer = {
    render: function (route) {
      var c = D.customer(route.params[0]);
      if (!c) return P.views.missing.render(route);
      var tabs = tabsFor(c);
      var tab = route.params[1] && tabs.some(function (x) { return x.id === route.params[1]; }) ? route.params[1] : 'overview';
      var active = tabs.filter(function (x) { return x.id === tab; })[0];
      return {
        title: c.name + (tab !== 'overview' ? ' · ' + active.label : ''),
        crumbs: [{ label: t('nav.customers'), href: '#/customers' }, { label: c.name, href: '#/customers/' + c.id }].concat(tab !== 'overview' ? [{ label: active.label }] : []),
        body: h`<a class="back-link" href="#/customers">${P.icon('arrowLeft', 'ic-16')}${t('nav.customers')}</a>
          ${header(c)}
          ${UI.tabs(tabs, tab, '#/customers/' + c.id + '/')}
          <div class="tab-panel">${P.customerTabs[tab](c)}</div>`
      };
    }
  };
})();
