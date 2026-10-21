/* Parasoll UX demo: customer card tabs (operations, work, finance, agreement, contacts, journal). */
(function () {
  'use strict';

  var P = window.P;
  var h = P.html;
  var t = P.t;
  var D = P.data;
  var M = P.model;
  var UI = P.ui$;
  var R = P.rows;
  var TABS = P.customerTabs;

  function sub(key, options, def) {
    var v = P.state.ui[key] || def;
    return { value: v, seg: UI.seg('csub', options.map(function (o) { return Object.assign({}, o, { value: key + '|' + o.value }); }), key + '|' + v) };
  }
  P.on('csub', function (el) {
    var parts = el.dataset.value.split('|');
    P.state.ui[parts[0]] = parts[1];
    P.app.refresh();
  });

  /* ---------- Operations: summary, then alerts, then devices with their open alerts ---------- */

  /* The least fresh connected source speaks for the whole summary */
  function weakest(sources) {
    var order = { ERROR: 0, STALE: 1, MISSING: 2, UNAVAILABLE: 3, OK: 4 };
    var used = sources.filter(function (x) { return x.status !== 'NOT_CONNECTED'; });
    return used.slice().sort(function (a, b) { return order[a.status] - order[b.status] || (a.asOf || 0) - (b.asOf || 0); })[0];
  }

  var DEVICE_ROWS = 10;
  function deviceIcon(d) { return d.kind === 'server' ? 'server' : d.kind === 'laptop' ? 'laptop' : 'monitor'; }
  function onlineState(d) {
    if (d.online == null) return h`<span class="muted">—</span>`;
    return d.online ? h`<span class="row small">${P.icon('circleCheck', 'ic-14')}${t('device.online')}</span>`
      : h`<span class="row small muted">${P.icon('minusCircle', 'ic-14')}${t('device.offline')}</span>`;
  }
  function openAlertsOf(mine) {
    return mine.length ? h`<span class="row-wrap nowrap">${UI.sev(mine[0].severity)}<span class="small num">${t('ops.openN', { n: mine.length })}</span></span>`
      : h`<span class="muted small">${t('ops.none')}</span>`;
  }
  function historyButton(d) {
    return h`<button class="btn btn-sm btn-quiet" type="button" data-action="open-device" data-id="${d.id}" aria-label="${t('ops.historyFor', { host: d.host })}">${t('ops.historyBtn')}</button>`;
  }

  /* Devices with open alerts first (worst first), then the rest in Atera order; the first ten, or all on request */
  function devicesCard(c, devices, open) {
    var rows = devices.map(function (d, i) { return { d: d, i: i, mine: open.filter(function (a) { return a.device === d.id; }) }; })
      .sort(function (x, y) {
        var rx = x.mine.length ? D.SEV_ORDER[x.mine[0].severity] : 9;
        var ry = y.mine.length ? D.SEV_ORDER[y.mine[0].severity] : 9;
        return rx - ry || y.mine.length - x.mine.length || x.i - y.i;
      });
    var all = !!P.state.ui['ops-all-' + c.id];
    var shown = all ? rows : rows.slice(0, DEVICE_ROWS);
    var toggle = rows.length > DEVICE_ROWS ? h`<button class="btn btn-sm" type="button" data-action="ops-devices" data-id="${c.id}" data-focus="ops-devices" aria-expanded="${all ? 'true' : 'false'}">${all ? t('ops.showFewer') : t('ops.showAll', { n: rows.length })}</button>` : '';
    return UI.card({ flush: true, title: t('cust.devices'), icon: 'monitor', titleId: 'ops-devices', count: devices.length, body: h`<div class="table-wrap only-wide"><table class="table">
        <caption class="sr-only">${t('cust.devices')}</caption>
        <thead><tr><th scope="col">${t('ops.colDevice')}</th><th scope="col">${t('ops.colSources')}</th><th scope="col">${t('ops.colOs')}</th>
          <th scope="col">${t('ops.colState')}</th><th scope="col">${t('cust.openAlerts')}</th><th scope="col"><span class="sr-only">${t('common.actions')}</span></th></tr></thead>
        <tbody>${shown.map(function (x) {
          var d = x.d;
          return h`<tr><td><div class="row">${P.icon(deviceIcon(d), 'ic-16 muted')}<span class="strong break">${d.host}</span></div></td>
            <td><div class="row-wrap">${d.sources.map(function (s) { return h`<span class="tag">${UI.sourceName(s)}</span>`; })}${d.sources.length < 2 ? h`<span class="small muted">${t('ops.partial')}</span>` : ''}</div></td>
            <td class="nowrap">${d.os || h`<span class="muted">—</span>`}</td>
            <td class="nowrap">${onlineState(d)}</td>
            <td>${openAlertsOf(x.mine)}</td>
            <td class="t-right">${historyButton(d)}</td></tr>`;
        })}</tbody></table></div>
      <div class="rows only-narrow device-cards">${shown.map(function (x) {
        var d = x.d;
        return h`<div class="item device-item"><span class="tl-icon">${P.icon(deviceIcon(d), 'ic-16')}</span>
          <div class="item-main"><span class="item-title break">${d.host}</span>
            <div class="item-meta">${d.os ? h`<span>${d.os}</span>` : ''}${d.online == null ? '' : h`<span>${d.online ? t('device.online') : t('device.offline')}</span>`}
              <span>${d.sources.map(UI.sourceName).join(', ')}${d.sources.length < 2 ? ' · ' + t('ops.partial') : ''}</span></div>
            <div class="row-wrap">${openAlertsOf(x.mine)}</div></div>
          <div class="item-side">${historyButton(d)}</div></div>`;
      })}</div>
      <div class="list-foot"><span>${t('ops.devicesFoot', { time: P.fmt.time(D.syncedAt) })}</span>${toggle}</div>` });
  }
  P.on('ops-devices', function (el) { var k = 'ops-all-' + el.dataset.id; P.state.ui[k] = !P.state.ui[k]; P.app.refresh(); });

  TABS.operations = function (c) {
    if (c.atera !== 'LINKED') return UI.card({ body: P.noAteraState() });
    var devices = D.devicesOf(c.id);
    var alerts = D.alertsOf(c.id);
    var open = M.sortAlerts(alerts.filter(D.isOpen));
    var past = M.sortAlerts(alerts.filter(function (a) { return !D.isOpen(a); }));
    var urgent = open.filter(D.isUrgent).length;
    var offline = devices.filter(function (d) { return d.online === false; }).length;
    var sources = D.sourcesFor(c.id);
    /* A source that is not connected yet is a known gap, said once; "needs attention" is for connected ones */
    var review = sources.filter(function (x) { return x.status !== 'OK' && x.status !== 'NOT_CONNECTED'; });
    var later = sources.filter(function (x) { return x.status === 'NOT_CONNECTED'; });
    var oldest = weakest(sources);

    var summary = UI.card({ cls: 'ops-summary', body: h`<dl class="facts ops-facts">
        <div class="fact"><dt>${t('cust.openAlerts')}</dt><dd><span class="fact-big num">${P.fmt.num(open.length)}</span>${urgent ? h` <span class="pill pill-high">${t('cust.urgentN', { n: urgent })}</span>` : ''}</dd></div>
        <div class="fact"><dt>${t('cust.devices')}</dt><dd><span class="fact-big num">${P.fmt.num(devices.length)}</span>${offline ? h` <span class="small muted">${t('ops.offlineN', { n: offline })}</span>` : ''}</dd></div>
        <div class="fact"><dt>${t('alert.synced')}</dt><dd>${UI.fresh(oldest.status, oldest.asOf)}</dd></div>
        <div class="fact"><dt>${t('ops.link')}</dt><dd>${t('ops.ateraCustomer', { id: String(c.ateraId) })}</dd></div></dl>
      <details class="source-strip"><summary><span class="row-wrap">${P.icon('database', 'ic-16')}<strong>${t('ops.sources')}</strong>
          ${review.length ? h`<span class="pill pill-warn">${t('ops.sourcesReview', { n: review.length })}</span>` : h`<span class="pill pill-good">${t('ops.sourcesOk')}</span>`}
          ${later.length ? h`<span class="pill pill-outline">${P.icon('plug', 'ic-14')}${t('ops.notConnectedN', { n: later.length })}</span>` : ''}</span>${P.icon('chevronDown', 'ic-16 muted')}</summary>
        <ul class="rows">${sources.map(function (x) {
          return h`<li class="item"><span class="tl-icon">${P.icon(UI.sourceIcon(x.source), 'ic-16')}</span>
            <div class="item-main"><span class="item-title">${t(x.label)}</span>${x.why ? h`<span class="small muted">${t(x.why)}</span>` : ''}</div>
            <div class="item-side">${UI.fresh(x.status, x.asOf)}</div></li>`;
        })}</ul><p class="small muted">${t('ops.sourcesNote')}</p></details>` });

    var alertsCard = UI.card({ title: t('cust.openAlerts'), icon: 'pulse', titleId: 'ops-alerts', count: open.length,
      body: h`${open.length ? h`<div class="rows">${open.map(function (a) { return R.alertRow(a, { hideCustomer: true }); })}</div>`
          : UI.empty('shieldCheck', t('ops.noOpen'), t('ops.noOpenText'))}
        ${past.length ? h`<details class="done-group"><summary class="small strong">${t('ops.history', { n: past.length })}</summary><div class="rows">${past.map(function (a) {
          var dev = R.deviceOf(a);
          return h`<div class="item"><span class="sev-rail ${UI.SEV[a.severity].rail}"></span><div class="item-main">
            <button class="item-title linklike" type="button" data-action="open-alert" data-id="${a.id}">${a.title}</button>
            <div class="item-meta">${UI.alertStatus(a.status)}<span class="break">${dev ? dev.host : ''}</span><span>${P.fmt.date(a.occurredAt)}</span></div></div><span></span></div>`;
        })}</div></details>` : ''}`,
      foot: h`<span>${t('sync.at', { time: P.fmt.time(D.syncedAt) })}</span>` });

    return h`<div class="stack-4">${summary}${alertsCard}${devicesCard(c, devices, open)}</div>`;
  };

  /* ---------- Work: tasks, saved tickets and this month's time in one place ---------- */

  TABS.work = function (c) {
    var tasks = D.tasks.filter(function (x) { return x.customer === c.id; });
    var tickets = D.ticketsOf(c.id);
    var entries = D.time.filter(function (e) { return e.customer === c.id && e.date >= P.at(-18); }).sort(function (a, b) { return b.date - a.date; });
    var s = sub('work-' + c.id, [
      { value: 'tasks', label: t('work.tasks'), count: tasks.filter(function (x) { return x.status === 'Open'; }).length },
      { value: 'tickets', label: t('work.tickets'), count: tickets.filter(function (x) { return x.status === 'Open' || x.status === 'Pending'; }).length },
      { value: 'time', label: t('work.time'), count: entries.length }
    ], 'tasks');
    var panel;
    if (s.value === 'tasks') {
      var open = M.sortTasks(tasks.filter(function (x) { return x.status === 'Open'; }));
      var done = tasks.filter(function (x) { return x.status === 'Done'; });
      panel = UI.card({ body: h`${open.length ? h`<div class="rows">${open.map(function (x) { return R.taskRow(x, { hideCustomer: true, showAssignee: true }); })}</div>` : UI.empty('tasks', t('cust.noWork'), '')}
        ${done.length ? h`<details class="done-group"><summary class="small strong">${t('work.done', { n: done.length })}</summary><div class="rows">${done.map(function (x) { return R.taskRow(x, { hideCustomer: true, showAssignee: true }); })}</div></details>` : ''}` });
    } else if (s.value === 'tickets') {
      panel = UI.card({ flush: true, body: h`<div class="table-wrap"><table class="table"><caption class="sr-only">${t('work.tickets')}</caption>
        <thead><tr><th scope="col">${t('ticket.col')}</th><th scope="col">${t('ticket.colStatus')}</th><th scope="col">${t('ticket.contactLabel')}</th><th scope="col">${t('ticket.tech')}</th><th scope="col">${t('ticket.last')}</th></tr></thead>
        <tbody>${tickets.map(function (tk) {
          return h`<tr><td><div class="cell-main"><button class="cell-title linklike" type="button" data-action="open-ticket" data-id="${tk.id}">#${tk.id} · ${tk.title}</button><span class="cell-sub">${t('ticketPriority.' + tk.priority)}</span></div></td>
            <td><span class="pill ${tk.status === 'Pending' ? 'pill-warn' : tk.status === 'Open' ? 'pill-outline' : 'pill-good'}">${t('ticketStatus.' + tk.status)}</span></td>
            <td>${tk.contact}</td><td>${D.staff[tk.tech].name}</td><td class="nowrap num">${P.fmt.when(tk.last)}</td></tr>`;
        })}</tbody></table></div><div class="list-foot"><span>${t('ticket.savedNote', { time: P.fmt.time(D.ticketsReadAt) })}</span></div>` });
    } else {
      var sum = M.sumHours(entries);
      var billable = M.sumHours(entries.filter(function (e) { return e.billable; }));
      panel = UI.card({ flush: true, body: h`<div class="table-wrap"><table class="table"><caption class="sr-only">${t('work.time')}</caption>
        <thead><tr><th scope="col">${t('time.date')}</th><th scope="col">${t('time.who')}</th><th scope="col">${t('time.desc')}</th><th scope="col" class="t-num">${t('time.hours')}</th><th scope="col">${t('time.status')}</th></tr></thead>
        <tbody>${entries.map(function (e) {
          return h`<tr><td class="nowrap num">${P.fmt.date(e.date)}</td><td>${D.staff[e.staff].name}</td>
            <td><div class="cell-main"><span>${P.L(e.desc)}</span><span class="cell-sub">${e.ticket ? '#' + e.ticket + ' · ' : ''}${e.source === 'atera' ? t('time.fromAtera') : t('time.fromCrm')}${e.onsite ? ' · ' + t('time.onsite') : ''}</span></div></td>
            <td class="t-num strong">${P.fmt.hours(e.hours)}</td><td>${P.views.time.statusPill(e)}</td></tr>`;
        })}</tbody></table></div>
        <div class="list-foot"><span class="num">${t('work.timeSum', { hours: P.fmt.hours(sum), billable: P.fmt.hours(billable) })}</span>
          ${P.can('time.own') ? h`<button class="btn btn-sm" type="button" data-action="log-time">${P.icon('timer', 'ic-16')}${t('create.time')}</button>` : ''}</div>` });
    }
    return h`<div class="stack-4"><div>${s.seg}</div>${panel}</div>`;
  };

  /* ---------- Finance (billing.read; amounts need finance.read) ---------- */

  TABS.finance = function (c) {
    var inv = D.invoicesOf(c.id);
    var out = P.views.customers.outstandingFor(c);
    var overdue = inv.filter(function (x) { return D.invoiceStatus(x) === 'Overdue'; });
    var s = sub('fin-' + c.id, [{ value: 'docs', label: t('fin.docs'), count: inv.length }, { value: 'ledger', label: t('fin.ledger') }], 'docs');
    var head = h`<dl class="facts fin-facts">
      <div class="fact"><dt>${t('fin.outstanding')}</dt><dd class="fact-big">${UI.money(out)}</dd></div>
      <div class="fact"><dt>${t('fin.overdue')}</dt><dd class="fact-big">${UI.money(overdue.reduce(function (sum, x) { return sum + x.outstanding; }, 0))}</dd></div>
      <div class="fact"><dt>${t('fin.docsN')}</dt><dd class="fact-big num">${P.fmt.num(inv.length)}</dd></div>
      <div class="fact"><dt>${t('fin.source')}</dt><dd>${UI.fresh('OK', D.financeReadAt)}</dd></div></dl>`;
    var panel = s.value === 'docs' ? P.views.finance.invoiceTable(inv, { hideCustomer: true }) : ledger(c);
    return h`<div class="stack-4">${P.can('finance') ? '' : UI.banner('info', t('perm.moneyTitle'), t('perm.moneyHint'), '', 'lock')}
      ${UI.card({ body: head })}<div>${s.seg}</div>${panel}</div>`;
  };

  function ledger(c) {
    var onlyPayments = P.state.ui['ledger-pay-' + c.id] !== false;
    var rows = D.ledgerOf(c.id).filter(function (r) { return !onlyPayments || r.kind === 'Payment'; });
    return UI.card({ flush: true, body: h`<div class="card-head"><label class="switch"><input type="checkbox" data-action="ledger-toggle" data-id="${c.id}" ${onlyPayments ? 'checked' : ''}>${t('fin.onlyPayments')}</label></div>
      <div class="table-wrap"><table class="table"><caption class="sr-only">${t('fin.ledger')}</caption>
      <thead><tr><th scope="col">${t('fin.posted')}</th><th scope="col">${t('fin.entryKind')}</th><th scope="col" class="t-num">${t('fin.amount')}</th><th scope="col">${t('fin.link')}</th></tr></thead>
      <tbody>${rows.map(function (r) {
        return h`<tr><td class="num nowrap">${P.fmt.date(r.date)}</td><td>${t('ledger.' + r.kind)}</td><td class="t-num">${UI.money(r.amount)}</td>
          <td>${r.match ? h`<span class="small">${t('fin.matched', { no: r.doc, group: r.match })}</span>` : h`<span class="small">${t('fin.direct', { no: r.doc })}</span>`}</td></tr>`;
      })}</tbody></table></div>
      <div class="list-foot"><span>${t('fin.ledgerNote')}</span></div>` });
  }
  P.on('ledger-toggle', function (el) { P.state.ui['ledger-pay-' + el.dataset.id] = el.checked; P.app.refresh(); });

  /* ---------- Agreement: contract lines, hour bank and SLA ---------- */

  TABS.contract = function (c) {
    var k = D.contractOf(c.id);
    if (!k) return UI.card({ body: UI.empty('contract', t('contract.none'), '') });
    var sla = D.slaPolicies[k.sla];
    var total = k.lines.reduce(function (s, l) { return s + l.qty * l.unit; }, 0);
    return h`<div class="split"><div class="stack-4">
      ${UI.card({ title: k.id + ' · ' + k.name, icon: 'contract', titleId: 'k-main', body: h`<dl class="kv">
          <dt>${t('contract.start')}</dt><dd class="num">${P.fmt.date(k.start)}</dd><dt>${t('contract.renewal')}</dt><dd class="num">${P.fmt.date(k.renewal)}</dd>
          <dt>${t('contract.notice')}</dt><dd class="num">${P.fmt.date(k.notice)} ${P.dayDiff(k.notice, P.NOW) <= 30 && P.dayDiff(k.notice, P.NOW) >= 0 ? h`<span class="pill pill-warn">${t('contract.inDays', { n: P.dayDiff(k.notice, P.NOW) })}</span>` : ''}</dd></dl>` })}
      ${UI.card({ flush: true, title: t('contract.lines'), icon: 'listChecks', titleId: 'k-lines', body: h`<div class="table-wrap"><table class="table is-fit"><caption class="sr-only">${t('contract.lines')}</caption>
        <thead><tr><th scope="col">${t('contract.line')}</th><th scope="col" class="t-num">${t('contract.qty')}</th><th scope="col" class="t-num">${t('contract.price')}</th><th scope="col" class="t-num">${t('contract.sum')}</th></tr></thead>
        <tbody>${k.lines.map(function (l) { return h`<tr><td>${P.L(l.text)}</td><td class="t-num">${P.fmt.num(l.qty)}</td><td class="t-num">${UI.money(l.unit)}</td><td class="t-num strong">${UI.money(l.qty * l.unit)}</td></tr>`; })}</tbody>
        <tfoot><tr><td colspan="3" class="strong">${t('contract.monthly')}</td><td class="t-num strong">${UI.money(total)}</td></tr></tfoot></table></div>` })}
    </div><div class="stack-4">
      ${UI.card({ title: t('cust.bankCard'), icon: 'hourglass', titleId: 'k-bank', body: c.hourBank ? h`${UI.bank(c.hourBank)}<p class="small muted">${t('contract.bankRule')}</p>` : h`<p class="muted">${t('cust.noBankText')}</p>` })}
      ${UI.card({ title: t('contract.sla', { win: k.sla.replace('x', '×') }), icon: 'clock', titleId: 'k-sla', body: h`<dl class="kv">
          <dt>${t('contract.window')}</dt><dd>${P.L(sla.days)} ${sla.window}</dd>
          ${['p1', 'p2', 'p3', 'p4'].map(function (p) { return h`<dt>${p.toUpperCase()} · ${t('contract.' + p)}</dt><dd class="num">${t('contract.respond', { hours: sla[p] })}</dd>`; })}</dl>
        <p class="small muted">${t('contract.slaNote')}</p>` })}
    </div></div>`;
  };

  /* ---------- Contacts and journal ---------- */

  var FIRST = ['Lars', 'Marte', 'Hanne', 'Ola', 'Siri', 'Kari', 'Per', 'Ingvild', 'Eirik', 'Tone', 'Magnus', 'Nora'];
  var LAST = ['Fjeld', 'Berg', 'Haugen', 'Nilsen', 'Dahle', 'Lunde', 'Moe', 'Strand', 'Bakke', 'Aas'];
  TABS.contacts = function (c) {
    var i = D.customers.indexOf(c);
    var people = [0, 1, 2].map(function (k) {
      var first = FIRST[(i * 3 + k) % FIRST.length];
      var last = LAST[(i + k * 4) % LAST.length];
      return { name: first + ' ' + last, role: t('contact.role' + k), email: (first + '.' + last).toLowerCase().replace(/ø/g, 'o').replace(/å/g, 'a').replace(/æ/g, 'ae') + '@example.no', phone: '4' + String(10000000 + (i * 7919 + k * 104729) % 9000000).slice(0, 7) };
    });
    return UI.card({ body: h`<div class="rows">${people.map(function (p, k) {
      return h`<div class="item"><span class="avatar" style="--av: var(--av-${(i + k) % 6 + 1}); --av-ink: var(--av-${(i + k) % 6 + 1}-ink)" aria-hidden="true">${p.name.split(' ').map(function (w) { return w[0]; }).join('')}</span>
        <div class="item-main"><span class="item-title">${p.name}${k === 0 ? h` <span class="pill pill-outline">${t('contact.primary')}</span>` : ''}</span>
          <div class="item-meta"><span>${p.role}</span><span class="break">${p.email}</span><span class="num">${p.phone.replace(/(\d{3})(\d{2})(\d{3})/, '$1 $2 $3')}</span></div></div><span></span></div>`;
    })}</div><p class="small muted">${t('contact.note')}</p>` });
  };

  TABS.journal = function (c) {
    var ev = [];
    D.tasks.filter(function (x) { return x.customer === c.id; }).forEach(function (x) {
      ev.push({ at: x.createdAt, icon: 'plus', text: t('journal.taskCreated', { title: UI.taskSubject(x), who: D.staff[x.createdBy].name }) });
      if (x.completedAt) ev.push({ at: x.completedAt, icon: 'circleCheck', text: t('journal.taskDone', { title: UI.taskSubject(x) }) });
    });
    D.ticketsOf(c.id).forEach(function (tk) { ev.push({ at: tk.created, icon: 'ticket', text: t('journal.ticket', { id: tk.id, title: tk.title }) }); });
    if (P.can('billing')) D.invoicesOf(c.id).forEach(function (x) { ev.push({ at: x.date, icon: 'files', text: t(x.kind === 'CreditNote' ? 'journal.credit' : 'journal.invoice', { no: x.no }) }); });
    ev.sort(function (a, b) { return b.at - a.at; });
    return UI.card({ body: h`<ol class="timeline">${ev.slice(0, 14).map(function (e) {
      return h`<li class="tl-item"><span class="tl-icon">${P.icon(e.icon, 'ic-16')}</span><div class="tl-text"><p>${e.text}</p><p class="muted">${P.fmt.dateTime(e.at)}</p></div></li>`;
    })}</ol>` });
  };
})();
