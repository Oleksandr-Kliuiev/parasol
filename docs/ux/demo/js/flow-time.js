/* Parasol UX demo: "Log time" from anywhere. Context fills the form (customer, task, ticket);
   the person types only what the system cannot know. The allocation is a preview until approval. */
(function () {
  'use strict';

  var P = window.P;
  var h = P.html;
  var t = P.t;
  var D = P.data;
  var M = P.model;
  var UI = P.ui$;

  var f = null;

  function pad(n) { return String(n).padStart(2, '0'); }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parse(s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }

  function closedMonth(date) {
    return D.monthLocks.filter(function (l) { return l.y === date.getFullYear() && l.m === date.getMonth() && l.status === 'closed'; })[0];
  }

  function preview() {
    var hours = Number(String(f.hours).replace(',', '.')) || 0;
    var a = M.allocate(f.customer, hours, f.billable, f.onsite);
    var c = D.customer(f.customer);
    var total = a.nonBillable + a.bank + a.rate || 1;
    var seg = function (v, color) { return v ? h`<span style="width:${(v / total * 100).toFixed(1)}%;background:${color}"></span>` : ''; };
    var low = c && c.hourBank && a.bankAfter != null && a.bankAfter / c.hourBank.size < 0.2;
    return h`<div class="alloc" aria-live="polite">
      <div class="stack" style="gap:0"><strong>${t('time.preview')}</strong><span class="small muted">${t('time.previewNote')}</span></div>
      <div class="alloc-bar" aria-hidden="true">${seg(a.bank, 'var(--good)')}${seg(a.rate, 'var(--accent)')}${seg(a.nonBillable, 'var(--faint)')}</div>
      <div class="alloc-legend">
        ${a.bank ? h`<span><i style="background:var(--good)"></i>${t('alloc.HourBank')} ${P.fmt.hours(a.bank)}</span>` : ''}
        ${a.rate ? h`<span><i style="background:var(--accent)"></i>${t('alloc.Rate')} ${P.fmt.hours(a.rate)}</span>` : ''}
        ${a.nonBillable ? h`<span><i style="background:var(--faint)"></i>${t('alloc.NonBillable')} ${P.fmt.hours(a.nonBillable)}</span>` : ''}
      </div>
      ${a.bankAfter != null && f.billable ? h`<p class="small ${low ? 'strong' : 'muted'}">${low ? P.icon('triangle', 'ic-14') : ''}${t('time.bankAfter', { left: P.fmt.num(a.bankAfter), size: P.fmt.num(c.hourBank.size) })}</p>` : ''}
      ${a.minApplied ? h`<p class="small muted">${t('time.onsiteMin')}</p>` : ''}
      ${a.rate && hours !== a.rate + a.bank ? h`<p class="small muted">${t('time.rounding')}</p>` : ''}
    </div>`;
  }

  function body() {
    var date = parse(f.date);
    var lock = closedMonth(date);
    var tasks = D.tasks.filter(function (x) { return x.customer === f.customer && x.status === 'Open' && x.assignee === P.me().id; });
    var tickets = D.ticketsOf(f.customer).filter(function (x) { return x.status === 'Open' || x.status === 'Pending'; });
    /* Today plus the last two working days (Monday morning: Friday and Thursday) */
    var days = [[0, t('when.today')], [-3, P.fmt.weekday(P.at(-3)) + ' ' + P.fmt.dm(P.at(-3))], [-4, P.fmt.weekday(P.at(-4)) + ' ' + P.fmt.dm(P.at(-4))]];
    return h`<form class="form" id="time-form" novalidate>
      ${f.context ? h`<p class="row small muted">${P.icon('link', 'ic-14')}${f.context}</p>` : ''}
      <div class="field"><label for="tf-customer">${t('task.customer')}</label>
        <select class="select" id="tf-customer" data-f="customer" data-focus="tf-customer"><option value="">${t('time.internal')}</option>${D.customers.map(function (c) { return h`<option value="${c.id}" ${f.customer === c.id ? 'selected' : ''}>${c.name}</option>`; })}</select></div>
      <div class="form-row">
        <div class="field"><label for="tf-task">${t('time.taskOrTicket')}</label>
          <select class="select" id="tf-task" data-f="link" data-focus="tf-task"><option value="">${t('time.noLink')}</option>
            ${tasks.map(function (x) { return h`<option value="task:${x.id}" ${f.link === 'task:' + x.id ? 'selected' : ''}>${t('time.taskPrefix')} ${UI.taskSubject(x)}</option>`; })}
            ${tickets.map(function (x) { return h`<option value="ticket:${x.id}" ${f.link === 'ticket:' + x.id ? 'selected' : ''}>#${x.id} · ${x.title}</option>`; })}</select></div>
      </div>
      <div class="field"><label for="tf-date">${t('time.date')}</label>
        <div class="form-row" style="align-items:center"><input class="input" type="date" id="tf-date" data-f="date" data-focus="tf-date" value="${f.date}" style="max-width:200px" ${lock ? P.raw('aria-invalid="true" aria-describedby="tf-date-err"') : ''}>
          <div class="quick-picks">${days.map(function (d) { var v = iso(P.at(d[0])); return h`<button class="chip" type="button" data-action="tf-day" data-value="${v}" aria-pressed="${f.date === v ? 'true' : 'false'}" data-focus="tf-day-${d[0]}">${d[1]}</button>`; })}</div></div>
        ${lock ? h`<span class="error" id="tf-date-err">${P.icon('lock', 'ic-14')}${t('time.locked', { month: P.fmt.month(lock.y, lock.m), who: D.staff[lock.by].name })}</span>` : ''}</div>
      <div class="field"><label for="tf-hours">${t('time.hours')}</label>
        <div class="form-row" style="align-items:center"><input class="input num" type="number" inputmode="decimal" min="0.25" max="24" step="0.25" id="tf-hours" data-f="hours" data-focus="tf-hours" value="${f.hours}" style="max-width:120px" aria-describedby="tf-hours-hint" autofocus>
          <div class="quick-picks">${[0.25, 0.5, 1, 2, 4].map(function (v) { return h`<button class="chip" type="button" data-action="tf-hours" data-value="${v}" aria-pressed="${Number(f.hours) === v ? 'true' : 'false'}" data-focus="tf-h-${v}">${P.fmt.hours(v)}</button>`; })}</div></div>
        <span class="hint" id="tf-hours-hint">${t('time.hoursHint')}</span></div>
      <div class="field"><label for="tf-desc">${t('time.desc')}</label>
        <textarea class="textarea" id="tf-desc" data-f="desc" data-focus="tf-desc" rows="2" placeholder="${t('time.descHint')}" ${f.descError ? P.raw('aria-invalid="true" aria-describedby="tf-desc-err"') : ''}>${f.desc}</textarea>
        ${f.descError ? h`<span class="error" id="tf-desc-err">${t('time.descRequired')}</span>` : ''}</div>
      <div class="row-wrap" style="gap:var(--s-4)">
        <label class="switch"><input type="checkbox" data-f="billable" ${f.billable ? 'checked' : ''} data-focus="tf-billable">${t('time.billable')}</label>
        <label class="switch"><input type="checkbox" data-f="onsite" ${f.onsite ? 'checked' : ''} data-focus="tf-onsite">${t('time.onsite')}</label>
      </div>
      ${preview()}
    </form>`;
  }

  function open(ctx) {
    P.popover.close();
    f = Object.assign({ customer: 'fjordlys', link: '', date: iso(P.NOW), hours: 1, desc: '', billable: true, onsite: false, context: '' }, ctx || {});
    P.drawer.open(function () {
      var lock = closedMonth(parse(f.date));
      var hours = Number(String(f.hours).replace(',', '.')) || 0;
      return P.sheet({ title: t('create.time'), eyebrow: P.me().name, body: body(),
        foot: h`<button class="btn" type="button" data-action="close-layer">${t('common.cancel')}</button><span class="spacer"></span>
          <button class="btn btn-primary" type="button" data-action="save-time" ${lock || !hours ? 'disabled' : ''}>${t('time.save', { hours: P.fmt.hours(hours) })}</button>` });
    }, { label: t('create.time') });
    var root = P.drawer.el;
    root.oninput = root.onchange = function (e) {
      var k = e.target.getAttribute('data-f');
      if (!k) return;
      f[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      if (k === 'customer' && e.type === 'change') { f.link = ''; f.billable = !!f.customer; P.drawer.refresh(); return; }
      if (k === 'date') { if (e.type === 'change') P.drawer.refresh(); return; }
      if (k === 'desc' && f.descError && String(f.desc).trim()) { f.descError = false; var err = document.getElementById('tf-desc-err'); if (err) err.remove(); e.target.removeAttribute('aria-invalid'); }
      if (k !== 'desc') updatePartial();
    };
  }

  /* Typing in the hours field must not re-render the form (the caret and a half-typed "1," would be lost) */
  function updatePartial() {
    var root = P.drawer.el;
    var box = root.querySelector('.alloc');
    if (box) box.outerHTML = P.toHtml(preview());
    var hours = Number(String(f.hours).replace(',', '.')) || 0;
    var btn = root.querySelector('[data-action="save-time"]');
    if (btn) { btn.textContent = t('time.save', { hours: P.fmt.hours(hours) }); btn.disabled = !hours || !!closedMonth(parse(f.date)); }
    P.$$('[data-action="tf-hours"]', root).forEach(function (b) { b.setAttribute('aria-pressed', Number(b.dataset.value) === hours ? 'true' : 'false'); });
  }

  P.on('log-time', function (el) {
    var ctx = {};
    var ds = (el && el.dataset) || {};
    if (ds.task) {
      var task = D.task(ds.task);
      ctx = { customer: task.customer, link: task.ticket ? 'ticket:' + task.ticket : 'task:' + task.id, taskId: task.id,
        context: t('time.fromTask', { title: UI.taskSubject(task) }), onsite: !!task.onsite };
    } else if (ds.date) {
      ctx = { date: ds.date };
    } else if (ds.ticket) {
      var tk = D.ticket(ds.ticket);
      ctx = { customer: tk.customer, link: 'ticket:' + tk.id, context: t('time.fromTicket', { id: tk.id }) };
    } else {
      var route = P.parseRoute();
      if (route.name === 'customer') ctx = { customer: route.params[0] };
    }
    open(ctx);
  });
  P.on('tf-hours', function (el) {
    f.hours = Number(el.dataset.value);
    var input = document.getElementById('tf-hours');
    if (input) input.value = f.hours;
    updatePartial();
  });
  P.on('tf-day', function (el) { f.date = el.dataset.value; P.drawer.refresh(); });

  P.on('save-time', function () {
    var hours = Number(String(f.hours).replace(',', '.'));
    if (!hours) return;
    if (f.billable && !String(f.desc).trim()) {
      f.descError = true;
      P.drawer.refresh();
      var d = document.getElementById('tf-desc');
      if (d) d.focus();
      return;
    }
    var link = f.link.split(':');
    var entry = M.logTime({ customer: f.customer || null, date: parse(f.date), hours: hours, billable: f.billable, onsite: f.onsite,
      desc: f.desc ? { ru: f.desc, en: f.desc, nb: f.desc } : { ru: 'Работа по задаче', en: 'Task work', nb: 'Arbeid med oppgave' },
      ticket: link[0] === 'ticket' ? link[1] : null, task: f.taskId || (link[0] === 'task' ? link[1] : null) });
    var taskId = entry.task;
    var c = D.customer(entry.customer);
    P.drawer.close();
    P.app.refresh();
    var task = taskId ? D.task(taskId) : null;
    P.toast(t('time.saved', { hours: P.fmt.hours(hours), customer: c ? c.name : t('time.internal') }), task && task.status === 'Open' ? {
      action: { label: t('time.alsoComplete'), fn: function () { P.actions['complete-task']({ dataset: { id: task.id } }); } }
    } : {});
  });
})();
