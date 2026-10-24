/* Parasoll UX demo: "My day". One screen answers: what is urgent, what is mine today, what is waiting,
   and how much I can trust the data. The composition adapts to the role. */
(function () {
  'use strict';

  var P = window.P;
  var h = P.html;
  var t = P.t;
  var D = P.data;
  var M = P.model;
  var UI = P.ui$;
  var R = P.rows;

  function greeting() {
    var hr = P.NOW.getHours();
    return t(hr < 11 ? 'day.morning' : hr < 18 ? 'day.afternoon' : 'day.evening', { name: P.me().first });
  }

  function summary() {
    var parts = [];
    var u = P.can('service') ? M.urgentUnassigned().length : 0;
    if (u) parts.push(t('day.sumUrgent', { n: u }));
    var today = M.openTasks().filter(function (x) { return x.due && (x.due < P.NOW || P.sameDay(x.due, P.NOW)); });
    var late = M.overdue();
    parts.push(late.length ? t('day.sumTasksLate', { n: today.length, late: late.length }) : t('day.sumTasks', { n: today.length }));
    if (P.state.role === 'technician') {
      var missing = D.dailyTarget * 5 - M.sumHours(M.timeFor(P.me().id, -7, -3));
      if (missing > 0) parts.push(t('day.sumWeek', { hours: P.fmt.hours(missing) }));
    }
    if (P.state.role === 'servicelead') parts.push(t('day.sumApprovals', { n: M.approvalQueue().reduce(function (s, g) { return s + g.entries.length; }, 0) }));
    if (P.state.role === 'admin') parts.push(t('day.sumOverdue', { n: M.outstanding().overdue.length }));
    return parts.join(' ');
  }

  /* ---------- KPI tiles ---------- */

  function kpiUrgent() {
    var list = M.urgentUnassigned();
    var crit = list.filter(function (a) { return a.severity === 'CRITICAL'; }).length;
    return UI.kpi({ href: '#/alerts', icon: 'pulse', tone: list.length ? 'is-crit' : 'is-good', label: t('day.kUrgent'), value: P.fmt.num(list.length),
      foot: h`<span>${crit ? h`<strong>${t('day.kUrgentCrit', { n: crit })}</strong> · ` : ''}${t('sync.at', { time: P.fmt.time(D.syncedAt) })}</span>` });
  }
  function kpiTasks() {
    var today = M.todayTasks();
    var open = today.filter(function (x) { return x.status === 'Open'; });
    var late = M.overdue();
    return UI.kpi({ href: '#/tasks', icon: 'tasks', tone: 'is-accent', label: t('day.kTasks'), value: P.fmt.num(open.length),
      foot: h`<span>${late.length ? h`<strong>${t('day.kLate', { n: late.length })}</strong> · ` : ''}${t('day.kDone', { n: today.length - open.length })}</span>` });
  }
  function kpiWeek() {
    var hours = M.sumHours(M.timeFor(P.me().id, -7, -3));
    var norm = D.dailyTarget * 5;
    return UI.kpi({ href: '#/time', icon: 'clock', tone: hours < norm ? 'is-warn' : 'is-good', label: t('day.kLastWeek', { week: 42 }), value: P.fmt.num(hours),
      unit: t('day.kOfHours', { hours: P.fmt.num(norm) }), foot: hours < norm ? h`<span><strong>${t('day.kMissing', { hours: P.fmt.hours(norm - hours) })}</strong> · ${t('day.kShortDay')}</span>` : t('day.kWeekFull') });
  }
  function kpiBanks() {
    var low = M.lowBanks().filter(function (c) { return P.state.role === 'admin' || c.tech === P.me().id || c.am === P.me().id; });
    var first = low[0];
    return UI.kpi({ href: '#/contracts', icon: 'hourglass', tone: low.length ? 'is-warn' : 'is-good', label: t('day.kBanks'), value: P.fmt.num(low.length),
      foot: first ? h`<span><strong>${first.name}</strong> · ${t('bank.left', { left: P.fmt.num(first.hourBank.left), size: P.fmt.num(first.hourBank.size) })}</span>` : t('day.kBanksNone') });
  }
  function kpiApprovals() {
    var q = M.approvalQueue();
    var n = q.reduce(function (s, g) { return s + g.entries.length; }, 0);
    var hours = q.reduce(function (s, g) { return s + g.hours; }, 0);
    return UI.kpi({ href: '#/time/approve', icon: 'listChecks', tone: n ? 'is-accent' : 'is-good', label: t('day.kApprovals'), value: P.fmt.num(n),
      unit: t('day.kEntries', { n: n }), foot: h`<span><strong>${P.fmt.hours(hours)}</strong> · ${t('day.kApprovalsWho', { n: q.length, week: 42 })}</span>` });
  }
  function kpiOutstanding() {
    var o = M.outstanding();
    return UI.kpi({ href: '#/invoices', icon: 'wallet', tone: o.overdue.length ? 'is-warn' : 'is-good', label: t('day.kOutstanding'), value: UI.money(Math.round(o.sum)),
      foot: h`<span><strong>${t('day.kOverdueInv', { n: o.overdue.length })}</strong> · ${UI.money(Math.round(o.overdueSum))}</span>` });
  }
  function kpiBilling() {
    var run = D.billingRuns[0];
    return UI.kpi({ href: '#/billing', icon: 'send', tone: run.failed + run.reconcile ? 'is-warn' : 'is-good', label: t('day.kBilling', { month: P.fmt.month(run.y, run.m) }),
      value: t('day.kSentOf', { sent: run.sent, total: run.bases }), foot: h`<span><strong>${t('billing.failedN', { n: run.failed })}</strong> · ${t('billing.reconcileN', { n: run.reconcile })}</span>` });
  }

  /* ---------- Cards ---------- */

  function planCard(cls) {
    var list = M.todayTasks();
    var done = list.filter(function (x) { return x.status === 'Done'; }).length;
    var late = list.filter(function (x) { return x.status === 'Open' && x.due < P.NOW && !P.sameDay(x.due, P.NOW); });
    var rest = list.filter(function (x) { return late.indexOf(x) === -1; });
    var pct = list.length ? done / list.length : 0;
    var body = list.length ? h`
      <div class="plan-progress"><div class="meter is-ink" role="img" aria-label="${t('day.planProgress', { done: done, n: list.length })}"><span style="width:${(pct * 100).toFixed(0)}%"></span></div>
        <span class="small muted num">${t('day.planProgress', { done: done, n: list.length })}</span></div>
      ${late.length ? h`<p class="group-label small strong">${P.icon('alert', 'ic-14')}${t('task.groupLate')}<span class="count">${late.length}</span></p>` : ''}
      <div class="rows">${late.map(function (x) { return R.taskRow(x); })}</div>
      ${late.length ? h`<p class="group-label small strong">${P.icon('calendar', 'ic-14')}${t('task.groupToday')}<span class="count">${rest.length}</span></p>` : ''}
      <div class="rows">${rest.map(function (x) { return R.taskRow(x); })}</div>` : UI.empty('tasks', t('day.planEmpty'), t('day.planEmptyText'));
    return UI.card({ cls: cls || 'w-7', title: t('day.plan'), icon: 'calendar', titleId: 'c-plan', body: body,
      tools: h`<a class="btn btn-link" href="#/tasks">${t('day.allTasks')}</a>` });
  }

  /* The five most severe and most recent; the queue holds the rest, so the card never outgrows the plan */
  var URGENT_ROWS = 5;
  function urgentCard(cls) {
    var all = M.sortAlerts(M.urgent());
    var list = all.slice(0, URGENT_ROWS);
    var byCustomer = {};
    list.forEach(function (a) { (byCustomer[a.customer] = byCustomer[a.customer] || []).push(a); });
    var keys = Object.keys(byCustomer).sort(function (a, b) {
      return D.SEV_ORDER[byCustomer[a][0].severity] - D.SEV_ORDER[byCustomer[b][0].severity] || byCustomer[b].length - byCustomer[a].length;
    });
    var body = keys.length ? keys.map(function (k) {
      var items = byCustomer[k];
      return h`<div class="alert-group"><p class="group-label small"><a class="link-plain" href="#/customers/${k}/operations">${D.customer(k).name}</a></p>
        <div class="rows">${items.map(function (a) { return R.alertRow(a, { hideCustomer: true }); })}</div></div>`;
    }) : UI.empty('shieldCheck', t('day.urgentEmpty'), t('day.urgentEmptyText'));
    var foot = h`<span class="row-wrap">${all.length > list.length ? h`<strong>${t('day.shownOf', { shown: list.length, n: all.length })}</strong> · ` : ''}${t('sync.at', { time: P.fmt.time(D.syncedAt) })}
      ${D.unmatchedAlerts ? h`<span class="pill pill-warn">${P.icon('link', 'ic-14')}${t('day.unmatched', { n: D.unmatchedAlerts })}</span>` : ''}</span>`;
    return UI.card({ cls: cls || 'w-5', title: t('day.urgent'), icon: 'pulse', titleId: 'c-urgent', count: all.length, body: body, foot: foot,
      tools: h`<a class="btn btn-link" href="#/alerts">${t('day.allAlerts')}</a>
        <button class="icon-btn is-sm" type="button" data-action="reread-saved" aria-label="${t('day.reread')}" title="${t('day.reread')}">${P.icon('refresh', 'ic-16')}</button>` });
  }

  function weekCard(cls) {
    var days = M.weekDays(P.me().id, -7).slice(0, 5).map(function (d) {
      return { label: P.fmt.weekday(d.date, 'long') + ' ' + P.fmt.dm(d.date), short: P.fmt.weekday(d.date) + ' ' + P.fmt.dm(d.date), tiny: P.fmt.weekday(d.date), hours: d.hours };
    });
    var minIdx = days.reduce(function (m, d, i) { return d.hours < days[m].hours ? i : m; }, 0);
    var total = days.reduce(function (s, d) { return s + d.hours; }, 0);
    var asTable = P.state.ui.chartTable && P.state.ui.chartTable.week;
    var shortDay = P.at(-7 + minIdx);
    var gap = D.dailyTarget - days[minIdx].hours;
    /* The chart names the gap and offers the one action that closes it, with the date already filled in */
    var fix = gap > 0 && P.can('time.own') ? h`<div class="week-gap"><span class="small">${t('day.gapLine', { day: P.fmt.longDay(shortDay), hours: P.fmt.hours(gap) })}</span>
      <button class="btn btn-sm" type="button" data-action="log-time" data-date="${shortDay.getFullYear()}-${String(shortDay.getMonth() + 1).padStart(2, '0')}-${String(shortDay.getDate()).padStart(2, '0')}">${P.icon('timer', 'ic-16')}${t('day.logForDay', { day: P.fmt.weekday(shortDay) + ' ' + P.fmt.dm(shortDay) })}</button></div>` : '';
    return UI.card({ cls: cls || 'w-4', title: t('day.week', { week: 42 }), icon: 'chart', titleId: 'c-week',
      tools: h`<button class="btn btn-sm btn-quiet" type="button" data-action="chart-table" data-value="week" aria-pressed="${asTable ? 'true' : 'false'}">${asTable ? t('chart.asChart') : t('chart.asTable')}</button>
        <a class="btn btn-link" href="#/time">${t('day.openWeek')}</a>`,
      body: h`<p class="small muted">${t('day.weekTotal', { hours: P.fmt.hours(total), norm: P.fmt.hours(D.dailyTarget * 5) })}</p>
        ${P.charts.dayBars({ key: 'week', days: days, target: D.dailyTarget, emphasis: minIdx, title: t('day.weekChartTitle', { week: 42 }) })}${fix}`,
      foot: h`<span>${t('day.weekFoot')}</span>` });
  }

  function ticketsCard(cls) {
    var mine = D.tickets.filter(function (x) { return (x.status === 'Open' || x.status === 'Pending') && x.tech === P.me().id; });
    return UI.card({ cls: cls || 'w-4', title: t('day.tickets'), icon: 'ticket', titleId: 'c-tickets', count: mine.length,
      body: mine.length ? h`<div class="rows">${mine.slice(0, 4).map(R.ticketRow)}</div>` : UI.empty('ticket', t('day.ticketsEmpty'), ''),
      foot: h`<span class="row">${P.icon('database', 'ic-14')}${t('day.ticketsSaved', { time: P.fmt.time(D.ticketsReadAt) })}</span>` });
  }

  function sourcesCard(cls) {
    return UI.card({ cls: cls || 'w-4', title: t('day.sources'), icon: 'database', titleId: 'c-sources',
      tools: h`<a class="btn btn-link" href="#/connections">${t('nav.connections')}</a>`,
      body: h`<ul class="rows">${D.sources.map(function (s) {
        return h`<li class="item source-item"><span class="tl-icon">${P.icon(UI.sourceIcon(s.source), 'ic-16')}</span>
          <div class="item-main"><span class="item-title">${t(s.label)}</span><span>${UI.fresh(s.status, s.asOf)}</span>
            ${s.why ? h`<span class="small muted">${t(s.why)}</span>` : ''}</div></li>`;
      })}</ul>`,
      foot: h`<span>${t('day.sourcesFoot')}</span>` });
  }

  function feedCard(cls) {
    return UI.card({ cls: cls || 'w-7', title: t('day.feed'), icon: 'history', titleId: 'c-feed',
      body: h`<ol class="timeline">${D.feed.slice().sort(function (a, b) { return b.at - a.at; }).slice(0, 5).map(R.feedRow)}</ol>` });
  }

  function remindersCard(cls) {
    var list = D.reminders.filter(function (r) { return P.state.role === 'admin' || D.customer(r.customer).tech === P.me().id || D.customer(r.customer).am === P.me().id; });
    return UI.card({ cls: cls || 'w-5', title: t('day.reminders'), icon: 'contract', titleId: 'c-rem', count: list.length,
      body: list.length ? h`<div class="rows">${list.map(function (r) {
        var c = D.customer(r.customer);
        var text = r.kind === 'HourBankLow' ? t('bank.left', { left: P.fmt.num(r.left), size: P.fmt.num(r.size) })
          : t('rem.' + r.kind + 'Text', { date: P.fmt.date(r.date), n: P.dayDiff(r.date, P.NOW), contract: P.fmt.id(r.contract) });
        return h`<div class="item"><span class="tl-icon">${P.icon(r.kind === 'HourBankLow' ? 'hourglass' : 'calendar', 'ic-16')}</span>
          <div class="item-main"><a class="item-title" href="#/customers/${c.id}/contract">${t('rem.' + r.kind)} · ${c.name}</a><span class="small muted">${text}</span></div>
          <div class="item-side"><button class="btn btn-sm btn-quiet" type="button" data-action="ack-reminder" data-value="${r.customer + r.kind}">${t('rem.done')}</button></div></div>`;
      })}</div>` : UI.empty('contract', t('day.remindersEmpty'), '') });
  }

  function approvalsCard(cls) {
    var q = M.approvalQueue();
    return UI.card({ cls: cls || 'w-7', title: t('day.approvals', { week: 42 }), icon: 'listChecks', titleId: 'c-appr',
      body: q.length ? h`<div class="rows">${q.map(function (g) {
        var billable = M.sumHours(g.entries.filter(function (e) { return e.billable; }));
        return h`<div class="item">${UI.avatar(g.staff)}
          <div class="item-main"><span class="item-title">${D.staff[g.staff].name}</span>
            <span class="small muted">${t('day.approvalLine', { n: g.entries.length, hours: P.fmt.hours(g.hours), billable: P.fmt.hours(billable) })}</span></div>
          <div class="item-side"><a class="btn btn-sm" href="#/time/approve">${t('day.review')}</a></div></div>`;
      })}</div>` : UI.empty('listChecks', t('day.approvalsEmpty'), '') });
  }

  function teamCard(cls) {
    var staff = Object.keys(D.staff);
    var max = Math.max.apply(null, staff.map(function (s) { return M.openTasks(s).length; }).concat([1]));
    return UI.card({ cls: cls || 'w-5', title: t('day.team'), icon: 'users', titleId: 'c-team',
      body: h`<div class="rows">${staff.map(function (s) {
        var open = M.openTasks(s);
        var late = M.overdue(s).length;
        var today = open.filter(function (x) { return x.due && P.sameDay(x.due, P.NOW); }).length;
        return h`<div class="item">${UI.avatar(s)}
          <div class="item-main"><span class="item-title">${D.staff[s].name}</span>
            <div class="meter is-ink" style="max-width:220px" role="img" aria-label="${t('day.teamOpen', { n: open.length })}"><span style="width:${(open.length / max * 100).toFixed(0)}%"></span></div></div>
          <div class="item-side small num"><span>${t('day.teamToday', { n: today })}</span>${late ? h`<span class="pill pill-crit">${t('day.kLate', { n: late })}</span>` : ''}</div></div>`;
      })}</div>` });
  }

  function overdueCard(cls) {
    var o = M.outstanding();
    var list = o.overdue.slice().sort(function (a, b) { return b.outstanding - a.outstanding; });
    return UI.card({ cls: cls || 'w-7', title: t('day.overdueInvoices'), icon: 'files', titleId: 'c-over', count: list.length,
      tools: h`<a class="btn btn-link" href="#/invoices">${t('nav.invoices')}</a>`,
      body: h`<div class="rows">${list.slice(0, 5).map(function (inv) {
        var c = D.customer(inv.customer);
        return h`<div class="item"><span class="tl-icon">${P.icon('files', 'ic-16')}</span>
          <div class="item-main"><button class="item-title linklike" type="button" data-action="open-invoice" data-id="${inv.no}">${t('fin.invoiceNo', { no: inv.no })} · ${c.name}</button>
            <span class="small muted">${t('fin.dueSince', { date: P.fmt.date(inv.due), n: P.dayDiff(P.NOW, inv.due) })}</span></div>
          <div class="item-side">${UI.money(inv.outstanding, { cls: 'strong' })}</div></div>`;
      })}</div>`,
      foot: h`<span>${t('day.shownOf', { shown: Math.min(5, list.length), n: list.length })} · ${t('fin.syncedAt', { time: P.fmt.time(D.financeReadAt) })}</span>` });
  }

  function billingCard(cls) {
    var run = D.billingRuns[0];
    return UI.card({ cls: cls || 'w-5', title: t('day.billingRun', { month: P.fmt.month(run.y, run.m) }), icon: 'receipt', titleId: 'c-bill',
      body: h`${P.views.billing.stepper(run, true)}
        <dl class="facts run-facts">
          <div class="fact"><dt>${t('billing.sent')}</dt><dd class="fact-big num">${P.fmt.num(run.sent)}</dd></div>
          <div class="fact"><dt>${t('billing.failed')}</dt><dd class="fact-big num">${P.fmt.num(run.failed)}</dd></div>
          <div class="fact"><dt>${t('billing.reconcile')}</dt><dd class="fact-big num">${P.fmt.num(run.reconcile)}</dd></div></dl>
        ${UI.banner('warn', t('billing.needsAction'), t('billing.needsActionText', { failed: run.failed, reconcile: run.reconcile }), h`<a class="btn btn-sm" href="#/billing">${t('billing.open')}</a>`)}` });
  }

  /* A narrow column of short cards next to one long list keeps both sides of a row about equally tall */
  function col(cls, cards) {
    return function () { return h`<div class="dash-col ${cls}">${cards.map(function (fn) { return fn(); })}</div>`; };
  }
  function cardIn(fn, cls) { return function () { return fn(cls); }; }

  var LAYOUT = {
    technician: { kpis: [kpiUrgent, kpiTasks, kpiWeek, kpiBanks],
      rows: [[cardIn(planCard, 'w-7'), cardIn(urgentCard, 'w-5')],
        [cardIn(weekCard, 'w-4'), cardIn(ticketsCard, 'w-4'), cardIn(sourcesCard, 'w-4 t-12')],
        [cardIn(feedCard, 'w-7'), cardIn(remindersCard, 'w-5')]] },
    servicelead: { kpis: [kpiUrgent, kpiTasks, kpiApprovals, kpiBanks],
      rows: [[cardIn(approvalsCard, 'w-7'), cardIn(teamCard, 'w-5')],
        [cardIn(urgentCard, 'w-7'), col('w-5', [cardIn(planCard, ''), cardIn(remindersCard, '')])],
        [cardIn(feedCard, 'w-7'), cardIn(sourcesCard, 'w-5')]] },
    admin: { kpis: [kpiUrgent, kpiOutstanding, kpiBilling, kpiTasks],
      rows: [[cardIn(overdueCard, 'w-7'), cardIn(billingCard, 'w-5')],
        [cardIn(urgentCard, 'w-7'), col('w-5', [cardIn(planCard, ''), cardIn(remindersCard, '')])],
        [cardIn(feedCard, 'w-12')]] }
  };

  P.views.day = {
    render: function () {
      var lay = LAYOUT[P.state.role];
      var dateChip = h`<span class="pill pill-outline date-chip">${P.icon('calendar', 'ic-14')}${t('day.dateChip', { date: P.fmt.longDay(P.NOW), week: P.isoWeek(P.NOW) })}</span>`;
      var actions = h`${dateChip}
        ${P.can('time.own') ? h`<button class="btn" type="button" data-action="log-time">${P.icon('timer', 'ic-16')}${t('create.time')}</button>` : ''}
        ${P.can('activities') ? h`<button class="btn btn-primary" type="button" data-action="new-task">${P.icon('plus', 'ic-16')}${t('create.task')}</button>` : ''}`;
      return {
        title: t('nav.day'),
        crumbs: [{ label: 'Parasoll', href: '#/day' }, { label: t('nav.day') }],
        body: h`${UI.pageHead({ title: greeting(), sub: summary(), actions: actions })}
          <div class="kpis">${lay.kpis.map(function (k) { return k(); })}</div>
          <div class="dash">${lay.rows.map(function (row) { return row.map(function (fn) { return fn(); }); })}</div>`
      };
    }
  };

  /* Re-reads what the CRM has saved; syncing from Atera and Huntress is the background worker's job */
  P.on('reread-saved', function () {
    P.toast(t('day.refreshed', { time: P.fmt.time(P.NOW) }));
  });
  P.on('ack-reminder', function (el) {
    var key = el.dataset.value;
    D.reminders = D.reminders.filter(function (r) { return r.customer + r.kind !== key; });
    P.toast(t('rem.acked'));
    P.app.refresh();
  });
})();
