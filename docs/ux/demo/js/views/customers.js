/* Parasoll UX demo: customer list. One row joins CRM, Atera and PowerOffice facts;
   what is missing (no Atera link) or hidden from a role (amounts) is marked, not silently empty. */
(function () {
  'use strict';

  var P = window.P;
  var h = P.html;
  var t = P.t;
  var D = P.data;
  var M = P.model;
  var UI = P.ui$;

  function filterState() {
    return P.state.ui.custFilter = Object.assign({ chip: 'all', q: '' }, P.state.ui.custFilter || {});
  }

  function urgentFor(c) {
    return D.alerts.filter(function (a) { return a.customer === c.id && D.isOpen(a) && D.isUrgent(a); });
  }
  function outstandingFor(c) {
    return D.invoices.filter(function (x) { return x.customer === c.id; }).reduce(function (s, x) { return s + x.outstanding; }, 0);
  }

  var CHIPS = {
    all: function () { return true; },
    mine: function (c) { return c.am === P.me().id || c.tech === P.me().id; },
    urgent: function (c) { return urgentFor(c).length > 0; },
    bank: function (c) { return c.hourBank && c.hourBank.left / c.hourBank.size < 0.2; },
    unlinked: function (c) { return c.atera !== 'LINKED'; },
    prospect: function (c) { return c.status === 'prospect'; }
  };

  function list() {
    var f = filterState();
    var q = f.q.trim().toLowerCase();
    return D.customers.filter(CHIPS[f.chip]).filter(function (c) {
      return !q || (c.name + ' ' + c.orgnr.replace(/\s/g, '') + ' ' + c.city).toLowerCase().indexOf(q.replace(/\s/g, '')) !== -1 ||
        c.name.toLowerCase().indexOf(q) !== -1;
    });
  }

  function urgentCell(c) {
    if (c.atera !== 'LINKED') return h`<span class="pill pill-outline">${P.icon('link', 'ic-14')}${t('cust.noAtera')}</span>`;
    var u = urgentFor(c);
    if (!u.length) return h`<span class="muted small">${t('cust.noUrgent')}</span>`;
    var crit = u.filter(function (a) { return a.severity === 'CRITICAL'; }).length;
    return h`<span class="row-wrap">${crit ? h`<span class="pill pill-crit">${P.icon('octagon', 'ic-14')}${P.fmt.num(crit)}</span>` : ''}${u.length - crit ? h`<span class="pill pill-high">${P.icon('triangle', 'ic-14')}${P.fmt.num(u.length - crit)}</span>` : ''}</span>`;
  }

  function results() {
    var rows = list();
    if (!rows.length) return UI.card({ flush: true, body: UI.empty('building', t('cust.noMatch'), t('cust.noMatchText')) });
    return UI.card({ flush: true, body: h`
      <div class="table-wrap only-wide"><table class="table cust-table">
        <caption class="sr-only">${t('cust.caption')}</caption>
        <thead><tr><th scope="col">${t('cust.colCustomer')}</th><th scope="col">${t('cust.colUrgent')}</th><th scope="col" class="t-num">${t('cust.colDevices')}</th>
          <th scope="col">${t('cust.colBank')}</th><th scope="col">${t('cust.colContract')}</th><th scope="col">${t('cust.colOwner')}</th><th scope="col" class="t-num">${t('cust.colOutstanding')}</th></tr></thead>
        <tbody>${rows.map(function (c) {
          var k = D.contractOf(c.id);
          var out = outstandingFor(c);
          return h`<tr>
            <td><div class="row">${UI.custAvatar(c)}<div class="cell-main"><a class="cell-title" href="#/customers/${c.id}">${c.name}</a>
              <span class="cell-sub num">${t('customer.orgnr')} ${c.orgnr} · ${c.city}${c.status === 'prospect' ? ' · ' + t('status.prospect') : ''}</span></div></div></td>
            <td>${urgentCell(c)}</td>
            <td class="t-num">${c.atera === 'LINKED' ? P.fmt.num(D.devicesOf(c.id).length) : h`<span class="muted">—</span>`}</td>
            <td>${UI.bank(c.hourBank, true)}</td>
            <td>${k ? h`<div class="cell-main"><span class="num">${k.id}</span><span class="cell-sub">${k.name}</span></div>` : h`<span class="muted">—</span>`}</td>
            <td>${UI.person(c.am)}</td>
            <td class="t-num">${out ? UI.money(out) : P.can('finance') ? h`<span class="muted">${t('fin.nothing')}</span>` : UI.money(0)}</td></tr>`;
        })}</tbody></table></div>
      <div class="rows only-narrow cust-cards">${rows.map(function (c) {
        return h`<a class="item cust-card" href="#/customers/${c.id}">${UI.custAvatar(c)}
          <div class="item-main"><span class="item-title">${c.name}</span><span class="small muted">${c.city} · ${D.staff[c.am].first}</span>
            <div class="row-wrap">${urgentCell(c)}</div></div>${P.icon('chevronRight', 'ic-16 muted')}</a>`;
      })}</div>
      <div class="list-foot"><span class="num">${t('cust.shown', { shown: rows.length, n: D.customers.length })}</span><span>${t('cust.foot')}</span></div>` });
  }

  P.views.customers = {
    render: function () {
      var f = filterState();
      var linked = D.customers.filter(function (c) { return c.atera === 'LINKED'; }).length;
      var count = function (k) { return D.customers.filter(CHIPS[k]).length; };
      var chips = ['all', 'mine', 'urgent', 'bank', 'unlinked', 'prospect'];
      var body = h`${UI.pageHead({ title: t('nav.customers'), sub: t('cust.sub', { n: D.customers.length, linked: linked }) })}
        <div class="toolbar">
          <label class="search"><span class="sr-only">${t('cust.search')}</span>${P.icon('search', 'ic-16')}
            <input class="input" type="search" id="cust-q" value="${f.q}" placeholder="${t('cust.searchHint')}" autocomplete="off"></label>
          <div class="chips" role="group" aria-label="${t('cust.filters')}">${chips.map(function (k) { return UI.chip('cust-chip', k, t('cust.chip.' + k), count(k), f.chip === k); })}</div>
        </div>
        <div id="cust-results">${results()}</div>`;
      return { title: t('nav.customers'), crumbs: [{ label: 'Parasoll', href: '#/day' }, { label: t('nav.customers') }], body: body };
    },
    mounted: function () {
      var q = document.getElementById('cust-q');
      if (q) q.addEventListener('input', function () {
        filterState().q = q.value;
        document.getElementById('cust-results').innerHTML = P.toHtml(results());
        P.markScrollEdges();
      });
    }
  };
  P.views.customers.urgentFor = urgentFor;
  P.views.customers.outstandingFor = outstandingFor;

  P.on('cust-chip', function (el) { filterState().chip = el.dataset.value; P.app.refresh(); });
})();
