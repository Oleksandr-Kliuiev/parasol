/* Parasoll UX demo: command palette (Ctrl/Cmd+K). One box finds customers, devices and tasks and runs
   frequent actions. Devices always show their customer, because hostnames repeat across customers. */
(function () {
  'use strict';

  var P = window.P;
  var h = P.html;
  var t = P.t;
  var D = P.data;
  var M = P.model;
  var UI = P.ui$;

  var st = { q: '', sel: 0, items: [] };

  function norm(s) { return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

  function build() {
    var q = norm(st.q.trim());
    var groups = [];
    var actions = [
      P.can('activities') && { kind: 'action', icon: 'tasks', label: t('create.task'), hint: 'N', run: function () { P.actions['new-task'](); } },
      P.can('time.own') && { kind: 'action', icon: 'timer', label: t('create.time'), hint: 'T', run: function () { P.actions['log-time'](); } },
      P.can('service') && { kind: 'action', icon: 'pulse', label: t('palette.urgentQueue'), hint: 'G A', run: function () { P.state.ui.alertFilter = { sev: 'URGENT', work: 'none' }; P.go('/alerts'); } },
      { kind: 'action', icon: 'sun', label: t('nav.day'), hint: 'G D', run: function () { P.go('/day'); } }
    ].filter(Boolean).filter(function (a) { return !q || norm(a.label).indexOf(q) !== -1; });
    if (actions.length) groups.push({ label: t('palette.actions'), items: actions });

    if (q.length >= 2) {
      var customers = D.customers.filter(function (c) { return norm(c.name).indexOf(q) !== -1 || c.orgnr.replace(/\s/g, '').indexOf(q.replace(/\s/g, '')) !== -1; })
        .slice(0, 5).map(function (c) {
          return { kind: 'customer', icon: 'building', label: c.name, sub: t('customer.orgnr') + ' ' + c.orgnr + ' · ' + c.city, run: function () { P.go('/customers/' + c.id); } };
        });
      if (customers.length) groups.push({ label: t('nav.customers'), items: customers });

      if (P.can('service')) {
        var devices = D.devices.filter(function (d) { return norm(d.host).indexOf(q) !== -1; }).slice(0, 6).map(function (d) {
          var c = D.customer(d.customer);
          return { kind: 'device', icon: d.kind === 'server' ? 'server' : d.kind === 'laptop' ? 'laptop' : 'monitor', label: d.host, sub: c.name,
            run: function () { P.go('/customers/' + c.id + '/operations'); setTimeout(function () { P.actions['open-device']({ dataset: { id: d.id } }); }, 0); } };
        });
        if (devices.length) groups.push({ label: t('palette.devices'), items: devices });
      }

      var tasks = M.openTasks().concat(D.tasks.filter(function (x) { return x.assignee !== P.me().id && x.status === 'Open'; }))
        .filter(function (x) { return norm(UI.taskSubject(x)).indexOf(q) !== -1 || norm(D.customer(x.customer).name).indexOf(q) !== -1; })
        .slice(0, 5).map(function (x) {
          return { kind: 'task', icon: UI.typeIcon(x.type), label: UI.taskSubject(x), sub: D.customer(x.customer).name + ' · ' + D.staff[x.assignee].name,
            run: function () { P.go('/tasks'); setTimeout(function () { P.actions['open-task']({ dataset: { id: x.id } }); }, 0); } };
        });
      if (tasks.length) groups.push({ label: t('nav.tasks'), items: tasks });
    }
    st.items = [].concat.apply([], groups.map(function (g) { return g.items; }));
    if (st.sel >= st.items.length) st.sel = Math.max(0, st.items.length - 1);
    return groups;
  }

  function list() {
    var groups = build();
    var i = -1;
    if (!groups.length) return UI.empty('search', t('palette.nothing', { q: st.q }), t('palette.nothingHint'));
    return groups.map(function (g) {
      return h`<p class="palette-group eyebrow">${g.label}</p>${g.items.map(function (it) {
        i += 1;
        return h`<button class="palette-item" type="button" role="option" id="pal-${i}" aria-selected="${i === st.sel ? 'true' : 'false'}" data-action="palette-run" data-index="${i}">
          <span class="tl-icon">${P.icon(it.icon, 'ic-16')}</span>
          <span class="item-main"><span class="item-title truncate">${it.label}</span>${it.sub ? h`<span class="small muted truncate">${it.sub}</span>` : ''}</span>
          ${it.hint ? h`<span class="kbd">${it.hint}</span>` : h`<span></span>`}</button>`;
      })}`;
    });
  }

  function render() {
    return h`<div class="sheet">
      <div class="palette-input">${P.icon('search')}
        <input id="palette-q" type="search" autocomplete="off" spellcheck="false" autofocus value="${st.q}"
          placeholder="${t('palette.placeholder')}" aria-label="${t('palette.placeholder')}" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant="pal-${st.sel}">
        <button class="icon-btn is-quiet is-sm" type="button" data-action="close-layer" aria-label="${t('common.close')}">${P.icon('x', 'ic-16')}</button>
      </div>
      <div class="palette-list" id="palette-list" role="listbox" aria-label="${t('palette.results')}">${list()}</div>
      <div class="palette-foot"><span><span class="kbd">↑</span><span class="kbd">↓</span>${t('palette.move')}</span><span><span class="kbd">Enter</span>${t('palette.open')}</span><span><span class="kbd">Esc</span>${t('palette.close')}</span></div>
    </div>`;
  }

  function redrawList() {
    var box = document.getElementById('palette-list');
    if (!box) return;
    box.innerHTML = P.toHtml(list());
    var input = document.getElementById('palette-q');
    if (input) input.setAttribute('aria-activedescendant', 'pal-' + st.sel);
    var cur = document.getElementById('pal-' + st.sel);
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  P.on('open-palette', function () {
    P.popover.close();
    st.q = ''; st.sel = 0;
    P.modal.open(render, { label: t('palette.title') });
    var input = document.getElementById('palette-q');
    input.addEventListener('input', function () { st.q = input.value; st.sel = 0; redrawList(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); st.sel = Math.min(st.items.length - 1, st.sel + 1); redrawList(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); st.sel = Math.max(0, st.sel - 1); redrawList(); }
      if (e.key === 'Enter') { e.preventDefault(); run(st.sel); }
    });
  });

  function run(i) {
    var it = st.items[i];
    if (!it) return;
    P.modal.close();
    it.run();
  }
  P.on('palette-run', function (el) { run(Number(el.dataset.index)); });
})();
