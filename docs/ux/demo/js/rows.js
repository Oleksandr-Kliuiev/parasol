/* Parasoll UX demo: rows shared by My day, the alert queue, tasks and the customer card.
   A row shows what it is, whose it is and the one next step, in the same place every time. */
(function () {
  'use strict';

  var P = window.P;
  var h = P.html;
  var t = P.t;
  var D = P.data;
  var M = P.model;
  var UI = P.ui$;
  var R = (P.rows = {});

  R.deviceOf = function (a) {
    return a.device ? D.devices.filter(function (d) { return d.id === a.device; })[0] : null;
  };

  /* "Ingrid · today 12:00" chip for an alert that already has work */
  R.taskChip = function (task, focusKey) {
    var who = D.staff[task.assignee];
    var due = task.due ? (P.sameDay(task.due, P.NOW) ? t('when.today') + ' ' + P.fmt.time(task.due) : P.fmt.when(task.due)) : t('task.noDue');
    var late = task.status === 'Open' && task.due && task.due < P.NOW;
    return h`<button class="tag is-link ${late ? 'is-late' : ''}" type="button" data-action="open-task" data-id="${task.id}" title="${t('alert.openTask')}" ${focusKey ? P.raw('data-focus="' + P.escape(focusKey) + '"') : ''}>
      ${UI.avatar(task.assignee, 'is-sm')}<span>${who.first} · ${task.status === 'Done' ? t('taskStatus.Done') : due}</span></button>`;
  };

  R.workCell = function (a) {
    var task = M.taskOf(a);
    if (task) return R.taskChip(task, 'assign-' + a.id);
    if (!D.isOpen(a)) return h`<span class="muted small">${t('alert.noWork')}</span>`;
    if (!P.can('activities')) return h`<button class="btn btn-sm" type="button" data-action="open-alert" data-id="${a.id}">${t('alert.viewWork')}</button>`;
    return h`<button class="btn btn-sm" type="button" data-action="assign" data-id="${a.id}" data-focus="assign-${a.id}" aria-haspopup="dialog">${P.icon('user', 'ic-16')}${t('alert.assign')}</button>`;
  };

  R.alertRow = function (a, opts) {
    opts = opts || {};
    var dev = R.deviceOf(a);
    var c = D.customer(a.customer);
    return h`<div class="item alert-item">
      <span class="sev-rail ${UI.SEV[a.severity].rail}" aria-hidden="true"></span>
      <div class="item-main">
        <button class="item-title linklike" type="button" data-action="open-alert" data-id="${a.id}">${a.title}</button>
        <div class="item-meta">
          ${UI.sev(a.severity)}
          ${opts.hideCustomer ? '' : h`<span>${c.name}</span>`}
          <span class="break">${dev ? dev.host : t('deviceStatus.' + a.deviceStatus)}</span>
          <span>${t('src.label', { source: UI.sourceName(a.source) })} · ${P.fmt.ago(a.occurredAt)}</span>
        </div>
      </div>
      <div class="item-side">${R.workCell(a)}</div>
    </div>`;
  };

  R.taskRow = function (task, opts) {
    opts = opts || {};
    var done = task.status === 'Done';
    var c = D.customer(task.customer);
    var logged = M.taskHours(task.id);
    return h`<div class="item task-item ${done ? 'is-done' : ''}">
      <button class="done-box" type="button" role="checkbox" aria-checked="${done ? 'true' : 'false'}" data-action="${done ? 'reopen-task' : 'complete-task'}" data-id="${task.id}"
        data-focus="done-${task.id}" aria-label="${done ? t('task.reopenLabel', { title: UI.taskSubject(task) }) : t('task.completeLabel', { title: UI.taskSubject(task) })}">${P.icon('check', 'ic-14')}</button>
      <div class="item-main">
        <div class="row-wrap task-title-row">
          ${UI.due(task)}
          <button class="item-title linklike" type="button" data-action="open-task" data-id="${task.id}">${task.type !== 'Task' ? P.icon(UI.typeIcon(task.type), 'ic-16 muted') : ''}${UI.taskSubject(task)}</button>
        </div>
        ${task.source && !done ? h`<div class="task-source">${UI.taskSource(task)}</div>` : ''}
        <div class="item-meta">
          ${opts.hideCustomer ? '' : h`<span>${c.name}</span>`}
          ${task.ticket ? h`<span>${UI.ticketTag(task.ticket)}</span>` : ''}
          ${logged ? h`<span class="num">${t('task.logged', { hours: P.fmt.hours(logged) })}</span>` : ''}
          ${opts.showAssignee ? h`<span>${D.staff[task.assignee].name}</span>` : ''}
          ${done && task.completedAt ? h`<span>${t('task.doneAt', { time: P.fmt.time(task.completedAt) })}</span>` : ''}
        </div>
      </div>
      <div class="item-side">
        ${!done && P.can('time.own') ? h`<button class="icon-btn is-sm" type="button" data-action="log-time" data-task="${task.id}" aria-label="${t('task.logTimeFor', { title: UI.taskSubject(task) })}" title="${t('create.time')}">${P.icon('timer', 'ic-16')}</button>` : ''}
      </div>
    </div>`;
  };

  R.ticketRow = function (tk) {
    var open = tk.status === 'Open' || tk.status === 'Pending';
    return h`<div class="item ticket-item">
      <span class="tl-icon">${P.icon('ticket', 'ic-16')}</span>
      <div class="item-main">
        <button class="item-title linklike" type="button" data-action="open-ticket" data-id="${tk.id}"><span class="nowrap">#${tk.id}</span> ${tk.title}</button>
        <div class="item-meta"><span class="pill ${open ? (tk.status === 'Pending' ? 'pill-warn' : 'pill-outline') : 'pill-good'}">${t('ticketStatus.' + tk.status)}</span>
          <span>${D.customer(tk.customer).name}</span><span>${t('ticket.lastActivity', { when: P.fmt.ago(tk.last) })}</span></div>
      </div>
    </div>`;
  };

  R.feedRow = function (f) {
    var who = f.who === 'system' ? t('feed.system') : D.staff[f.who].name;
    var c = f.customer ? D.customer(f.customer).name : '';
    var text = t('feed.' + f.kind, { customer: c, n: f.count || 0, week: f.week || '', target: f.target ? D.staff[f.target].name : '' });
    var icon = { taskFromAlert: 'pulse', taskDone: 'circleCheck', ateraImport: 'download', assignedTo: 'user', approved: 'listChecks' }[f.kind] || 'note';
    return h`<li class="tl-item"><span class="tl-icon">${P.icon(icon, 'ic-16')}</span>
      <div class="tl-text"><p><strong>${who}</strong> · ${text}</p><p class="muted">${P.fmt.when(f.at)}</p></div></li>`;
  };
})();
