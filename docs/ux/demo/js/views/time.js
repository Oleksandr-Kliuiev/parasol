/* Parasol UX demo: time. A week grid that shows gaps against the daily norm, approval for service leads
   with an allocation preview, and month periods with the reason a close is not yet possible. */
(function () {
  'use strict';

  var P = window.P;
  var h = P.html;
  var t = P.t;
  var D = P.data;
  var M = P.model;
  var UI = P.ui$;

  P.views.time = {
    perm: 'time.own',
    statusPill: function (e) {
      var map = { New: ['pill-outline', 'circleDashed'], Approved: ['pill-good', 'circleCheck'], NonBillable: ['', 'minusCircle'], Invoiced: ['pill-accent', 'files'] };
      var m = map[e.status] || map.New;
      return h`<span class="pill ${m[0]}">${P.icon(m[1], 'ic-14')}${t('timeStatus.' + e.status)}</span>`;
    },
    render: function (route) {
      var tab = route.params[0] || 'week';
      var tabs = [{ id: 'week', label: t('time.tabWeek') }];
      if (P.can('time.manage')) tabs.push({ id: 'approve', label: t('time.tabApprove'), count: M.approvalQueue().reduce(function (s, g) { return s + g.entries.length; }, 0) || null });
      tabs.push({ id: 'periods', label: t('time.tabPeriods') });
      if (!tabs.some(function (x) { return x.id === tab; })) tab = 'week';
      var panel = tab === 'approve' ? approve() : tab === 'periods' ? periods() : week();
      return {
        title: t('nav.time'),
        crumbs: [{ label: 'Parasol', href: '#/day' }, { label: t('nav.time') }],
        body: h`${UI.pageHead({ title: t('nav.time'), sub: t('time.sub'),
            actions: h`<button class="btn btn-primary" type="button" data-action="log-time">${P.icon('timer', 'ic-16')}${t('create.time')}</button>` })}
          ${UI.tabs(tabs, tab, '#/time/')}${panel}`
      };
    }
  };

  /* ---------- Week grid ---------- */

  function week() {
    var off = P.state.ui.timeWeek == null ? 0 : P.state.ui.timeWeek;
    var monday = off * 7;
    var me = P.me().id;
    var days = M.weekDays(me, monday);
    var entries = [].concat.apply([], days.map(function (d) { return d.entries; }));
    var weekNo = P.isoWeek(P.at(monday));
    var total = M.sumHours(entries);
    var norm = D.dailyTarget * 5;
    var rowsBy = {};
    entries.forEach(function (e) { var k = e.customer || '_internal'; (rowsBy[k] = rowsBy[k] || []).push(e); });
    var keys = Object.keys(rowsBy).sort();
    var lastWeekMissing = norm - M.sumHours(M.timeFor(me, -7, -3));
    var head = h`<div class="week-nav">
      <button class="icon-btn" type="button" data-action="time-week" data-value="${off - 1}" aria-label="${t('time.prevWeek')}" title="${t('time.prevWeek')}">${P.icon('chevronLeft')}</button>
      <div class="week-label"><strong>${t('time.weekN', { week: weekNo })}</strong><span class="small muted num">${P.fmt.dm(days[0].date)}–${P.fmt.dm(days[6].date)}</span></div>
      <button class="icon-btn" type="button" data-action="time-week" data-value="${off + 1}" ${off >= 0 ? 'disabled' : ''} aria-label="${t('time.nextWeek')}" title="${t('time.nextWeek')}">${P.icon('chevronRight')}</button>
      ${off !== 0 ? h`<button class="btn btn-sm btn-quiet" type="button" data-action="time-week" data-value="0">${t('time.thisWeek')}</button>` : ''}
      <span class="spacer"></span>
      <div class="week-total"><span class="small muted">${t('time.weekTotal')}</span><strong class="num">${P.fmt.hours(total)} / ${P.fmt.hours(norm)}</strong>
        <div class="meter ${total < norm ? 'is-warn' : ''}" role="img" aria-label="${t('time.weekProgress', { hours: P.fmt.hours(total), norm: P.fmt.hours(norm) })}"><span style="width:${Math.min(100, total / norm * 100).toFixed(0)}%"></span></div></div>
    </div>`;
    var grid = h`<div class="table-wrap"><table class="table week-grid">
      <caption class="sr-only">${t('time.gridCaption', { week: weekNo })}</caption>
      <thead><tr><th scope="col">${t('time.colWork')}</th>${days.map(function (d) {
        var today = P.sameDay(d.date, P.NOW);
        return h`<th scope="col" class="t-num ${today ? 'is-today' : ''}">${P.fmt.weekday(d.date)} ${P.fmt.dm(d.date)}${today ? h`<span class="sr-only"> (${t('when.today')})</span>` : ''}</th>`;
      })}<th scope="col" class="t-num">${t('time.colTotal')}</th></tr></thead>
      <tbody>${keys.length ? keys.map(function (k) {
        var c = k === '_internal' ? null : D.customer(k);
        var list = rowsBy[k];
        return h`<tr><th scope="row"><div class="cell-main"><span class="cell-title">${c ? c.name : t('time.internal')}</span>
            <span class="cell-sub">${t('time.entriesN', { n: list.length })}</span></div></th>
          ${days.map(function (d) {
            var sum = M.sumHours(list.filter(function (e) { return P.sameDay(e.date, d.date); }));
            return h`<td class="t-num">${sum ? h`<span class="strong">${P.fmt.num(sum)}</span>` : h`<span class="muted" aria-label="${t('time.zero')}">·</span>`}</td>`;
          })}<td class="t-num strong">${P.fmt.num(M.sumHours(list))}</td></tr>`;
      }) : h`<tr><td colspan="9">${UI.empty('clock', t('time.weekEmpty'), t('time.weekEmptyText'))}</td></tr>`}</tbody>
      ${keys.length ? h`<tfoot><tr><th scope="row">${t('time.dayTotal')}</th>${days.map(function (d, i) {
        var short = i < 5 && d.date < P.at(0) && d.hours < D.dailyTarget;
        return h`<td class="t-num ${short ? 'is-short' : ''}">${short ? h`<span class="row" style="justify-content:flex-end">${P.icon('triangle', 'ic-14')}${P.fmt.num(d.hours)}</span>` : P.fmt.num(d.hours)}
          ${short ? h`<span class="sr-only">${t('time.shortDay', { hours: P.fmt.hours(D.dailyTarget - d.hours) })}</span>` : ''}</td>`;
      })}<td class="t-num strong">${P.fmt.num(total)}</td></tr></tfoot>` : ''}</table></div>`;
    var list = entries.slice().sort(function (a, b) { return b.date - a.date; });
    return h`<div class="stack-4">
      ${off === 0 && lastWeekMissing > 0 ? UI.banner('warn', t('time.lastWeekShort', { week: 42, hours: P.fmt.hours(lastWeekMissing) }), t('time.lastWeekShortText'),
        h`<button class="btn btn-sm" type="button" data-action="time-week" data-value="-1">${t('time.openWeek', { week: 42 })}</button>`, 'clock') : ''}
      ${UI.card({ flush: true, body: h`<div class="card-head">${head}</div>${grid}<div class="list-foot"><span>${t('time.gridFoot')}</span></div>` })}
      ${UI.card({ title: t('time.entries'), icon: 'listChecks', titleId: 'tm-entries', count: list.length, flush: true, body: list.length ? h`<div class="table-wrap"><table class="table">
        <caption class="sr-only">${t('time.entries')}</caption>
        <thead><tr><th scope="col">${t('time.date')}</th><th scope="col">${t('task.customer')}</th><th scope="col">${t('time.desc')}</th><th scope="col" class="t-num">${t('time.hours')}</th><th scope="col">${t('time.status')}</th></tr></thead>
        <tbody>${list.map(function (e) {
          var c = D.customer(e.customer);
          return h`<tr><td class="nowrap num">${P.fmt.weekday(e.date)} ${P.fmt.dm(e.date)}</td><td>${c ? c.name : t('time.internal')}</td>
            <td><div class="cell-main"><span>${P.L(e.desc)}</span><span class="cell-sub">${e.ticket ? '#' + e.ticket + ' · ' : ''}${e.source === 'atera' ? t('time.fromAtera') : t('time.fromCrm')}${e.billable ? '' : ' · ' + t('alloc.NonBillable')}</span></div></td>
            <td class="t-num strong">${P.fmt.hours(e.hours)}</td><td>${P.views.time.statusPill(e)}</td></tr>`;
        })}</tbody></table></div>` : UI.empty('clock', t('time.weekEmpty'), '') })}
    </div>`;
  }
  P.on('time-week', function (el) { P.state.ui.timeWeek = Number(el.dataset.value); P.app.refresh(); });

  /* ---------- Approval ---------- */

  /* Entries the service lead left out of this approval (to ask the colleague first) */
  function excluded() { return P.state.ui.apprOut = P.state.ui.apprOut || {}; }

  function approve() {
    var q = M.approvalQueue();
    var out = excluded();
    if (!q.length) return UI.card({ body: UI.empty('listChecks', t('day.approvalsEmpty'), t('time.approveEmptyText')) });
    return h`<div class="stack-4">${q.map(function (g) {
      var bank = 0, rate = 0, non = 0;
      var warn = [];
      var byCustomer = {};
      var chosen = g.entries.filter(function (e) { return !out[e.id]; });
      chosen.forEach(function (e) {
        if (!e.billable || !e.customer) { non += e.hours; return; }
        byCustomer[e.customer] = (byCustomer[e.customer] || 0) + e.hours;
      });
      Object.keys(byCustomer).forEach(function (cid) {
        var c = D.customer(cid);
        var hrs = byCustomer[cid];
        var left = c.hourBank ? c.hourBank.left : 0;
        var b = Math.min(left, hrs);
        bank += b; rate += hrs - b;
        if (c.hourBank && (left - b) / c.hourBank.size < 0.2) warn.push(t('time.warnBank', { customer: c.name, left: P.fmt.num(Math.max(0, left - b)), size: P.fmt.num(c.hourBank.size) }));
      });
      var chosenHours = M.sumHours(chosen) || 1;
      return UI.card({ title: D.staff[g.staff].name, titleId: 'ap-' + g.staff, icon: 'user',
        tools: h`<span class="small muted num">${t('time.approveLine', { n: g.entries.length, hours: P.fmt.hours(g.hours) })}</span>`,
        body: h`<div class="alloc"><div class="row"><strong>${t('time.approvePreview')}</strong></div>
            <div class="alloc-bar" aria-hidden="true"><span style="width:${(bank / chosenHours * 100).toFixed(1)}%;background:var(--good)"></span><span style="width:${(rate / chosenHours * 100).toFixed(1)}%;background:var(--accent)"></span><span style="width:${(non / chosenHours * 100).toFixed(1)}%;background:var(--faint)"></span></div>
            <div class="alloc-legend"><span><i style="background:var(--good)"></i>${t('alloc.HourBank')} ${P.fmt.hours(bank)}</span><span><i style="background:var(--accent)"></i>${t('alloc.Rate')} ${P.fmt.hours(rate)}</span><span><i style="background:var(--faint)"></i>${t('alloc.NonBillable')} ${P.fmt.hours(non)}</span></div>
            ${warn.map(function (w) { return h`<p class="small strong row">${P.icon('triangle', 'ic-14')}${w}</p>`; })}</div>
          <details class="done-group" ${P.state.ui['apprOpen-' + g.staff] ? 'open' : ''} data-action="appr-toggle" data-value="${g.staff}"><summary class="small strong">${t('time.showEntries', { n: g.entries.length })}${chosen.length < g.entries.length ? ' · ' + t('time.leftOut', { n: g.entries.length - chosen.length }) : ''}</summary>
            <div class="rows">${g.entries.map(function (e) {
              var c = D.customer(e.customer);
              return h`<label class="item appr-item"><input type="checkbox" data-action="appr-pick" data-id="${e.id}" ${out[e.id] ? '' : 'checked'} data-focus="appr-${e.id}">
                <div class="item-main"><span class="item-title">${P.L(e.desc)}</span><span class="small muted">${P.fmt.weekday(e.date)} ${P.fmt.dm(e.date)} · ${c ? c.name : t('time.internal')}${e.onsite ? ' · ' + t('time.onsite') : ''}${e.source === 'atera' ? ' · ' + t('time.fromAtera') : ''}</span></div>
                <div class="item-side strong num">${P.fmt.hours(e.hours)}</div></label>`;
            })}</div></details>`,
        foot: h`<span>${t('time.approveNote')}</span><button class="btn btn-primary btn-sm" type="button" data-action="approve" data-value="${g.staff}" ${chosen.length ? '' : 'disabled'}>${t('time.approveN', { n: chosen.length })}</button>` });
    })}</div>`;
  }
  P.on('appr-pick', function (el) {
    var out = excluded();
    if (el.checked) delete out[el.dataset.id]; else out[el.dataset.id] = true;
    P.app.refresh();
  });
  P.on('appr-toggle', function (el) { setTimeout(function () { P.state.ui['apprOpen-' + el.dataset.value] = el.open; }, 0); });
  P.on('approve', function (el) {
    var g = M.approvalQueue().filter(function (x) { return x.staff === el.dataset.value; })[0];
    if (!g) return;
    var out = excluded();
    var chosen = g.entries.filter(function (e) { return !out[e.id]; });
    M.approve(chosen);
    P.app.refresh();
    P.toast(t('time.approved', { n: chosen.length, hours: P.fmt.hours(M.sumHours(chosen)), who: D.staff[g.staff].name }));
  });

  /* ---------- Periods ---------- */

  function periods() {
    var open = M.approvalQueue().reduce(function (s, g) { return s + g.entries.length; }, 0);
    return UI.card({ flush: true, body: h`<div class="rows period-rows">${D.monthLocks.map(function (l) {
      var isOpen = l.status === 'open';
      return h`<div class="item"><span class="tl-icon">${P.icon(isOpen ? 'calendar' : 'lock', 'ic-16')}</span>
        <div class="item-main"><span class="item-title">${P.fmt.month(l.y, l.m)}</span>
          <span class="small muted">${isOpen ? t('period.openText', { date: P.fmt.date(new Date(l.y, l.m + 1, 2)), n: open }) : t('period.closedText', { who: D.staff[l.by].name, date: P.fmt.date(l.at) })}</span></div>
        <div class="item-side">${isOpen ? h`<span class="pill pill-outline">${t('period.open')}</span><button class="btn btn-sm" type="button" disabled title="${t('period.cannotClose')}">${t('period.close')}</button>`
          : h`<span class="pill">${P.icon('lock', 'ic-14')}${t('period.closed')}</span>${P.can('finance') ? h`<button class="btn btn-sm btn-quiet" type="button" data-action="period-reopen">${t('period.reopen')}</button>` : ''}`}</div></div>`;
    })}</div>
    <div class="list-foot"><span>${t('period.foot')}</span></div>` });
  }
  P.on('period-reopen', function () { P.toast(t('period.reopenDemo'), { tone: 'warn' }); });
})();
