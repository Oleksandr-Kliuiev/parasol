/* Parasoll UX demo: alert detail, "assign work" and closing an alert in the CRM.
   Assigning re-reads the alert first; if a colleague already created the task, it is shown instead of a duplicate.
   The task subject starts as the alert title and can be edited before the task is created. */
(function () {
  'use strict';

  var P = window.P;
  var h = P.html;
  var t = P.t;
  var D = P.data;
  var M = P.model;
  var UI = P.ui$;
  var R = P.rows;

  var form = { alert: null, assignee: null, due: null, subject: '', error: false };

  function dueChoices(a) {
    var soon = new Date(P.NOW.getTime() + 2 * 3600000);
    soon.setMinutes(0);
    var list = [
      { id: 'soon', label: t('when.today') + ' ' + P.fmt.time(soon), date: soon },
      { id: 'today', label: t('when.today') + ' 16:00', date: P.at(0, 16, 0) },
      { id: 'tomorrow', label: t('when.tomorrow') + ' 12:00', date: P.at(1, 12, 0) },
      { id: 'none', label: t('task.noDue'), date: null }
    ];
    var def = a.severity === 'CRITICAL' ? 'soon' : a.severity === 'HIGH' ? 'today' : 'tomorrow';
    return { list: list, def: def };
  }

  function resetForm(a) {
    form.alert = a;
    form.assignee = P.me().id;
    form.due = dueChoices(a).def;
    form.subject = a.title;
    form.error = false;
  }

  function assignFields(a) {
    var choices = dueChoices(a);
    var staff = Object.keys(D.staff);
    var describedBy = 'as-subject-hint' + (form.error ? ' as-subject-err' : '');
    return h`<div class="field"><label for="as-subject">${t('task.subject')}</label>
        <input class="input" id="as-subject" data-assign="subject" data-focus="as-subject" value="${form.subject}" autocomplete="off"
          aria-describedby="${describedBy}" ${form.error ? P.raw('aria-invalid="true"') : ''}>
        <span class="hint" id="as-subject-hint">${t('assign.subjectHint')}</span>
        ${form.error ? h`<span class="error" id="as-subject-err">${t('task.subjectRequired')}</span>` : ''}</div>
      <div class="field"><span class="label" id="as-who">${t('assign.assignee')}</span>
        <div class="quick-picks" role="radiogroup" aria-labelledby="as-who">${staff.map(function (s) {
          var on = form.assignee === s;
          return h`<button class="chip" type="button" role="radio" aria-checked="${on ? 'true' : 'false'}" data-action="as-who" data-value="${s}" data-focus="as-who-${s}">
            ${UI.avatar(s, 'is-sm')}${D.staff[s].first}${s === P.me().id ? ' ' + t('assign.me') : ''}</button>`;
        })}</div></div>
      <div class="field"><span class="label" id="as-due">${t('assign.due')}</span>
        <div class="quick-picks" role="radiogroup" aria-labelledby="as-due">${choices.list.map(function (c) {
          var on = form.due === c.id;
          return h`<button class="chip" type="button" role="radio" aria-checked="${on ? 'true' : 'false'}" data-action="as-due" data-value="${c.id}" data-focus="as-due-${c.id}">${c.label}</button>`;
        })}</div>
        <span class="hint">${t('assign.dueHint', { sev: t('sev.' + a.severity) })}</span></div>
      <p class="small muted">${t('assign.what', { priority: t('priority.' + (D.isUrgent(a) ? 'High' : 'Normal')) })}</p>`;
  }

  function existingBox(task) {
    return UI.banner('info', t('assign.existsTitle'),
      t('assign.existsText', { who: D.staff[task.createdBy].name, ago: P.fmt.ago(task.createdAt), assignee: D.staff[task.assignee].name, due: task.due ? P.fmt.when(task.due) : t('task.noDue') }),
      h`<button class="btn btn-sm" type="button" data-action="open-task" data-id="${task.id}">${t('alert.openTask')}</button>`, 'users');
  }

  function freshLine() {
    return h`<p class="row small muted">${P.icon('circleCheck', 'ic-14')}${t('assign.fresh', { time: P.fmt.time(P.NOW) })}</p>`;
  }

  /* Customer and device under the title, so the person sees which of two same-named devices this is */
  function whereLine(a) {
    var dev = R.deviceOf(a);
    return h`<p class="small muted break">${D.customer(a.customer).name} · ${dev ? dev.host : t('deviceStatus.' + a.deviceStatus)}</p>`;
  }

  /* ---------- Popover from a list row ---------- */

  var current = null;
  P.on('assign', function (el) {
    var a = D.alert(el.dataset.id);
    current = a;
    resetForm(a);
    var existing = a.race && !a.task ? D.task(a.race) : null;
    if (existing) M.reveal(a);
    P.popover.open(el, function () {
      return h`<div class="pop-body">${freshLine()}
        <div><p class="strong break">${a.title}</p>${whereLine(a)}</div>
        ${existing ? existingBox(existing) : assignFields(a)}</div>`;
    }, { title: t('assign.title'), wide: true, onClose: existing ? function () { setTimeout(function () { P.app.refresh(); }, 0); } : null, foot: function () {
      return existing ? h`<button class="btn" type="button" data-action="assign-cancel">${t('common.close')}</button>`
        : h`<button class="btn btn-primary" type="button" data-action="assign-confirm" data-focus="as-ok">${t('assign.confirm', { who: D.staff[form.assignee].first })}</button>
            <button class="btn" type="button" data-action="assign-cancel">${t('common.cancel')}</button>`;
    } });
  });

  function refreshAssign() {
    if (P.popover.isOpen()) P.popover.refresh();
    if (P.drawer.isOpen()) P.drawer.refresh();
  }
  function refocus(k) { setTimeout(function () { var e = document.querySelector('[data-focus="' + k + '"]'); if (e) e.focus(); }, 0); }
  P.on('as-who', function (el) { form.assignee = el.dataset.value; var k = el.getAttribute('data-focus'); refreshAssign(); refocus(k); });
  P.on('as-due', function (el) { form.due = el.dataset.value; var k = el.getAttribute('data-focus'); refreshAssign(); refocus(k); });
  /* On phones the popover is a bottom sheet, so Cancel closes whichever of the two is showing the form */
  P.on('assign-cancel', function () {
    if (P.popover.isOpen()) P.popover.close(true);
    else if (P.drawer.isOpen()) P.drawer.close();
  });

  /* The subject lives in the form state, so choosing a person or a due date never wipes what was typed */
  document.addEventListener('input', function (e) {
    if (!e.target.matches || !e.target.matches('[data-assign="subject"]')) return;
    form.subject = e.target.value;
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || !e.target.matches || !e.target.matches('[data-assign="subject"]') || !form.alert) return;
    e.preventDefault();
    if (P.popover.isOpen()) P.actions['assign-confirm']();
    else P.actions['assign-from-drawer']({ dataset: { id: form.alert.id } });
  });

  /* An empty subject is refused inline; the task needs a subject people can find it by */
  function subjectReady() {
    if (form.subject.trim()) return true;
    form.error = true;
    refreshAssign();
    refocus('as-subject');
    return false;
  }

  /* A closing drawer hands focus back to its opener; the new task chip takes it after that */
  function afterDrawerClose(fn) {
    P.drawer.el.addEventListener('close', function after() { P.drawer.el.removeEventListener('close', after); fn(); });
  }

  function confirm(a) {
    var due = dueChoices(a).list.filter(function (c) { return c.id === form.due; })[0].date;
    var task = M.assign(a, form.assignee, due, form.subject.trim());
    var focusChip = function () { P.focusKey('assign-' + a.id); };
    if (P.popover.isOpen()) P.popover.close();
    else if (P.drawer.isOpen()) { afterDrawerClose(focusChip); P.drawer.close(); }
    P.app.refresh();
    focusChip();
    P.toast(t('assign.done', { who: D.staff[task.assignee].name, due: due ? P.fmt.when(due) : t('task.noDue') }), {
      action: { label: t('alert.openTask'), fn: function () { P.actions['open-task']({ dataset: { id: task.id } }); } }
    });
  }
  P.on('assign-confirm', function () { if (current && subjectReady()) confirm(current); });

  /* ---------- Alert drawer ---------- */

  function statusText(a) {
    var who = a.closedBy ? D.staff[a.closedBy].name : '';
    var when = a.closedAt ? P.fmt.when(a.closedAt) : '';
    if (a.status === 'CLOSED') return t('alert.closedText', { who: who, when: when });
    if (a.status === 'CLOSED_AT_SOURCE') return t('alert.closedAtSourceText', { source: UI.sourceName(a.source), when: when });
    if (a.status === 'HIDDEN') return t('alert.hiddenText', { who: who, when: when, reason: P.L(a.reason) });
    return t('alert.openText');
  }

  function alertBody(a) {
    var dev = R.deviceOf(a);
    var c = D.customer(a.customer);
    var src = D.sourcesFor(a.customer).filter(function (s) { return s.source === a.source && /alerts|incidents/.test(s.id); })[0];
    var task = M.taskOf(a);
    var history = dev ? D.alerts.filter(function (x) { return x.device === dev.id; }) : [];
    var whatText = a.detail ? P.L(a.detail) : t('alert.kindText.' + a.kind);
    return h`
      <section class="sheet-section"><h3>${t('alert.what')}</h3><p class="measure">${whatText}</p></section>
      <section class="sheet-section"><h3>${t('alert.sourceAndTime')}</h3>
        <dl class="kv">
          <dt>${t('alert.source')}</dt><dd>${UI.sourceName(a.source)} · ${t('kind.' + a.kind)}</dd>
          <dt>${t('alert.synced')}</dt><dd>${src ? UI.fresh(src.status, src.asOf) : UI.fresh('MISSING')}</dd>
          <dt>${t('alert.occurred')}</dt><dd class="num">${P.fmt.dateTime(a.occurredAt)}</dd>
          <dt>${t('alert.updated')}</dt><dd class="num">${P.fmt.dateTime(a.updatedAt)}</dd>
        </dl>
        <p class="small muted">${t('alert.timeNote')}</p></section>
      <section class="sheet-section"><h3>${t('alert.device')}</h3>
        ${dev ? h`<div class="device-box">
            <span class="tl-icon">${P.icon(dev.kind === 'server' ? 'server' : dev.kind === 'laptop' ? 'laptop' : 'monitor', 'ic-16')}</span>
            <div class="item-main"><span class="item-title break">${dev.host}</span>
              <span class="small muted">${c.name} · ${t('device.confirmed', { sources: dev.sources.map(UI.sourceName).join(', ') })}</span>
              ${dev.os ? h`<span class="small muted">${t('device.ateraSnapshot', { os: dev.os, state: dev.online ? t('device.online') : t('device.offline'), time: P.fmt.time(D.syncedAt) })}</span>` : ''}</div>
            <button class="btn btn-sm" type="button" data-action="open-device" data-id="${dev.id}">${t('device.history', { n: history.length })}</button></div>`
          : h`<p class="muted">${t('deviceStatus.' + a.deviceStatus + 'Text')}</p>`}</section>
      <section class="sheet-section"><h3>${t('alert.work')}</h3>
        ${task ? h`<div class="device-box"><span class="tl-icon">${P.icon('tasks', 'ic-16')}</span>
            <div class="item-main"><span class="item-title">${UI.taskSubject(task)}</span>
              <span class="small muted">${D.staff[task.assignee].name} · ${task.due ? P.fmt.when(task.due) : t('task.noDue')} · ${t('taskStatus.' + task.status)}</span></div>
            <button class="btn btn-sm" type="button" data-action="open-task" data-id="${task.id}">${t('alert.openTask')}</button></div>`
          : D.isOpen(a) && P.can('activities') ? h`${freshLine()}${a.race ? existingBox(D.task(a.race)) : assignFields(a)}`
          : h`<p class="muted">${D.isOpen(a) ? t('alert.readOnlyWork') : t('alert.noWork')}</p>`}</section>
      <section class="sheet-section"><h3 id="alert-status" tabindex="-1">${t('alert.status')}</h3>
        <p>${statusText(a)}</p>
        ${D.isOpen(a) && P.can('service') ? h`<div><button class="btn btn-sm" type="button" data-action="close-alert" data-id="${a.id}">${P.icon('circleCheck', 'ic-16')}${t('alert.close')}</button></div>` : ''}
        <p class="small muted">${t('alert.lifecycle')}</p></section>`;
  }

  P.on('open-alert', function (el) {
    var a = D.alert(el.dataset.id);
    current = null;
    resetForm(a);
    if (a.race && !a.task) M.reveal(a);
    P.popover.close();
    P.drawer.open(function () {
      var task = M.taskOf(a);
      var canAssign = !task && D.isOpen(a) && P.can('activities') && !a.race;
      return P.sheet({
        eyebrow: D.customer(a.customer).name,
        title: a.title,
        meta: h`<div class="row-wrap">${UI.sev(a.severity)}${UI.alertStatus(a.status)}${D.isUrgent(a) && D.isOpen(a) ? h`<span class="pill pill-outline">${P.icon('clock', 'ic-14')}${t('alert.urgent')}</span>` : ''}</div>`,
        body: alertBody(a),
        foot: h`<button class="btn" type="button" data-action="open-source" data-value="${a.source}">${P.icon('external', 'ic-16')}${t('alert.openSource', { source: UI.sourceName(a.source) })}</button>
          <a class="btn btn-quiet" href="#/customers/${a.customer}/operations">${t('alert.openCustomer')}</a><span class="spacer"></span>
          ${canAssign ? h`<button class="btn btn-primary" type="button" data-action="assign-from-drawer" data-id="${a.id}">${t('assign.confirm', { who: D.staff[form.assignee].first })}</button>` : ''}`
      });
    }, { label: a.title });
  });

  P.on('open-source', function (el) { P.toast(t('alert.openSourceDemo', { source: UI.sourceName(el.dataset.value) }), { tone: 'warn' }); });

  P.on('assign-from-drawer', function (el) {
    if (subjectReady()) confirm(D.alert(el.dataset.id));
  });

  /* Closing the alert in the CRM; its task, if any, stays as it is */
  P.on('close-alert', function (el) {
    var a = D.alert(el.dataset.id);
    var task = M.taskOf(a);
    M.closeAlert(a);
    P.app.refresh();
    var head = document.getElementById('alert-status');
    if (head) head.focus();
    P.toast(task && task.status === 'Open' ? t('alert.closedTaskOpen') : t('alert.closedToast'), {
      action: { label: t('task.undo'), fn: function () { M.reopenAlert(a); P.app.refresh(); } }
    });
  });

  /* ---------- Device history (exact device, keeps customer context) ---------- */

  P.on('open-device', function (el) {
    var dev = D.devices.filter(function (d) { return d.id === el.dataset.id; })[0];
    var c = D.customer(dev.customer);
    var list = M.sortAlerts(D.alerts.filter(function (x) { return x.device === dev.id; }));
    var same = D.devices.filter(function (d) { return d.host === dev.host && d.id !== dev.id; });
    P.popover.close();
    P.drawer.open(function () {
      return P.sheet({
        eyebrow: c.name, title: dev.host,
        meta: h`<div class="row-wrap">${dev.sources.map(function (s) { return h`<span class="pill pill-good">${P.icon('link', 'ic-14')}${UI.sourceName(s)}</span>`; })}</div>`,
        body: h`${same.length ? UI.banner('info', t('device.sameName'), t('device.sameNameText', { n: same.length }), '', 'compare') : ''}
          <section class="sheet-section"><h3>${t('device.inventory')}</h3>
            ${dev.os ? h`<dl class="kv"><dt>${t('device.os')}</dt><dd>${dev.os}</dd><dt>${t('device.state')}</dt><dd>${dev.online ? t('device.online') : t('device.offline')}</dd>
              <dt>${t('device.saved')}</dt><dd>${P.fmt.when(D.syncedAt)}</dd></dl>
              <p class="small muted">${t('device.inventoryNote')}</p>` : h`<p class="muted">${t('device.noAtera')}</p>`}</section>
          <section class="sheet-section"><h3>${t('device.alerts', { n: list.length })}</h3>
            ${list.length ? h`<div class="rows">${list.map(function (x) {
              return h`<div class="item"><span class="sev-rail ${UI.SEV[x.severity].rail}"></span>
                <div class="item-main"><button class="item-title linklike" type="button" data-action="open-alert" data-id="${x.id}">${x.title}</button>
                  <div class="item-meta">${UI.sev(x.severity)}${UI.alertStatus(x.status)}<span>${P.fmt.date(x.occurredAt)}</span></div></div><span></span></div>`;
            })}</div>` : UI.empty('shieldCheck', t('device.noAlerts'), '')}
            ${list.filter(function (x) { return x.kind === 'DISK_CAPACITY'; }).length >= 3 ? UI.banner('warn', t('device.recurring'), t('device.recurringText'), '', 'history') : ''}
          </section>`,
        foot: h`<a class="btn" href="#/customers/${c.id}/operations">${t('device.allDevices')}</a>`
      });
    }, { label: dev.host });
  });
})();
