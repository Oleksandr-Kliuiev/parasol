/* Parasoll UX demo: customer card. The header answers "who, what agreement, how healthy, what is owed";
   tabs follow the work (operations, work, finance, agreement) instead of the source modules. */
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
    var alerts = D.alertsOf(c.id).filter(D.isOpen).length;
    var open = D.tasks.filter(function (x) { return x.customer === c.id && x.status === 'Open'; }).length;
    return [
      { id: 'overview', label: t('ctab.overview') },
      { id: 'operations', label: t('ctab.operations'), count: alerts || null },
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
            ${c.atera === 'LINKED' ? h`<span class="pill pill-good">${P.icon('link', 'ic-14')}${t('cust.ateraLinked')}</span>` : h`<span class="pill pill-warn">${P.icon('link', 'ic-14')}${t('cust.noAtera')}</span>`}
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
        <div class="fact"><dt>${t('cust.devices')}</dt><dd>${c.atera !== 'LINKED' ? t('cust.noAtera') : h`<span class="num">${P.fmt.num(D.devicesOf(c.id).length)}</span>`}</dd></div>
        <div class="fact"><dt>${t('cust.openAlerts')}</dt><dd>${alertsFact(c)}</dd></div>
        <div class="fact"><dt>${t('cust.bank')}</dt><dd>${UI.bank(c.hourBank, true)}</dd></div>
        <div class="fact"><dt>${t('cust.outstanding')}</dt><dd>${out ? h`${UI.money(out)}${overdue && P.can('finance') ? h` <span class="pill pill-crit">${t('fin.overdueN', { n: overdue })}</span>` : ''}` : P.can('finance') ? t('fin.nothing') : UI.money(0)}</dd></div>
      </dl>
    </section>`;
  }

  /* Open alerts link to the Operations tab; without an Atera link the number is unknown, not zero */
  function alertsFact(c) {
    if (c.atera !== 'LINKED') return h`<span class="muted">${t('cust.unknown')}</span>`;
    var open = D.alertsOf(c.id).filter(D.isOpen);
    var urgent = open.filter(D.isUrgent).length;
    return h`<a class="link-plain num" href="#/customers/${c.id}/operations" aria-label="${t('cust.alertsLink', { n: open.length })}">${P.fmt.num(open.length)}</a>${urgent ? h` <span class="pill pill-high">${t('cust.urgentN', { n: urgent })}</span>` : ''}`;
  }

  /* Not linked to Atera: say why nothing is shown, and give the way to the mapping to whoever may change it */
  P.noAteraState = function () {
    return UI.empty('link', t('cust.noAteraTitle'), t('cust.noAteraText') + (P.can('integrations') ? '' : ' ' + t('cust.noAteraWho')),
      P.can('integrations') ? h`<a class="btn btn-sm" href="#/admin">${t('cust.mapAtera')}</a>` : '');
  };

  /* ---------- Overview ---------- */

  P.customerTabs.overview = function (c) {
    var linked = c.atera === 'LINKED';
    var urgent = M.sortAlerts(P.views.customers.urgentFor(c));
    var tasks = M.sortTasks(D.tasks.filter(function (x) { return x.customer === c.id && x.status === 'Open'; }));
    var tickets = D.ticketsOf(c.id).filter(function (x) { return x.status === 'Open' || x.status === 'Pending'; });
    var month = D.time.filter(function (e) { return e.customer === c.id && e.date.getMonth() === 9; });
    var left = h`
      ${UI.card({ title: t('cust.now'), icon: 'pulse', titleId: 'co-now', count: urgent.length,
        tools: linked ? h`<a class="btn btn-link" href="#/customers/${c.id}/operations">${t('cust.allOperations')}</a>` : '',
        body: !linked ? P.noAteraState()
          : urgent.length ? h`<div class="rows">${urgent.map(function (a) { return R.alertRow(a, { hideCustomer: true }); })}</div>`
          : UI.empty('shieldCheck', t('cust.noUrgentTitle'), t('cust.noUrgentText')),
        foot: linked ? h`<span>${t('sync.at', { time: P.fmt.time(D.syncedAt) })}</span>` : '' })}
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
