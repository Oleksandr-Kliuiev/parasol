/* Parasol UX demo: observation detail and "assign work".
   Assigning re-reads the observation first; if a colleague already created the task, it is shown instead of a duplicate. */
(function () {
  'use strict';

  var P = window.P;
  var h = P.html;
  var t = P.t;
  var D = P.data;
  var M = P.model;
  var UI = P.ui$;
  var R = P.rows;

  var form = { assignee: null, due: null };

  function dueChoices(o) {
    var soon = new Date(P.NOW.getTime() + 2 * 3600000);
    soon.setMinutes(0);
    var list = [
      { id: 'soon', label: t('when.today') + ' ' + P.fmt.time(soon), date: soon },
      { id: 'today', label: t('when.today') + ' 16:00', date: P.at(0, 16, 0) },
      { id: 'tomorrow', label: t('when.tomorrow') + ' 12:00', date: P.at(1, 12, 0) },
      { id: 'none', label: t('task.noDue'), date: null }
    ];
    var def = o.severity === 'CRITICAL' ? 'soon' : o.severity === 'HIGH' ? 'today' : 'tomorrow';
    return { list: list, def: def };
  }

  function resetForm(o) {
    form.assignee = P.me().id;
    form.due = dueChoices(o).def;
  }

  function assignFields(o) {
    var choices = dueChoices(o);
    var staff = Object.keys(D.staff);
    return h`<div class="field"><span class="label" id="as-who">${t('assign.assignee')}</span>
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
        <span class="hint">${t('assign.dueHint', { sev: t('sev.' + o.severity) })}</span></div>
      <p class="small muted">${t('assign.what', { priority: t('priority.' + (D.isUrgent(o) ? 'High' : 'Normal')) })}</p>`;
  }

  function existingBox(task) {
    return UI.banner('info', t('assign.existsTitle'),
      t('assign.existsText', { who: D.staff[task.createdBy].name, ago: P.fmt.ago(task.createdAt), assignee: D.staff[task.assignee].name, due: task.due ? P.fmt.when(task.due) : t('task.noDue') }),
      h`<button class="btn btn-sm" type="button" data-action="open-task" data-id="${task.id}">${t('obs.openTask')}</button>`, 'users');
  }

  function freshLine() {
    return h`<p class="row small muted">${P.icon('circleCheck', 'ic-14')}${t('assign.fresh', { time: P.fmt.time(P.NOW) })}</p>`;
  }

  /* ---------- Popover from a list row ---------- */

  var current = null;
  P.on('assign', function (el) {
    var o = D.observation(el.dataset.id);
    current = o;
    resetForm(o);
    var existing = o.race && !o.task ? D.task(o.race) : null;
    if (existing) M.reveal(o);
    P.popover.open(el, function () {
      return h`<div class="pop-body">${freshLine()}
        <p class="strong break">${o.summary}</p>
        ${existing ? existingBox(existing) : assignFields(o)}</div>`;
    }, { title: t('assign.title'), wide: true, onClose: existing ? function () { setTimeout(function () { P.app.refresh(); }, 0); } : null, foot: function () {
      return existing ? h`<button class="btn" type="button" data-action="assign-cancel">${t('common.close')}</button>`
        : h`<button class="btn btn-primary" type="button" data-action="assign-confirm" data-focus="as-ok">${t('assign.confirm', { who: D.staff[form.assignee].first })}</button>
            <button class="btn" type="button" data-action="assign-cancel">${t('common.cancel')}</button>`;
    } });
  });

  function refreshAssign() {
    if (P.popover.isOpen()) P.popover.refresh();
    if (P.drawer.isOpen()) P.drawer.refresh();
    var key = document.activeElement && document.activeElement.getAttribute('data-focus');
    if (!key) return;
    setTimeout(function () { var again = document.querySelector('[data-focus="' + key + '"]'); if (again) again.focus(); }, 0);
  }
  P.on('as-who', function (el) { form.assignee = el.dataset.value; var k = el.getAttribute('data-focus'); refreshAssign(); refocus(k); });
  P.on('as-due', function (el) { form.due = el.dataset.value; var k = el.getAttribute('data-focus'); refreshAssign(); refocus(k); });
  function refocus(k) { setTimeout(function () { var e = document.querySelector('[data-focus="' + k + '"]'); if (e) e.focus(); }, 0); }
  P.on('assign-cancel', function () { P.popover.close(true); if (P.drawer.isOpen() && !current) P.drawer.close(); });

  function confirm(o) {
    var due = dueChoices(o).list.filter(function (c) { return c.id === form.due; })[0].date;
    var task = M.assign(o, form.assignee, due);
    P.popover.close();
    P.app.refresh();
    var chip = document.querySelector('[data-focus="assign-' + o.id + '"]');
    if (chip) chip.focus();
    P.toast(t('assign.done', { who: D.staff[task.assignee].name, due: due ? P.fmt.when(due) : t('task.noDue') }), {
      action: { label: t('obs.openTask'), fn: function () { P.actions['open-task']({ dataset: { id: task.id } }); } }
    });
  }
  P.on('assign-confirm', function () { if (current) confirm(current); });

  /* ---------- Observation drawer ---------- */

  function obsBody(o) {
    var dev = R.deviceOf(o);
    var c = D.customer(o.customer);
    var src = D.sourcesFor(o.customer).filter(function (s) { return s.source === o.source && /incidents|agents/.test(s.id); })[0];
    var task = M.taskOf(o);
    var history = dev ? D.observations.filter(function (x) { return x.device === dev.id; }) : [];
    var whatText = o.detail ? P.L(o.detail) : t('obs.kindText.' + o.kind);
    return h`
      <section class="sheet-section"><h3>${t('obs.what')}</h3><p class="measure">${whatText}</p></section>
      <section class="sheet-section"><h3>${t('obs.sourceAndTime')}</h3>
        <dl class="kv">
          <dt>${t('obs.source')}</dt><dd>${UI.sourceName(o.source)} · ${t('kind.' + o.kind)}</dd>
          <dt>${t('obs.snapshot')}</dt><dd>${src ? UI.fresh(src.status, src.asOf) : UI.fresh('MISSING')}</dd>
          <dt>${t('obs.occurred')}</dt><dd class="num">${P.fmt.dateTime(o.occurredAt)}</dd>
          <dt>${t('obs.updated')}</dt><dd class="num">${P.fmt.dateTime(o.updatedAt)}</dd>
          <dt>${t('obs.route')}</dt><dd>${t('route.' + o.route)}</dd>
        </dl>
        <p class="small muted">${t('obs.timeNote')}</p></section>
      <section class="sheet-section"><h3>${t('obs.device')}</h3>
        ${dev ? h`<div class="device-box">
            <span class="tl-icon">${P.icon(dev.kind === 'server' ? 'server' : dev.kind === 'laptop' ? 'laptop' : 'monitor', 'ic-16')}</span>
            <div class="item-main"><span class="item-title break">${dev.host}</span>
              <span class="small muted">${c.name} · ${t('device.confirmed', { sources: dev.sources.map(UI.sourceName).join(', ') })}</span>
              ${dev.os ? h`<span class="small muted">${t('device.ateraSnapshot', { os: dev.os, state: dev.online ? t('device.online') : t('device.offline'), time: P.fmt.time(D.ticketsReadAt) })}</span>` : ''}</div>
            <button class="btn btn-sm" type="button" data-action="open-device" data-id="${dev.id}">${t('device.history', { n: history.length })}</button></div>`
          : h`<p class="muted">${t('deviceStatus.' + o.deviceStatus + 'Text')}</p>`}</section>
      <section class="sheet-section"><h3>${t('obs.work')}</h3>
        ${task ? h`<div class="device-box"><span class="tl-icon">${P.icon('tasks', 'ic-16')}</span>
            <div class="item-main"><span class="item-title">${UI.taskSubject(task)}</span>
              <span class="small muted">${D.staff[task.assignee].name} · ${task.due ? P.fmt.when(task.due) : t('task.noDue')} · ${t('taskStatus.' + task.status)}</span></div>
            <button class="btn btn-sm" type="button" data-action="open-task" data-id="${task.id}">${t('obs.openTask')}</button></div>`
          : D.isActive(o) && P.can('activities') ? h`${freshLine()}${o.race ? existingBox(D.task(o.race)) : assignFields(o)}`
          : h`<p class="muted">${D.isActive(o) ? t('obs.readOnlyWork') : t('obs.noWork')}</p>`}
        <p class="small muted">${t('obs.lifecycle')}</p></section>`;
  }

  P.on('open-observation', function (el) {
    var o = D.observation(el.dataset.id);
    current = null;
    resetForm(o);
    if (o.race && !o.task) M.reveal(o);
    P.popover.close();
    P.drawer.open(function () {
      var task = M.taskOf(o);
      var canAssign = !task && D.isActive(o) && P.can('activities') && !o.race;
      return P.sheet({
        eyebrow: D.customer(o.customer).name,
        title: o.summary,
        meta: h`<div class="row-wrap">${UI.sev(o.severity)}${UI.obsStatus(o.status)}${D.isUrgent(o) ? h`<span class="pill pill-outline">${P.icon('clock', 'ic-14')}${t('obs.urgent')}</span>` : ''}</div>`,
        body: obsBody(o),
        foot: h`<button class="btn" type="button" data-action="open-source" data-value="${o.source}">${P.icon('external', 'ic-16')}${t('obs.openSource', { source: UI.sourceName(o.source) })}</button>
          <a class="btn btn-quiet" href="#/customers/${o.customer}/technical">${t('obs.openCustomer')}</a><span class="spacer"></span>
          ${canAssign ? h`<button class="btn btn-primary" type="button" data-action="assign-from-drawer" data-id="${o.id}">${t('assign.confirm', { who: D.staff[form.assignee].first })}</button>` : ''}`
      });
    }, { label: o.summary });
  });

  P.on('open-source', function (el) { P.toast(t('obs.openSourceDemo', { source: UI.sourceName(el.dataset.value) }), { tone: 'warn' }); });

  P.on('assign-from-drawer', function (el) {
    var o = D.observation(el.dataset.id);
    P.drawer.close();
    confirm(o);
  });

  /* ---------- Device history (exact machine, keeps customer context) ---------- */

  P.on('open-device', function (el) {
    var dev = D.devices.filter(function (d) { return d.id === el.dataset.id; })[0];
    var c = D.customer(dev.customer);
    var list = M.sortObs(D.observations.filter(function (x) { return x.device === dev.id; }));
    var same = D.devices.filter(function (d) { return d.host === dev.host && d.id !== dev.id; });
    P.popover.close();
    P.drawer.open(function () {
      return P.sheet({
        eyebrow: c.name, title: dev.host,
        meta: h`<div class="row-wrap">${dev.sources.map(function (s) { return h`<span class="pill pill-good">${P.icon('link', 'ic-14')}${UI.sourceName(s)}</span>`; })}</div>`,
        body: h`${same.length ? UI.banner('info', t('device.sameName'), t('device.sameNameText', { n: same.length }), '', 'compare') : ''}
          <section class="sheet-section"><h3>${t('device.inventory')}</h3>
            ${dev.os ? h`<dl class="kv"><dt>${t('device.os')}</dt><dd>${dev.os}</dd><dt>${t('device.state')}</dt><dd>${dev.online ? t('device.online') : t('device.offline')}</dd>
              <dt>${t('device.saved')}</dt><dd>${P.fmt.when(D.ticketsReadAt)}</dd></dl>
              <p class="small muted">${t('device.inventoryNote')}</p>` : h`<p class="muted">${t('device.noAtera')}</p>`}</section>
          <section class="sheet-section"><h3>${t('device.observations', { n: list.length })}</h3>
            ${list.length ? h`<div class="rows">${list.map(function (x) {
              return h`<div class="item"><span class="sev-rail ${UI.SEV[x.severity].rail}"></span>
                <div class="item-main"><button class="item-title linklike" type="button" data-action="open-observation" data-id="${x.id}">${x.summary}</button>
                  <div class="item-meta">${UI.sev(x.severity)}${UI.obsStatus(x.status)}<span>${P.fmt.date(x.occurredAt)}</span></div></div><span></span></div>`;
            })}</div>` : UI.empty('shieldCheck', t('device.noObs'), '')}
            ${list.filter(function (x) { return x.kind === 'DISK_CAPACITY'; }).length >= 3 ? UI.banner('warn', t('device.recurring'), t('device.recurringText'), '', 'history') : ''}
          </section>`,
        foot: h`<a class="btn" href="#/customers/${c.id}/technical">${t('device.allDevices')}</a>`
      });
    }, { label: dev.host });
  });
})();
