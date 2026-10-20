/* Parasoll UX demo: synthetic tasks, saved Atera tickets, time, contracts, PowerOffice finance,
   billing runs, reminders, notifications and connection readiness. */
(function () {
  'use strict';

  var P = window.P;
  var D = P.data;
  var at = P.at;
  var rnd = D.rnd;
  var S = function (nb, en, nn) { return { nb: nb, en: en, nn: nn }; };

  /* ---------- Tasks (CRM activities). A task made from an observation keeps the generic subject;
     the observation summary is never copied into it (privacy rule from M12). ---------- */

  var GENERIC = 'generic';
  D.tasks = [
    { id: 't1', customer: 'kvamme', type: 'Task', subject: GENERIC, source: 'o5', ticket: '910219', assignee: 'ingrid', due: at(-3, 15, 0), priority: 'High', createdBy: 'jonas', createdAt: at(-4, 10, 30), version: 3 },
    { id: 't2', customer: 'fjordlys', type: 'Task', subject: GENERIC, source: 'o2', ticket: '910231', assignee: 'ingrid', due: at(0, 12, 0), priority: 'High', createdBy: 'ingrid', createdAt: at(0, 7, 40), version: 2 },
    { id: 't3', customer: 'nordlys', type: 'Task', subject: GENERIC, source: 'o4', ticket: null, assignee: 'ingrid', due: at(0, 14, 0), priority: 'High', createdBy: 'anna', createdAt: at(-1, 9, 10), version: 1, conflict: true },
    { id: 't4', customer: 'bergvik', type: 'Task', subject: S('Ny ansatt: klargjør PC og Microsoft 365-konto', 'New employee: prepare PC and Microsoft 365 account', 'Ny tilsett: gjer klar PC og Microsoft 365-konto'), ticket: '910225', assignee: 'ingrid', due: at(0, 15, 30), priority: 'Normal', createdBy: 'anna', createdAt: at(-4, 13, 0), version: 1 },
    { id: 't5', customer: 'eikeli', type: 'Meeting', subject: S('Planlagt besøk: gjennomgang av sikkerhetskopi', 'Scheduled visit: backup review', 'Planlagt besøk: gjennomgang av tryggingskopi'), assignee: 'ingrid', due: at(1, 9, 0), priority: 'Normal', createdBy: 'ingrid', createdAt: at(-7, 11, 0), version: 1, onsite: true },
    { id: 't6', customer: 'skarvoy', type: 'Call', subject: S('Ring: VPN faller ut hjemmefra', 'Call: VPN drops when working from home', 'Ring: VPN fell ut heimanfrå'), ticket: '910228', assignee: 'ingrid', due: at(2, 10, 0), priority: 'Normal', createdBy: 'ingrid', createdAt: at(-5, 9, 0), version: 1 },
    { id: 't7', customer: 'aerlige', type: 'Task', subject: S('Bytt UPS-batteri i serverrommet', 'Replace the UPS battery in the server room', 'Byt UPS-batteri i serverrommet'), assignee: 'ingrid', due: null, priority: 'Low', createdBy: 'jonas', createdAt: at(-9, 14, 0), version: 1 },
    { id: 't0', customer: 'fjordlys', type: 'Task', subject: S('Tilbakestill MFA for brukerens nye telefon', "Reset MFA for a user's new phone", 'Tilbakestill MFA for den nye telefonen til brukaren'), assignee: 'ingrid', due: at(0, 9, 0), priority: 'Normal', createdBy: 'ingrid', createdAt: at(-1, 16, 0), version: 2, status: 'Done', completedAt: at(0, 8, 15) },
    { id: 'j1', customer: 'havbris', type: 'Task', subject: GENERIC, source: 'o7', assignee: 'jonas', due: at(1, 12, 0), priority: 'High', createdBy: 'jonas', createdAt: at(-1, 15, 0), version: 1 },
    { id: 'j2', customer: 'granlund', type: 'Task', subject: S('Oppdater fastvaren på brannmuren', 'Update the firewall firmware', 'Oppdater fastvara på brannmuren'), assignee: 'jonas', due: at(0, 16, 0), priority: 'Normal', createdBy: 'jonas', createdAt: at(-3, 9, 0), version: 1 },
    { id: 'j3', customer: 'vestbris', type: 'Task', subject: S('Skriveren på lageret skriver ikke ut', 'Warehouse printer does not print', 'Skrivaren på lageret skriv ikkje ut'), ticket: '910233', assignee: 'jonas', due: at(0, 11, 0), priority: 'Normal', createdBy: 'jonas', createdAt: at(-2, 13, 0), version: 1 },
    { id: 'j4', customer: 'lindas', type: 'Call', subject: S('Diskuter overgang til Microsoft 365 Business Premium', 'Discuss moving to Microsoft 365 Business Premium', 'Diskuter overgang til Microsoft 365 Business Premium'), assignee: 'jonas', due: at(4, 13, 0), priority: 'Normal', createdBy: 'anna', createdAt: at(-6, 10, 0), version: 1 },
    { id: 'j5', customer: 'eikeli', type: 'Task', subject: GENERIC, source: 'o6', assignee: 'jonas', due: at(0, 13, 0), priority: 'High', createdBy: 'jonas', createdAt: at(0, 8, 38), version: 1 },
    { id: 'a1', customer: 'fjordlys', type: 'Task', subject: S('Fornyelse av avtale K-2026-0001: lag tilbud', 'Contract K-2026-0001 renewal: prepare a quote', 'Fornying av avtale K-2026-0001: lag tilbod'), assignee: 'anna', due: at(4, 12, 0), priority: 'Normal', createdBy: 'anna', createdAt: at(-2, 9, 0), version: 1 },
    { id: 'a2', customer: 'fjordlys', type: 'Call', subject: S('Påminn kunden om faktura 10118', 'Remind the customer about invoice 10118', 'Påminn kunden om faktura 10118'), assignee: 'anna', due: at(0, 10, 0), priority: 'High', createdBy: 'anna', createdAt: at(0, 8, 0), version: 1 },
    { id: 'a3', customer: 'c17', type: 'Task', subject: S('Signer avstemmingen av pilotfaktureringen for september', 'Sign the September pilot billing reconciliation', 'Signer avstemminga av pilotfaktureringa for september'), assignee: 'anna', due: at(1, 15, 0), priority: 'Normal', createdBy: 'anna', createdAt: at(-5, 9, 0), version: 1 }
  ];
  D.tasks.forEach(function (t) { t.status = t.status || 'Open'; });
  D.task = function (id) { return D.tasks.filter(function (t) { return t.id === id; })[0]; };
  D.observation = function (id) { return D.observations.filter(function (o) { return o.id === id; })[0]; };

  /* ---------- Saved Atera tickets (a mirror: the status is the saved value, not live) ---------- */

  D.ticketsReadAt = at(0, 8, 30);
  D.tickets = [
    { id: '910231', customer: 'fjordlys', title: 'Disk capacity follow-up on FJL-SRV-01', status: 'Open', priority: 'High', contact: 'Lars Fjeld', tech: 'ingrid', created: at(0, 7, 41), last: at(0, 8, 12) },
    { id: '910219', customer: 'kvamme', title: 'Disk nesten full på KVS-LT-04', status: 'Open', priority: 'High', contact: 'Marte Kvamme', tech: 'ingrid', created: at(-4, 10, 20), last: at(-3, 14, 5) },
    { id: '910225', customer: 'bergvik', title: 'Ny ansatt – PC og e-post', status: 'Pending', priority: 'Medium', contact: 'Hanne Berg', tech: 'ingrid', created: at(-4, 12, 50), last: at(-3, 9, 30) },
    { id: '910228', customer: 'skarvoy', title: 'VPN faller ut hjemmefra', status: 'Open', priority: 'Medium', contact: 'Ola Skarvøy', tech: 'ingrid', created: at(-5, 8, 55), last: at(-4, 16, 10) },
    { id: '910233', customer: 'vestbris', title: 'Skriveren på lageret skriver ikke ut', status: 'Open', priority: 'Low', contact: 'Per Vestby', tech: 'jonas', created: at(-2, 12, 40), last: at(-2, 12, 40) },
    { id: '910201', customer: 'fjordlys', title: 'Oppsett av ny skriver', status: 'Resolved', priority: 'Low', contact: 'Lars Fjeld', tech: 'ingrid', created: at(-8, 9, 0), last: at(-7, 11, 30) },
    { id: '910198', customer: 'nordlys', title: 'Backup-feil på NLD-SRV-01', status: 'Resolved', priority: 'High', contact: 'Siri Nordli', tech: 'ingrid', created: at(-9, 7, 30), last: at(-6, 15, 0) },
    { id: '910210', customer: 'eikeli', title: 'Treg PC på legekontor 3', status: 'Closed', priority: 'Medium', contact: 'Kari Eik', tech: 'ingrid', created: at(-12, 10, 0), last: at(-11, 14, 0) },
    { id: '910236', customer: 'fjordlys', title: 'Tilgang til felles postkasse for regnskap', status: 'Pending', priority: 'Low', contact: 'Lars Fjeld', tech: 'jonas', created: at(-1, 16, 20), last: at(-1, 16, 20) }
  ];
  D.ticket = function (id) { return D.tickets.filter(function (t) { return t.id === id; })[0]; };
  D.ticketsOf = function (customer) { return D.tickets.filter(function (t) { return t.customer === customer; }); };

  /* ---------- Time entries (hours in decimal, Oslo business dates) ---------- */

  var W = function (nb, en, nn) { return S(nb, en, nn); };
  var DESC = {
    printer: W('Oppsett av ny skriver', 'New printer setup', 'Oppsett av ny skrivar'),
    backup: W('Backup-feil, ny kjøring', 'Backup failure, rerun', 'Backup-feil, ny køyring'),
    review: W('Kvartalsvis gjennomgang på stedet', 'Quarterly on-site review', 'Kvartalsvis gjennomgang på staden'),
    learning: W('Internt: opplæring i Intune', 'Internal: Intune training', 'Internt: opplæring i Intune'),
    disk: W('Diskopprydding og flytting av arkiv', 'Disk clean-up and archive move', 'Diskopprydding og flytting av arkiv'),
    vpn: W('Feilsøking av VPN-klient', 'VPN client troubleshooting', 'Feilsøking av VPN-klient'),
    onboard: W('Klargjøring av PC for ny ansatt', 'New employee PC preparation', 'Klargjering av PC for ny tilsett'),
    m365: W('Microsoft 365-lisenser og postkasser', 'Microsoft 365 licences and mailboxes', 'Microsoft 365-lisensar og postkassar'),
    router: W('Bytte av ruter i havna', 'Router replacement at the marina', 'Bytte av ruter i hamna'),
    remote: W('Fjernøkt (import fra Atera)', 'Remote session (Atera import)', 'Fjernøkt (import frå Atera)'),
    patch: W('Oppdatering av server', 'Server patching', 'Oppdatering av server')
  };
  var seq = 0;
  function te(staff, customer, day, hours, desc, extra) {
    seq += 1;
    return Object.assign({ id: 'te' + seq, staff: staff, customer: customer, date: at(day, 0, 0), hours: hours, desc: DESC[desc] || desc,
      billable: true, onsite: false, source: 'crm', status: 'New', ticket: null, task: null }, extra || {});
  }
  D.time = [
    te('ingrid', 'fjordlys', -7, 1.5, 'printer', { ticket: '910201' }),
    te('ingrid', 'nordlys', -7, 2.0, 'backup', { ticket: '910198' }),
    te('ingrid', 'bergvik', -7, 3.0, 'review', { onsite: true }),
    te('ingrid', null, -7, 1.0, 'learning', { billable: false }),
    te('ingrid', 'kvamme', -6, 2.25, 'disk'),
    te('ingrid', 'skarvoy', -6, 1.75, 'vpn', { ticket: '910228' }),
    te('ingrid', 'eikeli', -6, 3.0, 'm365'),
    te('ingrid', 'fjordlys', -5, 2.5, 'm365'),
    te('ingrid', 'nordlys', -5, 3.0, 'patch'),
    te('ingrid', 'bergvik', -5, 0.75, 'onboard', { ticket: '910225' }),
    te('ingrid', 'aerlige', -5, 1.5, 'remote', { source: 'atera' }),
    te('ingrid', 'eikeli', -4, 4.0, 'review', { onsite: true }),
    te('ingrid', 'kvamme', -4, 1.0, 'disk', { ticket: '910219', task: 't1' }),
    te('ingrid', 'havnelys', -4, 2.5, 'router', { onsite: true }),
    te('ingrid', 'fjordlys', -3, 1.5, 'patch'),
    te('ingrid', 'kvamme', -3, 0.5, 'disk', { ticket: '910219', task: 't1' }),
    te('ingrid', 'nordlys', -3, 1.5, 'backup'),
    te('ingrid', 'fjordlys', 0, 0.75, 'disk', { ticket: '910231', task: 't2' }),
    te('ingrid', 'fjordlys', 0, 0.5, 'remote', { source: 'atera', ticket: '910231' })
  ];
  /* Colleagues' week 42, for the approval queue */
  [['jonas', 'havbris', 7.5], ['jonas', 'granlund', 7.0], ['jonas', 'vestbris', 7.5], ['jonas', 'lindas', 7.0], ['jonas', 'solsiden', 7.0],
    ['anna', 'fjordlys', 2.0], ['anna', null, 4.0], ['anna', 'c17', 2.5], ['anna', 'nordlys', 3.5]].forEach(function (r, i) {
    var day = r[0] === 'jonas' ? -7 + i : -7 + (i - 5);
    var parts = r[2] > 4 ? [r[2] - 3, 3] : [r[2]];
    parts.forEach(function (h, k) {
      D.time.push(te(r[0], r[1], day, h, k ? 'remote' : (r[1] ? 'patch' : 'learning'), { billable: !!r[1], source: k ? 'atera' : 'crm' }));
    });
  });
  D.monthLocks = [
    { y: 2026, m: 9, status: 'open' },
    { y: 2026, m: 8, status: 'closed', by: 'jonas', at: at(-18, 9, 12) },
    { y: 2026, m: 7, status: 'closed', by: 'jonas', at: at(-49, 8, 55) }
  ];
  D.dailyTarget = 7.5;

  /* ---------- Contracts and hour banks ---------- */

  D.contracts = D.customers.filter(function (c) { return c.status === 'customer'; }).map(function (c, i) {
    var managed = c.devicesN * 450;
    var renewal = new Date(2027, (i * 5) % 12, 1);
    if (c.id === 'fjordlys') renewal = new Date(2027, 1, 1);
    if (c.id === 'havbris') renewal = new Date(2026, 10, 30);
    var notice = new Date(renewal.getFullYear(), renewal.getMonth() - 3, renewal.getDate());
    return {
      id: 'K-2026-' + String(i + 1).padStart(4, '0'), customer: c.id,
      name: c.devicesN > 15 ? 'Managed Workstation Pro' : 'Managed Workstation',
      sla: c.devicesN > 25 ? '12x5' : '8x5', monthly: managed + (c.hourBank ? 0 : 0),
      lines: [
        { text: S('Administrert arbeidsstasjon', 'Managed workstation', 'Administrert arbeidsstasjon'), qty: c.devicesN, unit: 450 },
        { text: S('Sikkerhetskopi av Microsoft 365', 'Microsoft 365 backup', 'Tryggingskopi av Microsoft 365'), qty: Math.max(5, c.devicesN + 2), unit: 39 }
      ],
      start: new Date(2025, (i * 3) % 12, 1), renewal: renewal, notice: notice
    };
  });
  D.contractOf = function (customer) { return D.contracts.filter(function (k) { return k.customer === customer; })[0]; };
  D.slaPolicies = {
    '8x5': { window: '08–16', days: S('man–fre', 'Mon–Fri', 'man–fre'), p1: 4, p2: 8, p3: 16, p4: 40 },
    '12x5': { window: '07–19', days: S('man–fre', 'Mon–Fri', 'man–fre'), p1: 2, p2: 6, p3: 12, p4: 40 }
  };

  /* ---------- PowerOffice invoices, credit notes and posted ledger ---------- */

  D.financeReadAt = at(0, 8, 0);
  D.invoices = [];
  var invNo = 10041;
  [[7, 3], [8, 3], [9, 3]].forEach(function (period, pi) {
    D.customers.forEach(function (c, ci) {
      if (c.status !== 'customer' || c.id === 'trollvik' && pi === 2) return;
      var k = D.contractOf(c.id);
      var lines = k.lines.map(function (l) { return { text: l.text, qty: l.qty, unit: l.unit }; });
      var rateHours = c.hourBank && c.hourBank.left < 3 ? 2.5 : (rnd() > 0.88 ? 1.5 : 0);
      if (rateHours) lines.push({ text: S('Arbeid etter timepris', 'Work at hourly rate', 'Arbeid etter timepris'), qty: rateHours, unit: 1250, period: true });
      var net = lines.reduce(function (s, l) { return s + l.qty * l.unit; }, 0);
      var total = Math.round(net * 1.25 * 100) / 100;
      var date = new Date(2026, period[0], period[1]);
      var terms = ci % 3 === 1 ? 30 : 14; /* every third customer has 30 days to pay */
      var due = new Date(2026, period[0], period[1] + terms);
      var r = rnd();
      var outstanding = 0;
      if (pi === 2) outstanding = r > 0.72 ? total : r > 0.64 ? Math.round(total * 0.4) : 0;
      if (pi === 1 && r > 0.95) outstanding = total;
      if (c.id === 'fjordlys') outstanding = pi === 2 ? total : 0;
      D.invoices.push({ no: String(invNo++), customer: c.id, kind: 'Invoice', date: date, due: due, net: net, total: total,
        outstanding: outstanding, lines: lines, coverage: pi === 0 ? 'Reconciled' : 'RetrievedUnverified',
        pdf: pi === 0 && rnd() > 0.5 ? 'NOT_STORED' : 'STORED', period: new Date(2026, period[0] - 1, 1) });
    });
    if (pi === 1) {
      /* A credit note for the August invoice, numbered in date order */
      D.invoices.push({ no: String(invNo++), customer: 'fjordlys', kind: 'CreditNote', date: new Date(2026, 8, 10), due: new Date(2026, 8, 10),
        net: -1250, total: -1562.5, outstanding: 0, related: D.invoices.filter(function (x) { return x.customer === 'fjordlys'; })[0].no,
        lines: [{ text: S('Kreditt: timer telt to ganger i august', 'Credit: hours counted twice in August', 'Kreditt: timar telt to gonger i august'), qty: 1, unit: -1250 }],
        coverage: 'RetrievedUnverified', pdf: 'STORED' });
    }
  });
  D.overdueNo = D.invoices.filter(function (x) { return x.customer === 'fjordlys' && x.kind === 'Invoice'; }).pop().no;
  D.task('a2').subject = S('Påminn kunden om faktura ' + D.overdueNo, 'Remind the customer about invoice ' + D.overdueNo, 'Påminn kunden om faktura ' + D.overdueNo);

  D.invoiceStatus = function (inv) {
    if (inv.kind === 'CreditNote') return 'Credited';
    if (inv.outstanding <= 0) return 'Paid';
    if (inv.outstanding < inv.total) return P.dayDiff(P.NOW, inv.due) > 0 ? 'Overdue' : 'PartiallyPaid';
    return P.dayDiff(P.NOW, inv.due) > 0 ? 'Overdue' : 'Sent';
  };
  D.invoicesOf = function (customer) {
    return D.invoices.filter(function (x) { return x.customer === customer; }).sort(function (a, b) { return b.date - a.date; });
  };
  D.ledgerOf = function (customer) {
    var rows = [];
    D.invoicesOf(customer).forEach(function (inv) {
      rows.push({ kind: inv.kind, date: inv.date, amount: inv.total, doc: inv.no });
      var settled = inv.total - inv.outstanding;
      if (inv.kind === 'Invoice' && settled > 0) {
        rows.push({ kind: 'Payment', date: new Date(inv.due.getFullYear(), inv.due.getMonth(), inv.due.getDate() - 2), amount: -settled, doc: inv.no, match: 'MG-' + (4400 + Number(inv.no) % 97) });
      }
    });
    return rows.sort(function (a, b) { return b.date - a.date; });
  };

  /* ---------- Billing runs ---------- */

  D.billingRuns = [
    { id: '2026-09', y: 2026, m: 8, status: 'ExportedWithErrors', bases: 38, sent: 36, failed: 1, reconcile: 1, net: 412850,
      collectedAt: at(-18, 9, 40), approvedAt: at(-17, 11, 5), approvedBy: 'anna', exportedAt: at(-17, 14, 20) },
    { id: '2026-08', y: 2026, m: 7, status: 'Closed', bases: 38, sent: 38, failed: 0, reconcile: 0, net: 398200,
      collectedAt: at(-48, 9, 10), approvedAt: at(-48, 13, 0), approvedBy: 'anna', exportedAt: at(-48, 15, 0), closedAt: at(-45, 10, 0) }
  ];
  D.bases = D.customers.filter(function (c) { return c.status === 'customer'; }).slice(0, 39).map(function (c) {
    var inv = D.invoices.filter(function (x) { return x.customer === c.id && x.kind === 'Invoice'; });
    var cur = inv[2] || inv[inv.length - 1];
    var prev = inv[1] || cur;
    var flags = [];
    var delta = prev && cur ? (cur.net - prev.net) / prev.net : 0;
    if (Math.abs(delta) >= 0.2) flags.push('DELTA');
    if (c.id === 'trollvik') flags.push('NO_MAPPING');
    if (c.id === 'skarvoy' || c.id === 'c21') flags.push('STALE_QUANTITY');
    if (c.id === 'havnelys') flags.push('INCOMPLETE_HOURS');
    return { customer: c.id, net: cur ? cur.net : 0, delta: delta, flags: flags,
      export: c.id === 'trollvik' ? 'Failed' : c.id === 'havnelys' ? 'ReconciliationRequired' : 'Sent' };
  });

  /* ---------- Contract reminders (contracts.read) ---------- */

  D.reminders = [
    { kind: 'NoticeDeadline', customer: 'fjordlys', date: new Date(2026, 10, 1), contract: 'K-2026-0001' },
    { kind: 'HourBankLow', customer: 'eikeli', left: 3.75, size: 25 },
    { kind: 'HourBankLow', customer: 'havbris', left: 1.75, size: 10 },
    { kind: 'ContractEnding', customer: 'havbris', date: new Date(2026, 10, 30), contract: 'K-2026-0002' }
  ];

  /* ---------- Notifications (stored as kind + parameters, rendered in the reader's language) ---------- */

  D.notifications = {
    ingrid: [
      { kind: 'assigned', from: 'anna', customer: 'nordlys', task: 't3', at: at(-1, 9, 10), unread: true },
      { kind: 'bankLow', customer: 'eikeli', left: 3.75, size: 25, at: at(-3, 7, 0), unread: true },
      { kind: 'weekShort', week: 42, missing: 4.25, at: at(0, 7, 0), unread: false }
    ],
    jonas: [
      { kind: 'approvals', staff: 'ingrid', count: 17, hours: 33.25, week: 42, at: at(0, 7, 0), unread: true },
      { kind: 'bankLow', customer: 'havbris', left: 1.75, size: 10, at: at(-2, 7, 0), unread: true },
      { kind: 'ticketQuiet', ticket: '910233', customer: 'vestbris', days: 2, at: at(0, 7, 30), unread: false }
    ],
    anna: [
      { kind: 'overdue', invoice: D.overdueNo, customer: 'fjordlys', at: at(0, 7, 0), unread: true },
      { kind: 'exportErrors', run: '2026-09', failed: 1, reconcile: 1, at: at(-17, 14, 25), unread: true },
      { kind: 'notice', contract: 'K-2026-0001', customer: 'fjordlys', date: new Date(2026, 10, 1), at: at(-1, 7, 0), unread: false }
    ]
  };

  /* ---------- Team activity (no Atlas summaries: the feed is visible to every role) ---------- */

  D.feed = [
    { who: 'jonas', kind: 'taskFromObs', customer: 'eikeli', at: at(0, 8, 38) },
    { who: 'ingrid', kind: 'taskDone', customer: 'fjordlys', task: 't0', at: at(0, 8, 15) },
    { who: 'system', kind: 'ateraImport', count: 3, at: at(0, 7, 30) },
    { who: 'ingrid', kind: 'taskFromObs', customer: 'fjordlys', at: at(0, 7, 40) },
    { who: 'anna', kind: 'assignedTo', target: 'ingrid', customer: 'nordlys', at: at(-1, 9, 10) },
    { who: 'jonas', kind: 'approved', count: 41, week: 41, at: at(-3, 16, 40) }
  ];

  /* ---------- Connection readiness (saved facts only; nothing here was checked live) ---------- */

  D.connections = {
    authMode: 'ENTRA',
    atlasPersonal: 'PERSONAL_ENTRY_PRESENT',
    mappings: { state: 'CHECKED', checked: 38, limit: 500, review: 'NO_LOCAL_ISSUES_FOUND', unlinked: 2 },
    atera: { enabled: true, write: false, paused: false, lastSuccess: at(0, 8, 30), records: 1284, unlinked: 3, pending: 0, failed: 0 },
    poweroffice: { enabled: true, write: true, paused: false, lastSuccess: at(0, 8, 0), records: 4512, unlinked: 1, pending: 0, failed: 1 },
    graph: { calendar: true, mail: true, sharepoint: true, teams: false, directorySync: at(0, 8, 32), roleSync: at(0, 8, 38) }
  };
})();
