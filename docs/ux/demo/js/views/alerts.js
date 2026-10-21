/* Parasoll UX demo: one queue of open alerts across every customer (Atera, Huntress).
   Counts cover the whole filter; alerts the CRM cannot attribute are stated, never shown as "nothing found". */
(function () {
  'use strict';

  var P = window.P;
  var h = P.html;
  var t = P.t;
  var D = P.data;
  var M = P.model;
  var UI = P.ui$;
  var R = P.rows;

  var PAGE = 25;

  function filter() {
    var f = P.state.ui.alertFilter = Object.assign({ mode: 'urgent', sev: 'all', work: 'all', source: 'all', customer: 'all', q: '', limit: PAGE }, P.state.ui.alertFilter || {});
    if (f.sev === 'URGENT') { f.mode = 'urgent'; f.sev = 'all'; }
    return f;
  }

  function base(f) {
    if (f.mode === 'history') return D.alerts.filter(function (a) { return !D.isOpen(a); });
    var open = D.alerts.filter(D.isOpen);
    return f.mode === 'urgent' ? open.filter(D.isUrgent) : open;
  }

  function apply(f, list, skip) {
    var q = f.q.trim().toLowerCase();
    return list.filter(function (a) {
      if (skip !== 'sev' && f.sev !== 'all' && a.severity !== f.sev) return false;
      if (f.work === 'none' && M.taskOf(a)) return false;
      if (f.work === 'has' && !M.taskOf(a)) return false;
      if (f.source !== 'all' && a.source !== f.source) return false;
      if (f.customer !== 'all' && a.customer !== f.customer) return false;
      if (q) {
        var dev = R.deviceOf(a);
        var hay = (a.title + ' ' + D.customer(a.customer).name + ' ' + (dev ? dev.host : '')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  /* History shows how each alert ended, so its last column is the status rather than the work */
  function tableRows(list, mode) {
    return h`<div class="table-wrap only-wide"><table class="table alert-table">
      <caption class="sr-only">${t('alert.tableCaption')}</caption>
      <thead><tr><th scope="col">${t('alert.colSeverity')}</th><th scope="col">${t('alert.colAlert')}</th><th scope="col">${t('alert.colWhere')}</th>
        <th scope="col">${t('alert.colSource')}</th><th scope="col">${t('alert.colWhen')}</th><th scope="col">${mode === 'history' ? t('alert.status') : t('alert.colWork')}</th></tr></thead>
      <tbody>${list.map(function (a) {
        var dev = R.deviceOf(a);
        var c = D.customer(a.customer);
        return h`<tr>
          <td>${UI.sev(a.severity)}</td>
          <td><div class="cell-main"><button class="cell-title linklike" type="button" data-action="open-alert" data-id="${a.id}">${a.title}</button>
            <span class="cell-sub">${t('kind.' + a.kind)}</span></div></td>
          <td><div class="cell-main"><a class="cell-title" href="#/customers/${c.id}/operations">${c.name}</a><span class="cell-sub break">${dev ? dev.host : t('deviceStatus.' + a.deviceStatus)}</span></div></td>
          <td class="nowrap">${UI.sourceName(a.source)}</td>
          <td class="nowrap num" title="${P.fmt.dateTime(a.occurredAt)}">${P.fmt.when(a.occurredAt)}</td>
          <td>${D.isOpen(a) ? R.workCell(a) : UI.alertStatus(a.status)}</td></tr>`;
      })}</tbody></table></div>
      <div class="rows only-narrow alert-cards">${list.map(function (a) { return R.alertRow(a); })}</div>`;
  }

  function results() {
    var f = filter();
    var list = M.sortAlerts(apply(f, base(f)));
    var shown = list.slice(0, f.limit);
    if (!list.length) {
      return UI.card({ flush: true, body: UI.empty('shieldCheck', f.q ? t('alert.noMatch', { q: f.q }) : t('alert.emptyTitle'), f.q ? t('alert.noMatchText') : t('alert.emptyText'),
        h`<button class="btn btn-sm" type="button" data-action="alert-reset">${t('alert.reset')}</button>`) });
    }
    return UI.card({ flush: true, body: h`${tableRows(shown, f.mode)}
      <div class="list-foot"><span class="num">${t('alert.shown', { shown: shown.length, n: list.length })}</span><span>${t('alert.totalsNote')}</span>
        ${list.length > shown.length ? h`<button class="btn btn-sm" type="button" data-action="alert-more">${t('alert.more', { n: Math.min(PAGE, list.length - shown.length) })}</button>` : ''}</div>` });
  }

  function counts(f) {
    var b = base(f);
    var bySev = {};
    apply(f, b, 'sev').forEach(function (a) { bySev[a.severity] = (bySev[a.severity] || 0) + 1; });
    return bySev;
  }

  /* Atera alerts whose Atera customer has no CRM link: who may fix the mapping gets the way there */
  function unmatchedBanner() {
    if (!D.unmatchedAlerts) return '';
    var fix = P.can('integrations') ? h`<a class="btn btn-sm" href="#/admin">${t('cust.mapAtera')}</a>` : '';
    return h`<div class="page-banner">${UI.banner('warn', t('alert.unmatchedTitle', { n: D.unmatchedAlerts }),
      t('alert.unmatchedText') + (P.can('integrations') ? '' : ' ' + t('cust.noAteraWho')), fix, 'link')}</div>`;
  }

  P.views.alerts = {
    perm: 'service',
    render: function () {
      var f = filter();
      var open = D.alerts.filter(D.isOpen);
      var bySev = counts(f);
      var linked = D.customers.filter(function (c) { return c.atera === 'LINKED'; });
      var sevs = f.mode === 'urgent' ? ['CRITICAL', 'HIGH'] : ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
      var colors = { CRITICAL: 'var(--crit)', HIGH: 'var(--high)', MEDIUM: 'var(--med)', LOW: 'var(--low)', INFO: 'var(--faint)' };
      var activeFilters = ['work', 'source', 'customer'].filter(function (k) { return f[k] !== 'all'; }).length;
      var body = h`
        ${UI.pageHead({ title: t('nav.alerts'), sub: t('alert.sub'),
          actions: h`<span class="pill pill-outline">${P.icon('database', 'ic-14')}${t('sync.at', { time: P.fmt.time(D.syncedAt) })}</span>
            <button class="btn" type="button" data-action="reread-saved" title="${t('day.reread')}">${P.icon('refresh', 'ic-16')}${t('alert.reread')}</button>` })}
        ${unmatchedBanner()}
        <div class="toolbar">
          ${UI.seg('alert-mode', [{ value: 'urgent', label: t('alert.modeUrgent'), count: open.filter(D.isUrgent).length },
            { value: 'open', label: t('alert.modeOpen'), count: open.length }, { value: 'history', label: t('alert.modeHistory') }], f.mode, t('alert.mode'))}
          <label class="search"><span class="sr-only">${t('alert.search')}</span>${P.icon('search', 'ic-16')}
            <input class="input" type="search" id="alert-q" value="${f.q}" placeholder="${t('alert.searchHint')}" autocomplete="off"></label>
        </div>
        <div class="toolbar filters">
          <div class="chips" role="group" aria-label="${t('alert.colSeverity')}">
            ${UI.chip('alert-sev', 'all', t('alert.allSev'), null, f.sev === 'all')}
            ${sevs.map(function (s) { return UI.chip('alert-sev', s, t('sev.' + s), bySev[s] || 0, f.sev === s, colors[s]); })}
          </div>
          <span class="spacer"></span>
          <button class="btn btn-sm filter-toggle" type="button" data-action="toggle-filters" aria-expanded="${P.state.ui.alertFiltersOpen ? 'true' : 'false'}" aria-controls="alert-selects">
            ${P.icon('filter', 'ic-16')}${t('alert.filters')}${activeFilters ? h`<span class="pill pill-accent num">${activeFilters}</span>` : ''}</button>
          <div class="filter-selects ${P.state.ui.alertFiltersOpen ? 'is-open' : ''}" id="alert-selects">
          <label class="sr-only" for="alert-work">${t('alert.colWork')}</label>
          <select class="select select-sm" id="alert-work" data-afilter="work">
            ${['all', 'none', 'has'].map(function (v) { return h`<option value="${v}" ${f.work === v ? 'selected' : ''}>${t('alert.work.' + v)}</option>`; })}</select>
          <label class="sr-only" for="alert-source">${t('alert.colSource')}</label>
          <select class="select select-sm" id="alert-source" data-afilter="source">
            ${['all', 'atera', 'huntress'].map(function (v) { return h`<option value="${v}" ${f.source === v ? 'selected' : ''}>${v === 'all' ? t('alert.allSources') : UI.sourceName(v)}</option>`; })}</select>
          <label class="sr-only" for="alert-customer">${t('task.customer')}</label>
          <select class="select select-sm" id="alert-customer" data-afilter="customer">
            <option value="all">${t('alert.allCustomers', { n: linked.length })}</option>
            ${linked.map(function (c) { return h`<option value="${c.id}" ${f.customer === c.id ? 'selected' : ''}>${c.name}</option>`; })}</select>
          </div>
        </div>
        <div id="alert-results">${results()}</div>
        <p class="footnote">${P.icon('info', 'ic-14')}${t('alert.footnote')}</p>`;
      return { title: t('nav.alerts'), crumbs: [{ label: 'Parasoll', href: '#/day' }, { label: t('nav.alerts') }], body: body };
    },
    mounted: function () {
      var q = document.getElementById('alert-q');
      if (q) q.addEventListener('input', function () {
        var f = filter();
        f.q = q.value;
        f.limit = PAGE;
        document.getElementById('alert-results').innerHTML = P.toHtml(results());
        P.markScrollEdges();
      });
      P.$$('[data-afilter]').forEach(function (sel) {
        sel.addEventListener('change', function () {
          var f = filter();
          f[sel.getAttribute('data-afilter')] = sel.value;
          f.limit = PAGE;
          P.app.refresh();
          var again = document.getElementById(sel.id);
          if (again) again.focus();
        });
      });
    }
  };

  P.on('toggle-filters', function () { P.state.ui.alertFiltersOpen = !P.state.ui.alertFiltersOpen; P.app.refresh(); var b = P.$('.filter-toggle'); if (b) b.focus(); });
  P.on('alert-mode', function (el) { var f = filter(); f.mode = el.dataset.value; f.sev = 'all'; f.limit = PAGE; P.app.refresh(); });
  P.on('alert-sev', function (el) { var f = filter(); f.sev = el.dataset.value; f.limit = PAGE; P.app.refresh(); });
  P.on('alert-more', function () { var f = filter(); f.limit += PAGE; P.app.refresh(); });
  P.on('alert-reset', function () { P.state.ui.alertFilter = null; P.app.refresh(); });
})();
