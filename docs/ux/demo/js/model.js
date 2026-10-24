/* Parasoll UX demo: derived reads and the few writes the demo simulates (assign, close, complete, log time, approve).
   Writes mirror the real rules: one task per alert, separate lifecycles for the task and the alert, no silent overwrite. */
(function () {
  'use strict';

  var P = window.P;
  var D = P.data;
  var M = (P.model = {});

  var revealed = {}; /* alerts whose fresh preview already showed a colleague's task */

  /* The task linked to an alert, as the current list read knows it */
  M.taskOf = function (a) {
    if (a.task) return D.task(a.task);
    if (a.race && (revealed[a.id] || D.task(a.race).assignee === P.me().id || P.state.role !== 'technician')) return D.task(a.race);
    return null;
  };
  M.reveal = function (a) { revealed[a.id] = true; };

  M.openAlerts = function () { return D.alerts.filter(D.isOpen); };
  M.urgent = function () { return M.openAlerts().filter(D.isUrgent); };
  M.urgentUnassigned = function () { return M.urgent().filter(function (a) { return !M.taskOf(a); }); };
  M.sortAlerts = function (list) {
    return list.slice().sort(function (a, b) {
      return D.SEV_ORDER[a.severity] - D.SEV_ORDER[b.severity] || b.occurredAt - a.occurredAt;
    });
  };

  M.myTasks = function (staff) {
    var id = staff || P.me().id;
    return D.tasks.filter(function (t) { return t.assignee === id; });
  };
  M.openTasks = function (staff) { return M.myTasks(staff).filter(function (t) { return t.status === 'Open'; }); };
  M.sortTasks = function (list) {
    return list.slice().sort(function (a, b) {
      if (!a.due && !b.due) return 0;
      if (!a.due) return 1;
      if (!b.due) return -1;
      return a.due - b.due;
    });
  };
  M.todayTasks = function (staff) {
    return M.sortTasks(M.myTasks(staff).filter(function (t) {
      if (t.status === 'Done') return t.completedAt && P.sameDay(t.completedAt, P.NOW);
      return t.due && (t.due < P.NOW || P.sameDay(t.due, P.NOW));
    }));
  };
  M.overdue = function (staff) {
    return M.openTasks(staff).filter(function (t) { return t.due && t.due < P.NOW && !P.sameDay(t.due, P.NOW); });
  };

  M.timeFor = function (staff, fromOffset, toOffset) {
    var from = P.at(fromOffset), to = P.at(toOffset + 1);
    return D.time.filter(function (e) { return e.staff === staff && e.date >= from && e.date < to; });
  };
  M.sumHours = function (list) { return list.reduce(function (s, e) { return s + e.hours; }, 0); };
  M.taskHours = function (taskId) { return M.sumHours(D.time.filter(function (e) { return e.task === taskId; })); };
  M.weekDays = function (staff, mondayOffset) {
    var out = [];
    for (var i = 0; i < 7; i++) {
      var list = M.timeFor(staff, mondayOffset + i, mondayOffset + i);
      out.push({ date: P.at(mondayOffset + i), hours: M.sumHours(list), entries: list });
    }
    return out;
  };

  M.lowBanks = function () {
    return D.customers.filter(function (c) { return c.hourBank && c.hourBank.left / c.hourBank.size < 0.2; });
  };
  M.outstanding = function () {
    var open = D.invoices.filter(function (x) { return x.outstanding > 0; });
    var overdue = open.filter(function (x) { return D.invoiceStatus(x) === 'Overdue'; });
    return { open: open, overdue: overdue, sum: open.reduce(function (s, x) { return s + x.outstanding; }, 0),
      overdueSum: overdue.reduce(function (s, x) { return s + x.outstanding; }, 0) };
  };

  M.approvalQueue = function () {
    var me = P.me().id;
    var groups = {};
    D.time.forEach(function (e) {
      if (e.status !== 'New' || e.staff === me || e.date >= P.at(0)) return;
      (groups[e.staff] = groups[e.staff] || []).push(e);
    });
    return Object.keys(groups).map(function (s) { return { staff: s, entries: groups[s], hours: M.sumHours(groups[s]) }; });
  };

  /* Allocation preview: hour bank first, then rate; non-billable stays out. Final split happens at approval. */
  M.allocate = function (customerId, hours, billable, onsite) {
    var c = D.customer(customerId);
    var h = onsite ? Math.max(1, hours) : hours;
    if (!billable || !c) return { nonBillable: h, bank: 0, rate: 0, bankAfter: c && c.hourBank ? c.hourBank.left : null };
    var bankLeft = c.hourBank ? c.hourBank.left : 0;
    var bank = Math.min(bankLeft, h);
    var rest = h - bank;
    var rate = rest > 0 ? Math.ceil(rest * 4) / 4 : 0;
    return { nonBillable: 0, bank: bank, rate: rate, bankAfter: c.hourBank ? bankLeft - bank : null, minApplied: onsite && hours < 1 };
  };

  /* ---------- Simulated writes ---------- */

  /* The subject starts as the alert title; the person may have edited it before assigning */
  var taskSeq = 100;
  M.assign = function (a, assignee, due, subject) {
    taskSeq += 1;
    var task = { id: 'n' + taskSeq, customer: a.customer, type: 'Task', subject: subject || a.title, source: a.id, ticket: null,
      assignee: assignee, due: due, priority: D.isUrgent(a) ? 'High' : 'Normal', createdBy: P.me().id, createdAt: new Date(P.NOW), version: 1, status: 'Open' };
    D.tasks.push(task);
    a.task = task.id;
    D.feed.unshift({ who: P.me().id, kind: 'taskFromAlert', customer: a.customer, at: new Date(P.NOW) });
    return task;
  };

  /* Closing an alert in the CRM leaves its task alone, and completing the task leaves the alert alone */
  M.closeAlert = function (a) { a.status = 'CLOSED'; a.closedAt = new Date(P.NOW); a.closedBy = P.me().id; a.updatedAt = new Date(P.NOW); };
  M.reopenAlert = function (a) { a.status = 'OPEN'; a.closedAt = null; a.closedBy = null; };

  M.complete = function (task) { task.status = 'Done'; task.completedAt = new Date(P.NOW); task.version += 1; };
  M.reopen = function (task) { task.status = 'Open'; task.completedAt = null; task.version += 1; };

  var entrySeq = 900;
  M.logTime = function (e) {
    entrySeq += 1;
    var entry = Object.assign({ id: 'te' + entrySeq, staff: P.me().id, status: 'New', source: 'crm' }, e);
    D.time.push(entry);
    return entry;
  };

  M.approve = function (entries) {
    entries.forEach(function (e) {
      e.status = e.billable ? 'Approved' : 'NonBillable';
      var c = D.customer(e.customer);
      if (e.billable && c && c.hourBank) c.hourBank.left = Math.max(0, c.hourBank.left - Math.min(c.hourBank.left, e.hours));
    });
  };
})();
