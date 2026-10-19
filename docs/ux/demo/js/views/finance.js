/* Parasoll UX demo: billing runs and PowerOffice invoices. Wording follows the ledger rules:
   nothing is called "paid"; a balance at zero is "nothing outstanding", a payment is a posted ledger entry. */
(function () {
  'use strict';

  var P = window.P;
  var h = P.html;
  var t = P.t;
  var D = P.data;
  var M = P.model;
  var UI = P.ui$;

  var F = (P.views.finance = {});

  F.statusPill = function (inv) {
    var s = D.invoiceStatus(inv);
    var map = { Paid: ['pill-good', 'circleCheck'], Overdue: ['pill-crit', 'alert'], PartiallyPaid: ['pill-warn', 'circleDashed'], Sent: ['pill-outline', 'send'], Credited: ['', 'undo'] };
    var m = map[s];
    return h`<span class="pill ${m[0]}">${P.icon(m[1], 'ic-14')}${t('inv.' + s)}</span>`;
  };

  F.invoiceTable = function (list, opts) {
    opts = opts || {};
    if (!list.length) return UI.card({ body: UI.empty('files', t('fin.noDocs'), '') });
    return UI.card({ flush: true, body: h`<div class="table-wrap"><table class="table">
      <caption class="sr-only">${t('fin.docs')}</caption>
      <thead><tr><th scope="col">${t('fin.doc')}</th>${opts.hideCustomer ? '' : h`<th scope="col">${t('task.customer')}</th>`}<th scope="col">${t('fin.date')}</th><th scope="col">${t('fin.due')}</th>
        <th scope="col" class="t-num">${t('fin.total')}</th><th scope="col" class="t-num">${t('fin.outstanding')}</th><th scope="col">${t('fin.status')}</th><th scope="col">PDF</th></tr></thead>
      <tbody>${list.map(function (inv) {
        var c = D.customer(inv.customer);
        return h`<tr><td><button class="cell-title linklike num" type="button" data-action="open-invoice" data-id="${inv.no}">${t(inv.kind === 'CreditNote' ? 'fin.creditNo' : 'fin.invoiceNo', { no: inv.no })}</button></td>
          ${opts.hideCustomer ? '' : h`<td><a class="cell-title" href="#/customers/${c.id}/finance">${c.name}</a></td>`}
          <td class="num nowrap">${P.fmt.date(inv.date)}</td><td class="num nowrap">${inv.kind === 'CreditNote' ? '—' : P.fmt.date(inv.due)}</td>
          <td class="t-num">${UI.money(inv.total)}</td><td class="t-num strong">${UI.money(inv.outstanding)}</td><td>${F.statusPill(inv)}</td>
          <td>${inv.pdf === 'STORED' ? h`<span class="row small">${P.icon('shieldCheck', 'ic-14')}${t('pdf.stored')}</span>` : h`<span class="row small muted">${P.icon('circleDashed', 'ic-14')}${t('pdf.notStored')}</span>`}</td></tr>`;
      })}</tbody></table></div>
      <div class="list-foot"><span>${t('fin.foot', { time: P.fmt.time(D.financeReadAt) })}</span></div>` });
  };

  P.on('open-invoice', function (el) {
    var inv = D.invoices.filter(function (x) { return x.no === el.dataset.id; })[0];
    var c = D.customer(inv.customer);
    P.drawer.open(function () {
      var net = inv.lines.reduce(function (s, l) { return s + l.qty * l.unit; }, 0);
      return P.sheet({ eyebrow: c.name + ' · PowerOffice', title: t(inv.kind === 'CreditNote' ? 'fin.creditNo' : 'fin.invoiceNo', { no: inv.no }),
        meta: h`<div class="row-wrap">${F.statusPill(inv)}<span class="pill pill-outline">${t('cov.' + inv.coverage)}</span></div>`,
        body: h`<dl class="kv"><dt>${t('fin.date')}</dt><dd class="num">${P.fmt.date(inv.date)}</dd>
            ${inv.kind === 'Invoice' ? h`<dt>${t('fin.due')}</dt><dd class="num">${P.fmt.date(inv.due)}</dd>` : h`<dt>${t('fin.related')}</dt><dd class="num">${inv.related}</dd>`}
            <dt>${t('fin.net')}</dt><dd>${UI.money(net)}</dd><dt>${t('fin.totalVat')}</dt><dd>${UI.money(inv.total)}</dd>
            <dt>${t('fin.outstanding')}</dt><dd>${UI.money(inv.outstanding)}</dd></dl>
          <section class="sheet-section"><h3>${t('fin.lines')}</h3>
            <div class="table-wrap"><table class="table is-fit mini-table"><thead><tr><th scope="col">${t('contract.line')}</th><th scope="col" class="t-num">${t('contract.qty')}</th><th scope="col" class="t-num">${t('contract.sum')}</th></tr></thead>
              <tbody>${inv.lines.map(function (l) { return h`<tr><td>${P.L(l.text)}${l.period ? h`<span class="cell-sub" style="display:block">01.09.2026–30.09.2026</span>` : ''}</td><td class="t-num">${P.fmt.num(l.qty)}</td><td class="t-num">${UI.money(l.qty * l.unit)}</td></tr>`; })}</tbody></table></div>
            <p class="small muted">${t('cov.' + inv.coverage + 'Text')}</p></section>
          <section class="sheet-section"><h3>${t('pdf.title')}</h3>
            ${inv.pdf === 'STORED' ? h`<div class="device-box"><span class="tl-icon">${P.icon('files', 'ic-16')}</span><div class="item-main"><span class="item-title">${t('pdf.version', { n: 1 })}</span>
              <span class="small muted">${t('pdf.checked', { date: P.fmt.date(inv.date) })}</span></div><button class="btn btn-sm" type="button" data-action="pdf-demo">${P.icon('download', 'ic-16')}${t('pdf.download')}</button></div>`
              : h`<p class="muted">${t('pdf.notStoredText')}</p>`}</section>
          <p class="small muted">${t('fin.ledgerNote')}</p>`,
        foot: h`<a class="btn" href="#/customers/${c.id}/finance">${t('fin.openCustomer')}</a><span class="spacer"></span>
          ${D.invoiceStatus(inv) === 'Overdue' && P.can('activities') ? h`<button class="btn btn-primary" type="button" data-action="remind-invoice" data-id="${inv.no}">${P.icon('phone', 'ic-16')}${t('fin.remindTask')}</button>` : ''}` });
    }, { label: inv.no });
  });
  P.on('remind-invoice', function (el) {
    var inv = D.invoices.filter(function (x) { return x.no === el.dataset.id; })[0];
    P.actions['new-task']({ dataset: { customer: inv.customer, type: 'Call', subject: t('fin.remindSubject', { no: inv.no }) } });
  });
  P.on('pdf-demo', function () { P.toast(t('pdf.demo'), { tone: 'warn' }); });

  /* ---------- Billing runs ---------- */

  var STEPS = ['Draft', 'Collected', 'Approved', 'Exported', 'Closed'];
  F.stepper = function (run, compact) {
    var reached = { Closed: 4, ExportedWithErrors: 3, Exported: 3, Approved: 2, InReview: 1, Collected: 1, Draft: 0 }[run.status];
    var problem = run.status === 'ExportedWithErrors';
    return h`<ol class="stepper ${compact ? 'is-compact' : ''}">${STEPS.map(function (s, i) {
      var state = i < reached || (i === reached && !problem) ? 'is-done' : i === reached ? 'is-problem' : '';
      return h`<li class="step ${state}"><span class="step-dot">${P.icon(state === 'is-done' ? 'check' : state === 'is-problem' ? 'alert' : 'circleDashed', 'ic-14')}</span>
        <span class="step-text">${t('run.' + s)}</span></li>`;
    })}</ol>`;
  };

  P.views.billing = {
    perm: 'billing',
    stepper: F.stepper,
    render: function () {
      var run = D.billingRuns[0];
      var onlyFlags = P.state.ui.basesFlags !== false;
      var bases = D.bases.filter(function (b) { return !onlyFlags || b.flags.length || b.export !== 'Sent'; });
      var body = h`${UI.pageHead({ title: t('nav.billing'), sub: t('billing.sub') })}
        <div class="stack-4">
          ${UI.card({ title: t('billing.next', { month: P.fmt.month(2026, 9) }), icon: 'calendar', titleId: 'b-next',
            body: h`<p>${t('billing.nextText', { date: P.fmt.date(new Date(2026, 10, 2)) })}</p>`,
            foot: h`<span>${t('billing.nextFoot')}</span><button class="btn btn-sm" type="button" disabled>${t('billing.collect')}</button>` })}
          ${UI.card({ title: t('billing.run', { month: P.fmt.month(run.y, run.m) }), icon: 'receipt', titleId: 'b-run',
            tools: h`<span class="small muted">${t('billing.approvedBy', { who: D.staff[run.approvedBy].name, date: P.fmt.date(run.approvedAt) })}</span>`,
            body: h`${F.stepper(run)}
              <dl class="facts run-facts">
                <div class="fact"><dt>${t('billing.bases')}</dt><dd class="fact-big num">${P.fmt.num(run.bases)}</dd></div>
                <div class="fact"><dt>${t('billing.sent')}</dt><dd class="fact-big num">${P.fmt.num(run.sent)}</dd></div>
                <div class="fact"><dt>${t('billing.failed')}</dt><dd class="fact-big num">${P.fmt.num(run.failed)}</dd></div>
                <div class="fact"><dt>${t('billing.reconcile')}</dt><dd class="fact-big num">${P.fmt.num(run.reconcile)}</dd></div>
                <div class="fact"><dt>${t('billing.net')}</dt><dd class="fact-big">${UI.money(run.net)}</dd></div></dl>
              ${UI.banner('warn', t('billing.needsAction'), t('billing.needsActionText', { failed: run.failed, reconcile: run.reconcile }),
                h`<button class="btn btn-sm btn-primary" type="button" data-action="billing-retry" ${P.can('finance') ? '' : 'disabled'}>${t('billing.retry')}</button>
                  <button class="btn btn-sm" type="button" data-action="billing-reconcile" ${P.can('finance') ? '' : 'disabled'}>${t('billing.reconcileBtn')}</button>`)}
              ${P.can('finance') ? '' : h`<p class="small muted row">${P.icon('lock', 'ic-14')}${t('billing.financeOnly')}</p>`}`,
            foot: h`<span>${t('billing.closeHint')}</span><button class="btn btn-sm" type="button" disabled>${t('billing.close')}</button>` })}
          ${UI.card({ flush: true, title: t('billing.basesTitle'), icon: 'listChecks', titleId: 'b-bases', count: bases.length,
            tools: h`<label class="switch"><input type="checkbox" data-action="bases-flags" ${onlyFlags ? 'checked' : ''}>${t('billing.onlyFlags')}</label>`,
            body: h`<div class="table-wrap"><table class="table"><caption class="sr-only">${t('billing.basesTitle')}</caption>
              <thead><tr><th scope="col">${t('task.customer')}</th><th scope="col" class="t-num">${t('billing.netCol')}</th><th scope="col" class="t-num">${t('billing.delta')}</th><th scope="col">${t('billing.flags')}</th><th scope="col">${t('billing.export')}</th></tr></thead>
              <tbody>${bases.map(function (b) {
                var c = D.customer(b.customer);
                return h`<tr><td><a class="cell-title" href="#/customers/${c.id}/finance">${c.name}</a></td><td class="t-num">${UI.money(b.net)}</td>
                  <td class="t-num">${P.can('finance') ? h`<span class="${Math.abs(b.delta) >= 0.2 ? 'strong' : 'muted'}">${b.delta > 0 ? '+' : ''}${P.fmt.pct(b.delta)}</span>` : UI.money(0)}</td>
                  <td><div class="row-wrap">${b.flags.length ? b.flags.map(function (f) { return h`<span class="pill pill-warn is-wrap">${t('flag.' + f)}</span>`; }) : h`<span class="muted small">—</span>`}</div></td>
                  <td>${b.export === 'Sent' ? h`<span class="pill pill-good">${P.icon('check', 'ic-14')}${t('export.Sent')}</span>` : b.export === 'Failed' ? h`<span class="pill pill-crit">${P.icon('circleX', 'ic-14')}${t('export.Failed')}</span>` : h`<span class="pill pill-warn">${P.icon('compare', 'ic-14')}${t('export.ReconciliationRequired')}</span>`}</td></tr>`;
              })}</tbody></table></div>
              <div class="list-foot"><span>${t('billing.basesFoot', { shown: bases.length, n: D.bases.length })}</span></div>` })}
        </div>`;
      return { title: t('nav.billing'), crumbs: [{ label: 'Parasoll', href: '#/day' }, { label: t('nav.billing') }], body: body };
    }
  };
  P.on('bases-flags', function (el) { P.state.ui.basesFlags = el.checked; P.app.refresh(); });
  P.on('billing-retry', function () { P.toast(t('billing.retryDemo')); });
  P.on('billing-reconcile', function () { P.toast(t('billing.reconcileDemo')); });

  /* ---------- Company-wide invoices ---------- */

  P.views.invoices = {
    perm: 'billing',
    render: function () {
      var mode = P.state.ui.invMode || 'open';
      var all = D.invoices.slice().sort(function (a, b) { return b.date - a.date; });
      var list = all.filter(function (x) {
        var s = D.invoiceStatus(x);
        return mode === 'all' || (mode === 'overdue' ? s === 'Overdue' : x.outstanding > 0);
      });
      var o = M.outstanding();
      var body = h`${UI.pageHead({ title: t('nav.invoices'), sub: t('inv.sub') })}
        <div class="kpis kpis-3">
          ${UI.kpi({ action: 'inv-mode', value2: 'open', pressed: mode === 'open', icon: 'wallet', label: t('fin.outstanding'), value: UI.money(o.sum), foot: t('inv.openN', { n: o.open.length }) })}
          ${UI.kpi({ action: 'inv-mode', value2: 'overdue', pressed: mode === 'overdue', icon: 'alert', tone: 'is-crit', label: t('fin.overdue'), value: UI.money(o.overdueSum), foot: t('inv.overdueN', { n: o.overdue.length }) })}
          ${UI.kpi({ action: 'inv-mode', value2: 'all', pressed: mode === 'all', icon: 'files', label: t('inv.docs90'), value: P.fmt.num(all.length), foot: t('fin.syncedAt', { time: P.fmt.time(D.financeReadAt) }) })}
        </div>
        <div class="toolbar">${UI.seg('inv-mode', [{ value: 'open', label: t('inv.modeOpen'), count: o.open.length }, { value: 'overdue', label: t('inv.modeOverdue'), count: o.overdue.length }, { value: 'all', label: t('inv.modeAll'), count: all.length }], mode, t('inv.mode'))}</div>
        ${F.invoiceTable(list)}`;
      return { title: t('nav.invoices'), crumbs: [{ label: 'Parasoll', href: '#/day' }, { label: t('nav.invoices') }], body: body };
    }
  };
  P.on('inv-mode', function (el) { P.state.ui.invMode = el.dataset.value; P.app.refresh(); });
})();
