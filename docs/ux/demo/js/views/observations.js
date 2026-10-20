/* Parasoll UX demo: one queue of Atlas observations across every customer the person may see.
   Counts cover the whole filter; coverage gaps are stated, never shown as "nothing found". */
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
    var f = P.state.ui.obsFilter = Object.assign({ mode: 'urgent', sev: 'all', work: 'all', source: 'all', customer: 'all', q: '', limit: PAGE }, P.state.ui.obsFilter || {});
    if (f.sev === 'URGENT') { f.mode = 'urgent'; f.sev = 'all'; }
    return f;
  }

  function base(f) {
    var all = D.visibleObservations();
    if (f.mode === 'history') return all.filter(function (o) { return !D.isActive(o); });
    var active = all.filter(D.isActive);
    return f.mode === 'urgent' ? active.filter(D.isUrgent) : active;
  }

  function apply(f, list, skip) {
    var q = f.q.trim().toLowerCase();
    return list.filter(function (o) {
      if (skip !== 'sev' && f.sev !== 'all' && o.severity !== f.sev) return false;
      if (f.work === 'none' && M.taskOf(o)) return false;
      if (f.work === 'has' && !M.taskOf(o)) return false;
      if (f.source !== 'all' && o.source !== f.source) return false;
      if (f.customer !== 'all' && o.customer !== f.customer) return false;
      if (q) {
        var dev = R.deviceOf(o);
        var hay = (o.summary + ' ' + D.customer(o.customer).name + ' ' + (dev ? dev.host : '')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function tableRows(list) {
    return h`<div class="table-wrap only-wide"><table class="table obs-table">
      <caption class="sr-only">${t('obs.tableCaption')}</caption>
      <thead><tr><th scope="col">${t('obs.colSeverity')}</th><th scope="col">${t('obs.colObservation')}</th><th scope="col">${t('obs.colWhere')}</th>
        <th scope="col">${t('obs.colSource')}</th><th scope="col">${t('obs.colWhen')}</th><th scope="col">${t('obs.colWork')}</th></tr></thead>
      <tbody>${list.map(function (o) {
        var dev = R.deviceOf(o);
        var c = D.customer(o.customer);
        return h`<tr>
          <td>${UI.sev(o.severity)}</td>
          <td><div class="cell-main"><button class="cell-title linklike" type="button" data-action="open-observation" data-id="${o.id}">${o.summary}</button>
            <span class="cell-sub">${t('kind.' + o.kind)} · ${t('route.' + o.route)}${o.status === 'ACKNOWLEDGED' ? ' · ' + t('obsStatus.ACKNOWLEDGED') : ''}</span></div></td>
          <td><div class="cell-main"><a class="cell-title" href="#/customers/${c.id}/technical">${c.name}</a><span class="cell-sub break">${dev ? dev.host : t('deviceStatus.' + o.deviceStatus)}</span></div></td>
          <td class="nowrap">${UI.sourceName(o.source)}</td>
          <td class="nowrap num" title="${P.fmt.dateTime(o.occurredAt)}">${P.fmt.when(o.occurredAt)}</td>
          <td>${D.isActive(o) ? R.workCell(o) : UI.obsStatus(o.status)}</td></tr>`;
      })}</tbody></table></div>
      <div class="rows only-narrow obs-cards">${list.map(function (o) { return R.obsRow(o); })}</div>`;
  }

  function results() {
    var f = filter();
    var list = M.sortObs(apply(f, base(f)));
    var shown = list.slice(0, f.limit);
    if (!list.length) {
      return UI.card({ flush: true, body: UI.empty('shieldCheck', f.q ? t('obs.noMatch', { q: f.q }) : t('obs.emptyTitle'), f.q ? t('obs.noMatchText') : t('obs.emptyText'),
        h`<button class="btn btn-sm" type="button" data-action="obs-reset">${t('obs.reset')}</button>`) });
    }
    return UI.card({ flush: true, body: h`${tableRows(shown)}
      <div class="list-foot"><span class="num">${t('obs.shown', { shown: shown.length, n: list.length })}</span><span>${t('obs.totalsNote')}</span>
        ${list.length > shown.length ? h`<button class="btn btn-sm" type="button" data-action="obs-more">${t('obs.more', { n: Math.min(PAGE, list.length - shown.length) })}</button>` : ''}</div>` });
  }

  function counts(f) {
    var b = base(f);
    var bySev = {};
    apply(f, b, 'sev').forEach(function (o) { bySev[o.severity] = (bySev[o.severity] || 0) + 1; });
    return bySev;
  }

  P.views.observations = {
    perm: 'atlas',
    render: function () {
      var f = filter();
      var cov = M.coverage();
      var all = D.visibleObservations();
      var active = all.filter(D.isActive);
      var bySev = counts(f);
      var mine = D.customers.filter(function (c) { return c.members.indexOf(P.me().id) !== -1; });
      var sevs = f.mode === 'urgent' ? ['CRITICAL', 'HIGH'] : ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
      var colors = { CRITICAL: 'var(--crit)', HIGH: 'var(--high)', MEDIUM: 'var(--med)', LOW: 'var(--low)', INFO: 'var(--faint)' };
      var activeFilters = ['work', 'source', 'customer'].filter(function (k) { return f[k] !== 'all'; }).length;
      var body = h`
        ${UI.pageHead({ title: t('nav.observations'), sub: t('obs.sub', { n: cov.total }),
          actions: h`<span class="pill pill-outline">${P.icon('database', 'ic-14')}${t('obs.readAt', { time: P.fmt.time(cov.readAt), read: cov.read, n: cov.total })}</span>
            <button class="btn" type="button" data-action="refresh-atlas">${P.icon('refresh', 'ic-16')}${t('obs.refresh')}</button>` })}
        ${cov.timeout.length ? h`<div class="page-banner">${UI.banner('warn', t('obs.gapTitle', { customer: cov.timeout[0].name }), t('obs.gapText'),
          h`<button class="btn btn-sm" type="button" data-action="refresh-atlas">${t('obs.retry')}</button>`, 'clock')}</div>` : ''}
        <div class="toolbar">
          ${UI.seg('obs-mode', [{ value: 'urgent', label: t('obs.modeUrgent'), count: active.filter(D.isUrgent).length },
            { value: 'active', label: t('obs.modeActive'), count: active.length }, { value: 'history', label: t('obs.modeHistory') }], f.mode, t('obs.mode'))}
          <label class="search"><span class="sr-only">${t('obs.search')}</span>${P.icon('search', 'ic-16')}
            <input class="input" type="search" id="obs-q" value="${f.q}" placeholder="${t('obs.searchHint')}" autocomplete="off"></label>
        </div>
        <div class="toolbar filters">
          <div class="chips" role="group" aria-label="${t('obs.colSeverity')}">
            ${UI.chip('obs-sev', 'all', t('obs.allSev'), null, f.sev === 'all')}
            ${sevs.map(function (s) { return UI.chip('obs-sev', s, t('sev.' + s), bySev[s] || 0, f.sev === s, colors[s]); })}
          </div>
          <span class="spacer"></span>
          <button class="btn btn-sm filter-toggle" type="button" data-action="toggle-filters" aria-expanded="${P.state.ui.obsFiltersOpen ? 'true' : 'false'}" aria-controls="obs-selects">
            ${P.icon('filter', 'ic-16')}${t('obs.filters')}${activeFilters ? h`<span class="pill pill-accent num">${activeFilters}</span>` : ''}</button>
          <div class="filter-selects ${P.state.ui.obsFiltersOpen ? 'is-open' : ''}" id="obs-selects">
          <label class="sr-only" for="obs-work">${t('obs.colWork')}</label>
          <select class="select select-sm" id="obs-work" data-ofilter="work">
            ${['all', 'none', 'has'].map(function (v) { return h`<option value="${v}" ${f.work === v ? 'selected' : ''}>${t('obs.work.' + v)}</option>`; })}</select>
          <label class="sr-only" for="obs-source">${t('obs.colSource')}</label>
          <select class="select select-sm" id="obs-source" data-ofilter="source">
            ${['all', 'huntress', 'atera'].map(function (v) { return h`<option value="${v}" ${f.source === v ? 'selected' : ''}>${v === 'all' ? t('obs.allSources') : UI.sourceName(v)}</option>`; })}</select>
          <label class="sr-only" for="obs-customer">${t('task.customer')}</label>
          <select class="select select-sm" id="obs-customer" data-ofilter="customer">
            <option value="all">${t('obs.allCustomers', { n: mine.length })}</option>
            ${mine.map(function (c) { return h`<option value="${c.id}" ${f.customer === c.id ? 'selected' : ''}>${c.name}</option>`; })}</select>
          </div>
        </div>
        <div id="obs-results">${results()}</div>
        <p class="footnote">${P.icon('info', 'ic-14')}${t('obs.footnote')}</p>`;
      return { title: t('nav.observations'), crumbs: [{ label: 'Parasoll', href: '#/day' }, { label: t('nav.observations') }], body: body };
    },
    mounted: function () {
      var q = document.getElementById('obs-q');
      if (q) q.addEventListener('input', function () {
        var f = filter();
        f.q = q.value;
        f.limit = PAGE;
        document.getElementById('obs-results').innerHTML = P.toHtml(results());
        P.markScrollEdges();
      });
      P.$$('[data-ofilter]').forEach(function (sel) {
        sel.addEventListener('change', function () {
          var f = filter();
          f[sel.getAttribute('data-ofilter')] = sel.value;
          f.limit = PAGE;
          P.app.refresh();
          var again = document.getElementById(sel.id);
          if (again) again.focus();
        });
      });
    }
  };

  P.on('toggle-filters', function () { P.state.ui.obsFiltersOpen = !P.state.ui.obsFiltersOpen; P.app.refresh(); var b = P.$('.filter-toggle'); if (b) b.focus(); });
  P.on('obs-mode', function (el) { var f = filter(); f.mode = el.dataset.value; f.sev = 'all'; f.limit = PAGE; P.app.refresh(); });
  P.on('obs-sev', function (el) { var f = filter(); f.sev = el.dataset.value; f.limit = PAGE; P.app.refresh(); });
  P.on('obs-more', function () { var f = filter(); f.limit += PAGE; P.app.refresh(); });
  P.on('obs-reset', function () { P.state.ui.obsFilter = null; P.app.refresh(); });
})();
