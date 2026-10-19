/* Parasol UX demo: tasks grouped by when they are due. "Mine" for everyone, "Team" for people who plan work. */
(function () {
  'use strict';

  var P = window.P;
  var h = P.html;
  var t = P.t;
  var D = P.data;
  var M = P.model;
  var UI = P.ui$;
  var R = P.rows;

  function state() {
    return P.state.ui.tasks = Object.assign({ scope: 'mine', kind: 'all' }, P.state.ui.tasks || {});
  }

  function groups(list) {
    var g = { late: [], today: [], tomorrow: [], week: [], later: [], none: [], done: [] };
    list.forEach(function (x) {
      if (x.status === 'Done') { g.done.push(x); return; }
      if (!x.due) { g.none.push(x); return; }
      var d = P.dayDiff(x.due, P.NOW);
      if (x.due < P.NOW && d < 0) g.late.push(x);
      else if (d <= 0) g.today.push(x);
      else if (d === 1) g.tomorrow.push(x);
      else if (d < 7) g.week.push(x);
      else g.later.push(x);
    });
    return g;
  }

  P.views.tasks = {
    perm: 'activities',
    render: function () {
      var s = state();
      var team = P.can('time.manage');
      var base = s.scope === 'team' && team ? D.tasks.slice() : M.myTasks();
      var all = base.filter(function (x) {
        if (s.kind === 'obs') return !!x.source;
        if (s.kind === 'ticket') return !!x.ticket;
        if (s.kind === 'nodue') return !x.due && x.status === 'Open';
        return true;
      });
      var g = groups(M.sortTasks(all));
      var open = all.filter(function (x) { return x.status === 'Open'; });
      var order = ['late', 'today', 'tomorrow', 'week', 'later', 'none'];
      var icons = { late: 'alert', today: 'calendar', tomorrow: 'calendar', week: 'calendar', later: 'calendar', none: 'circleDashed' };
      var count = function (k) {
        return base.filter(function (x) {
          if (k === 'obs') return !!x.source && x.status === 'Open';
          if (k === 'ticket') return !!x.ticket && x.status === 'Open';
          if (k === 'nodue') return !x.due && x.status === 'Open';
          return x.status === 'Open';
        }).length;
      };
      var body = h`${UI.pageHead({ title: t('nav.tasks'), sub: t('tasks.sub', { n: open.length, late: g.late.length }),
          actions: h`<button class="btn btn-primary" type="button" data-action="new-task">${P.icon('plus', 'ic-16')}${t('create.task')}</button>` })}
        <div class="toolbar">
          ${team ? UI.seg('tasks-scope', [{ value: 'mine', label: t('tasks.mine') }, { value: 'team', label: t('tasks.team') }], s.scope, t('tasks.scope')) : ''}
          <div class="chips" role="group" aria-label="${t('tasks.filter')}">${['all', 'obs', 'ticket', 'nodue'].map(function (k) {
            return UI.chip('tasks-kind', k, t('tasks.kind.' + k), count(k), s.kind === k);
          })}</div>
        </div>
        ${UI.card({ body: h`${order.map(function (k) {
          if (!g[k].length) return '';
          return h`<p class="group-label small strong">${P.icon(icons[k], 'ic-14')}${t('task.group.' + k)}<span class="count">${g[k].length}</span></p>
            <div class="rows">${g[k].map(function (x) { return R.taskRow(x, { showAssignee: s.scope === 'team' }); })}</div>`;
        })}
        ${!open.length ? UI.empty('tasks', t('tasks.empty'), t('tasks.emptyText')) : ''}
        ${g.done.length ? h`<details class="done-group"><summary class="small strong">${t('work.done', { n: g.done.length })}</summary>
          <div class="rows">${g.done.map(function (x) { return R.taskRow(x, { showAssignee: s.scope === 'team' }); })}</div></details>` : ''}`,
          foot: h`<span>${t('tasks.foot')}</span>` })}`;
      return { title: t('nav.tasks'), crumbs: [{ label: 'Parasol', href: '#/day' }, { label: t('nav.tasks') }], body: body };
    }
  };

  P.on('tasks-scope', function (el) { state().scope = el.dataset.value; P.app.refresh(); });
  P.on('tasks-kind', function (el) { state().kind = el.dataset.value; P.app.refresh(); });
})();
