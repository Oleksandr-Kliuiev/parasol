/* Parasoll UX demo: task drawer, complete/reopen with undo, an edit conflict that keeps the draft,
   new task, and the saved Atera ticket view. */
(function () {
  'use strict';

  var P = window.P;
  var h = P.html;
  var t = P.t;
  var D = P.data;
  var M = P.model;
  var UI = P.ui$;
  var R = P.rows;

  var edit = null; /* { id, assignee, dueDate, dueTime, priority, conflict } */

  function pad(n) { return String(n).padStart(2, '0'); }
  function isoDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function isoTime(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function parseDue(date, time) {
    if (!date) return null;
    var p = date.split('-').map(Number);
    var q = (time || '12:00').split(':').map(Number);
    return new Date(p[0], p[1] - 1, p[2], q[0], q[1]);
  }

  /* ---------- Complete / reopen: separate from the alert and from saved hours ---------- */

  P.on('complete-task', function (el) {
    var task = D.task(el.dataset.id);
    M.complete(task);
    P.app.refresh();
    P.toast(t('task.completed', { title: UI.taskSubject(task) }), { action: { label: t('task.undo'), fn: function () { M.reopen(task); P.app.refresh(); } } });
    if (task.source) {
      var a = D.alert(task.source);
      if (a && D.isOpen(a)) setTimeout(function () { P.toast(t('task.alertStillOpen'), { tone: 'warn' }); }, 400);
    }
  });
  P.on('reopen-task', function (el) {
    var task = D.task(el.dataset.id);
    M.reopen(task);
    P.app.refresh();
    P.toast(t('task.reopened', { title: UI.taskSubject(task) }));
  });

  /* ---------- Task drawer ---------- */

  function startEdit(task) {
    edit = { id: task.id, assignee: task.assignee, dueDate: task.due ? isoDate(task.due) : '', dueTime: task.due ? isoTime(task.due) : '',
      priority: task.priority, conflict: null };
  }
  function dirty(task) {
    var due = parseDue(edit.dueDate, edit.dueTime);
    var same = (!due && !task.due) || (due && task.due && due.getTime() === task.due.getTime());
    return edit.assignee !== task.assignee || edit.priority !== task.priority || !same;
  }

  function conflictBox(task) {
    var c = edit.conflict;
    return h`<div class="banner is-warn" role="alert">${P.icon('compare')}
      <div><p class="banner-title">${t('conflict.title')}</p><p>${t('conflict.text', { who: D.staff[c.by].name, time: P.fmt.time(c.at) })}</p>
        <table class="diff"><thead><tr><th>${t('conflict.field')}</th><th>${t('conflict.mine')}</th><th>${t('conflict.theirs')}</th></tr></thead>
          <tbody><tr><td>${t('task.due')}</td><td class="num">${P.fmt.when(parseDue(edit.dueDate, edit.dueTime))}</td><td class="num">${P.fmt.when(c.due)}</td></tr></tbody></table>
        <div class="banner-actions">
          <button class="btn btn-sm btn-primary" type="button" data-action="conflict-keep">${t('conflict.keepMine')}</button>
          <button class="btn btn-sm" type="button" data-action="conflict-discard">${t('conflict.discard')}</button></div>
        <p class="small muted">${t('conflict.noRetry')}</p></div><span></span></div>`;
  }

  function taskBody(task) {
    var c = D.customer(task.customer);
    var a = task.source ? D.alert(task.source) : null;
    var dev = a ? R.deviceOf(a) : null;
    var tk = task.ticket ? D.ticket(task.ticket) : null;
    var entries = D.time.filter(function (e) { return e.task === task.id || (tk && e.ticket === tk.id && e.staff === task.assignee); });
    var staff = Object.keys(D.staff);
    var open = task.status === 'Open';
    return h`
      ${edit.conflict ? conflictBox(task) : ''}
      <section class="sheet-section"><h3>${t('task.details')}</h3>
        <div class="form-row">
          <div class="field"><label for="te-who">${t('assign.assignee')}</label>
            <select class="select" id="te-who" data-bind="assignee" ${open ? '' : 'disabled'}>${staff.map(function (s) { return h`<option value="${s}" ${edit.assignee === s ? 'selected' : ''}>${D.staff[s].name}</option>`; })}</select></div>
          <div class="field"><label for="te-pri">${t('task.priority')}</label>
            <select class="select" id="te-pri" data-bind="priority" ${open ? '' : 'disabled'}>${['Low', 'Normal', 'High'].map(function (p) { return h`<option value="${p}" ${edit.priority === p ? 'selected' : ''}>${t('priority.' + p)}</option>`; })}</select></div>
        </div>
        <div class="form-row">
          <div class="field"><label for="te-date">${t('task.dueDate')}</label><input class="input" type="date" id="te-date" data-bind="dueDate" value="${edit.dueDate}" ${open ? '' : 'disabled'}></div>
          <div class="field"><label for="te-time">${t('task.dueTime')}</label><input class="input" type="time" id="te-time" data-bind="dueTime" value="${edit.dueTime}" step="900" ${open ? '' : 'disabled'}></div>
        </div>
        <p class="small muted">${t('task.zoneNote')}</p>
      </section>
      ${a ? h`<section class="sheet-section"><h3>${t('task.source')}</h3>
        <div class="device-box"><span class="tl-icon">${P.icon('pulse', 'ic-16')}</span>
          <div class="item-main"><span class="item-title break">${a.title}</span>
            <span class="row-wrap small muted">${UI.sev(a.severity)}${UI.alertStatus(a.status)}<span class="break">${t('src.label', { source: UI.sourceName(a.source) })}${dev ? ' · ' + dev.host : ''}</span></span>
            <span class="small muted">${t('sync.at', { time: P.fmt.time(D.syncedAt) })}</span></div>
          ${P.can('service') ? h`<button class="btn btn-sm" type="button" data-action="open-alert" data-id="${a.id}">${t('task.openAlert')}</button>` : ''}</div>
        <p class="small muted">${t('alert.lifecycle')}</p></section>` : ''}
      <section class="sheet-section"><h3>${t('task.ticket')}</h3>
        ${tk ? h`<div class="device-box"><span class="tl-icon">${P.icon('ticket', 'ic-16')}</span>
            <div class="item-main"><span class="item-title">#${tk.id} · ${tk.title}</span><span class="small muted">${t('ticketStatus.' + tk.status)} · ${t('ticket.savedAt', { time: P.fmt.time(D.ticketsReadAt) })}</span></div>
            <button class="btn btn-sm" type="button" data-action="open-ticket" data-id="${tk.id}">${t('common.open')}</button></div>`
          : h`<p class="muted">${t('task.noTicket')}</p>${P.can('service') && open ? h`<div><button class="btn btn-sm" type="button" data-action="choose-ticket" data-id="${task.id}">${P.icon('link', 'ic-16')}${t('task.linkTicket')}</button></div>` : ''}`}
        ${P.state.ui['choose-' + task.id] ? ticketChooser(task) : ''}
      </section>
      <section class="sheet-section"><h3>${t('task.time')}</h3>
        ${entries.length ? h`<div class="rows">${entries.map(function (e) {
          return h`<div class="item"><span class="tl-icon">${P.icon(e.source === 'atera' ? 'download' : 'timer', 'ic-16')}</span>
            <div class="item-main"><span class="item-title">${P.L(e.desc)}</span><span class="small muted">${P.fmt.date(e.date)} · ${D.staff[e.staff].name}${e.source === 'atera' ? ' · ' + t('time.fromAtera') : ''}</span></div>
            <div class="item-side strong num">${P.fmt.hours(e.hours)}</div></div>`;
        })}</div>` : h`<p class="muted">${t('task.noTime')}</p>`}
        ${P.can('time.own') && open ? h`<div><button class="btn btn-sm" type="button" data-action="log-time" data-task="${task.id}">${P.icon('timer', 'ic-16')}${t('create.time')}</button></div>` : ''}
        <p class="small muted">${t('task.timeNote')}</p></section>
      <section class="sheet-section"><h3>${t('task.history')}</h3>
        <ol class="timeline">
          ${task.completedAt ? h`<li class="tl-item"><span class="tl-icon">${P.icon('circleCheck', 'ic-16')}</span><div class="tl-text"><p>${t('task.histDone')}</p><p class="muted">${P.fmt.dateTime(task.completedAt)}</p></div></li>` : ''}
          <li class="tl-item"><span class="tl-icon">${P.icon('plus', 'ic-16')}</span><div class="tl-text"><p>${t('task.histCreated', { who: D.staff[task.createdBy].name })}</p><p class="muted">${P.fmt.dateTime(task.createdAt)} · ${c.name}</p></div></li>
        </ol></section>`;
  }

  function ticketChooser(task) {
    var list = D.ticketsOf(task.customer).filter(function (x) { return x.status === 'Open' || x.status === 'Pending'; });
    return h`<fieldset class="chooser"><legend class="small strong">${t('task.chooseTicket')}</legend>
      ${list.length ? list.map(function (x) {
        return h`<label class="check"><input type="radio" name="tk-${task.id}" value="${x.id}" data-action="pick-ticket" data-id="${task.id}"><span>#${x.id} · ${x.title}<span class="small muted" style="display:block">${t('ticketStatus.' + x.status)} · ${P.fmt.ago(x.last)}</span></span></label>`;
      }) : h`<p class="muted">${t('task.noOpenTickets')}</p>`}
      <p class="small muted">${t('ticket.savedNote', { time: P.fmt.time(D.ticketsReadAt) })}</p></fieldset>`;
  }

  function openTask(id) {
    var task = D.task(id);
    startEdit(task);
    P.popover.close();
    P.drawer.open(function () {
      var open = task.status === 'Open';
      var isDirty = dirty(task);
      return P.sheet({
        eyebrow: D.customer(task.customer).name + ' · ' + t('type.' + task.type),
        title: UI.taskSubject(task),
        meta: h`<div class="row-wrap"><span class="pill ${open ? 'pill-outline' : 'pill-good'}">${P.icon(open ? 'circleDashed' : 'circleCheck', 'ic-14')}${t('taskStatus.' + task.status)}</span>
          <span class="pill ${task.priority === 'High' ? 'pill-high' : ''}">${t('priority.' + task.priority)}</span>${UI.due(task)}</div>`,
        body: taskBody(task),
        foot: h`${open ? h`<button class="btn" type="button" data-action="drawer-complete" data-id="${task.id}">${P.icon('check', 'ic-16')}${t('task.complete')}</button>`
            : h`<button class="btn" type="button" data-action="drawer-reopen" data-id="${task.id}">${P.icon('undo', 'ic-16')}${t('task.reopen')}</button>`}
          <span class="spacer"></span>
          ${open && !edit.conflict ? h`<button class="btn btn-primary" type="button" data-action="save-task" data-id="${task.id}" ${isDirty ? '' : 'disabled'} title="${isDirty ? '' : t('task.nothingChanged')}">${t('task.save')}</button>` : ''}`
      });
    }, { label: UI.taskSubject(task) });
    bindDrawerInputs(task);
  }
  P.openTask = openTask;

  function bindDrawerInputs(task) {
    var root = P.drawer.el;
    root.oninput = root.onchange = function (e) {
      var key = e.target.getAttribute('data-bind');
      if (!key || !edit) return;
      edit[key] = e.target.value;
      var btn = root.querySelector('[data-action="save-task"]');
      if (btn) { var d = dirty(task); btn.disabled = !d; btn.title = d ? '' : t('task.nothingChanged'); }
    };
  }

  P.on('open-task', function (el) { openTask(el.dataset.id); });
  P.on('drawer-complete', function (el) { P.drawer.close(); P.actions['complete-task'](el); });
  P.on('drawer-reopen', function (el) { var task = D.task(el.dataset.id); M.reopen(task); startEdit(task); P.drawer.refresh(); P.app.refresh(); });
  P.on('choose-ticket', function (el) { P.state.ui['choose-' + el.dataset.id] = true; P.drawer.refresh(); });
  P.on('pick-ticket', function (el) {
    var task = D.task(el.dataset.id);
    task.ticket = el.value;
    task.version += 1;
    P.state.ui['choose-' + task.id] = false;
    P.drawer.refresh();
    P.app.refresh();
    P.toast(t('task.ticketLinked', { id: el.value }));
  });

  P.on('save-task', function (el) {
    var task = D.task(el.dataset.id);
    /* Demo: the Nordlys task was changed by a colleague after it was opened -> 412, the draft stays */
    if (task.conflict && !edit.conflict) {
      edit.conflict = { by: 'anna', at: P.at(0, 8, 39), due: P.at(0, 14, 30) };
      task.due = P.at(0, 14, 30);
      task.version += 1;
      P.drawer.refresh();
      return;
    }
    applyEdit(task);
  });
  function applyEdit(task) {
    task.assignee = edit.assignee;
    task.priority = edit.priority;
    task.due = parseDue(edit.dueDate, edit.dueTime);
    task.version += 1;
    task.conflict = false;
    edit.conflict = null;
    P.drawer.close();
    P.app.refresh();
    P.toast(t('task.saved'));
  }
  P.on('conflict-keep', function () { applyEdit(D.task(edit.id)); });
  P.on('conflict-discard', function () {
    var task = D.task(edit.id);
    task.conflict = false;
    startEdit(task);
    P.drawer.refresh();
    P.toast(t('conflict.discarded'));
  });

  /* ---------- New task ---------- */

  var draft = null;
  P.on('new-task', function (el) {
    P.popover.close();
    var route = P.parseRoute();
    var ds = (el && el.dataset) || {};
    draft = { customer: ds.customer || (route.name === 'customer' ? route.params[0] : 'fjordlys'), type: ds.type || 'Task', subject: ds.subject || '', assignee: P.me().id, due: 'today' };
    P.drawer.open(function () {
      var dues = [['today', t('when.today') + ' 16:00'], ['tomorrow', t('when.tomorrow') + ' 12:00'], ['week', P.fmt.weekday(P.at(4)) + ' ' + P.fmt.dm(P.at(4))], ['none', t('task.noDue')]];
      return P.sheet({ title: t('create.task'), body: h`<form class="form" id="new-task-form" novalidate>
          <div class="field"><span class="label" id="nt-type">${t('task.type')}</span>
            ${UI.seg('nt-type', ['Task', 'Call', 'Meeting'].map(function (x) { return { value: x, label: t('type.' + x) }; }), draft.type, t('task.type'))}</div>
          <div class="field"><label for="nt-subject">${t('task.subject')}</label><input class="input" id="nt-subject" required autofocus data-draft="subject" value="${draft.subject}" placeholder="${t('task.subjectHint')}">
            <span class="error" id="nt-subject-err" hidden>${t('task.subjectRequired')}</span></div>
          <div class="field"><label for="nt-customer">${t('task.customer')}</label><select class="select" id="nt-customer" data-draft="customer">${D.customers.map(function (c) { return h`<option value="${c.id}" ${draft.customer === c.id ? 'selected' : ''}>${c.name}</option>`; })}</select></div>
          <div class="field"><label for="nt-who">${t('assign.assignee')}</label><select class="select" id="nt-who" data-draft="assignee">${Object.keys(D.staff).map(function (s) { return h`<option value="${s}" ${draft.assignee === s ? 'selected' : ''}>${D.staff[s].name}${s === P.me().id ? ' ' + t('assign.me') : ''}</option>`; })}</select></div>
          <div class="field"><span class="label" id="nt-due">${t('assign.due')}</span><div class="quick-picks" role="radiogroup" aria-labelledby="nt-due">${dues.map(function (d) {
            var on = draft.due === d[0];
            return h`<button class="chip" type="button" role="radio" aria-checked="${on ? 'true' : 'false'}" data-action="nt-due" data-value="${d[0]}" data-focus="nt-due-${d[0]}">${d[1]}</button>`;
          })}</div></div>
        </form>`,
        foot: h`<button class="btn" type="button" data-action="close-layer">${t('common.cancel')}</button><span class="spacer"></span>
          <button class="btn btn-primary" type="button" data-action="create-task">${t('task.create')}</button>` });
    }, { label: t('create.task') });
    P.drawer.el.oninput = P.drawer.el.onchange = function (e) { var k = e.target.getAttribute('data-draft'); if (k) draft[k] = e.target.value; };
  });
  P.on('nt-type', function (el) { draft.type = el.dataset.value; P.drawer.refresh(); });
  P.on('nt-due', function (el) { draft.due = el.dataset.value; P.drawer.refresh(); var e = document.querySelector('[data-focus="nt-due-' + el.dataset.value + '"]'); if (e) e.focus(); });
  P.on('create-task', function () {
    if (!draft.subject.trim()) {
      var err = document.getElementById('nt-subject-err');
      var input = document.getElementById('nt-subject');
      err.hidden = false; input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', 'nt-subject-err'); input.focus();
      return;
    }
    var due = { today: P.at(0, 16, 0), tomorrow: P.at(1, 12, 0), week: P.at(4, 12, 0), none: null }[draft.due];
    var task = { id: 'n' + Date.now(), customer: draft.customer, type: draft.type, subject: { nb: draft.subject, en: draft.subject, nn: draft.subject },
      assignee: draft.assignee, due: due, priority: 'Normal', createdBy: P.me().id, createdAt: new Date(P.NOW), version: 1, status: 'Open' };
    D.tasks.push(task);
    P.drawer.close();
    P.app.refresh();
    P.toast(t('task.created', { who: D.staff[task.assignee].name }), { action: { label: t('common.open'), fn: function () { openTask(task.id); } } });
  });

  /* ---------- Saved Atera ticket ---------- */

  P.on('open-ticket', function (el) {
    var tk = D.ticket(el.dataset.id);
    var tasks = D.tasks.filter(function (x) { return x.ticket === tk.id; });
    var hours = M.sumHours(D.time.filter(function (e) { return e.ticket === tk.id; }));
    var pri = { Critical: 'P1', High: 'P2', Medium: 'P3', Low: 'P4' }[tk.priority];
    P.popover.close();
    P.drawer.open(function () {
      return P.sheet({ eyebrow: D.customer(tk.customer).name + ' · ' + t('ticket.atera'), title: '#' + tk.id + ' · ' + tk.title,
        meta: h`<div class="row-wrap"><span class="pill pill-outline">${t('ticketStatus.' + tk.status)}</span><span class="pill">${pri} · ${t('ticketPriority.' + tk.priority)}</span></div>`,
        body: h`${UI.banner('info', t('ticket.mirrorTitle'), t('ticket.mirrorText', { time: P.fmt.time(D.ticketsReadAt) }), '', 'database')}
          <dl class="kv"><dt>${t('ticket.contactLabel')}</dt><dd>${tk.contact}</dd><dt>${t('ticket.tech')}</dt><dd>${D.staff[tk.tech].name}</dd>
            <dt>${t('ticket.created')}</dt><dd class="num">${P.fmt.dateTime(tk.created)}</dd><dt>${t('ticket.last')}</dt><dd class="num">${P.fmt.dateTime(tk.last)}</dd>
            <dt>${t('ticket.hours')}</dt><dd class="num">${P.fmt.hours(hours)}</dd></dl>
          <section class="sheet-section"><h3>${t('ticket.tasks')}</h3>${tasks.length ? h`<div class="rows">${tasks.map(function (x) { return R.taskRow(x, { showAssignee: true }); })}</div>` : h`<p class="muted">${t('ticket.noTasks')}</p>`}</section>`,
        foot: h`${P.can('time.own') ? h`<button class="btn btn-primary" type="button" data-action="log-time" data-ticket="${tk.id}">${P.icon('timer', 'ic-16')}${t('create.time')}</button>` : ''}
          <span class="spacer"></span><span class="small muted">${t('ticket.openInAtera')}</span>` });
    }, { label: '#' + tk.id });
  });
})();
