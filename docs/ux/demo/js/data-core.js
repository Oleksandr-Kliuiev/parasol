/* Parasoll UX demo: synthetic staff, roles, customers, devices and alerts.
   Everything here is invented for the demo; any resemblance to real companies is accidental. */
(function () {
  'use strict';

  var P = window.P;
  var at = P.at;
  var D = (P.data = {});

  /* Deterministic pseudo-random numbers so every viewer sees the same demo */
  var seed = 20261019;
  function rnd() {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function pick(list) { return list[Math.floor(rnd() * list.length)]; }
  function int(a, b) { return a + Math.floor(rnd() * (b - a + 1)); }
  D.rnd = rnd;

  /* Norwegian organisation numbers: 9 digits, MOD11 check digit */
  function orgnr(first) {
    for (;;) {
      var digits = [first];
      for (var i = 0; i < 7; i++) digits.push(int(0, 9));
      var w = [3, 2, 7, 6, 5, 4, 3, 2];
      var sum = digits.reduce(function (s, d, k) { return s + d * w[k]; }, 0);
      var check = 11 - (sum % 11);
      if (check === 10) continue;
      if (check === 11) check = 0;
      var s = digits.join('') + check;
      return s.slice(0, 3) + ' ' + s.slice(3, 6) + ' ' + s.slice(6);
    }
  }

  /* ---------- Staff and roles ---------- */

  D.staff = {
    ingrid: { id: 'ingrid', name: 'Ingrid Solberg', first: 'Ingrid', initials: 'IS', av: 1 },
    jonas: { id: 'jonas', name: 'Jonas Lie', first: 'Jonas', initials: 'JL', av: 2 },
    anna: { id: 'anna', name: 'Anna Dahl', first: 'Anna', initials: 'AD', av: 3 }
  };

  /* Permission names mirror the CRM (Permissions.cs); money follows finance.read.
     Everyone reads Operations (service.read): devices and alerts have no per-customer membership. */
  D.roles = {
    technician: {
      staff: 'ingrid', label: 'role.technician', entra: 'Technician',
      perms: ['activities', 'time.own', 'service', 'contracts', 'projects']
    },
    servicelead: {
      staff: 'jonas', label: 'role.servicelead', entra: 'ServiceLead',
      perms: ['activities', 'time.own', 'time.manage', 'service', 'sla', 'billing', 'contracts', 'projects']
    },
    admin: {
      staff: 'anna', label: 'role.admin', entra: 'Admin · Finance',
      perms: ['activities', 'time.own', 'time.manage', 'service', 'sla', 'billing', 'finance', 'contracts',
        'sales', 'projects', 'reports', 'admin', 'integrations', 'licensing']
    }
  };

  P.me = function () { return D.staff[D.roles[P.state.role].staff]; };
  P.can = function (perm) { return D.roles[P.state.role].perms.indexOf(perm) !== -1; };

  /* ---------- Customers ---------- */

  var S = function (nb, en, nn) { return { nb: nb, en: en, nn: nn }; };
  var SECT = {
    accounting: S('Regnskap', 'Accounting', 'Rekneskap'),
    estate: S('Eiendom', 'Real estate', 'Eiendom'),
    facility: S('Drift og vedlikehold', 'Facility services', 'Drift og vedlikehald'),
    dental: S('Tannklinikk', 'Dental clinic', 'Tannklinikk'),
    kindergarten: S('Barnehage', 'Kindergarten', 'Barnehage'),
    law: S('Advokatfirma', 'Law firm', 'Advokatfirma'),
    electric: S('Elektroinstallasjon', 'Electrical contractor', 'Elektroinstallasjon'),
    bakery: S('Bakeri', 'Bakery', 'Bakeri'),
    architects: S('Arkitekter', 'Architects', 'Arkitekter'),
    seafood: S('Sjømat', 'Seafood', 'Sjømat'),
    medical: S('Legesenter', 'Medical centre', 'Legesenter'),
    logistics: S('Logistikk', 'Logistics', 'Logistikk'),
    construction: S('Bygg og anlegg', 'Construction', 'Bygg og anlegg'),
    marina: S('Småbåthavn', 'Marina', 'Småbåthavn'),
    retail: S('Varehandel', 'Retail', 'Varehandel'),
    transport: S('Transport', 'Transport', 'Transport'),
    hospitality: S('Overnatting og servering', 'Hospitality', 'Overnatting og servering'),
    consulting: S('Rådgivning', 'Consulting', 'Rådgiving')
  };

  var HAND = [
    ['fjordlys', 'Fjordlys Regnskap AS', 'FJL', 'Bergen', 'accounting', 23, 'anna', 'ingrid', [20, 4.5]],
    ['havbris', 'Havbris Eiendom AS', 'HVB', 'Stavanger', 'estate', 14, 'anna', 'jonas', [10, 1.75]],
    ['nordlys', 'Nordlys Drift AS', 'NLD', 'Tromsø', 'facility', 31, 'anna', 'ingrid', [40, 26.5]],
    ['bergvik', 'Bergvik Tannklinikk AS', 'BVT', 'Bergen', 'dental', 12, 'anna', 'ingrid', [15, 11.25]],
    ['solsiden', 'Solsiden Barnehage SA', 'SOL', 'Trondheim', 'kindergarten', 6, 'jonas', 'jonas', null],
    ['kvamme', 'Kvamme & Sønn Advokatfirma DA', 'KVS', 'Oslo', 'law', 18, 'anna', 'ingrid', [30, 14]],
    ['lindas', 'Lindås Elektro AS', 'LIN', 'Lindås', 'electric', 9, 'jonas', 'jonas', null],
    ['trollvik', 'Trollvik Bakeri AS', 'TRB', 'Ålesund', 'bakery', 5, 'jonas', 'jonas', null],
    ['granlund', 'Granlund Arkitekter AS', 'GRA', 'Oslo', 'architects', 16, 'anna', 'jonas', [20, 12.5]],
    ['skarvoy', 'Skarvøy Sjømat AS', 'SKS', 'Bodø', 'seafood', 22, 'anna', 'ingrid', [20, 9]],
    ['eikeli', 'Eikeli Legesenter AS', 'EIK', 'Bærum', 'medical', 19, 'anna', 'ingrid', [25, 3.75]],
    ['vestbris', 'Vestbris Logistikk AS', 'VBL', 'Drammen', 'logistics', 27, 'jonas', 'jonas', [30, 21]],
    ['aerlige', 'Ærlige Bygg AS', 'AEB', 'Kristiansand', 'construction', 11, 'jonas', 'ingrid', null],
    ['havnelys', 'Havnelys AS', 'HNL', 'Haugesund', 'marina', 7, 'jonas', 'ingrid', null]
  ];

  var GEN = [
    ['Brattvoll Transport AS', 'transport'], ['Sjøgløtt Kafé AS', 'hospitality'], ['Mjøsvik Maskin AS', 'construction'],
    ['Kystlinje Media AS', 'consulting'], ['Tindevik Turisme AS', 'hospitality'], ['Elvebakken Regnskap AS', 'accounting'],
    ['Rypefjord Bygg AS', 'construction'], ['Saltvik Fisk AS', 'seafood'], ['Lysbakken Advokater DA', 'law'],
    ['Grønlia Hagesenter AS', 'retail'], ['Strandvik Optikk AS', 'retail'], ['Bjørkelund Barnehage SA', 'kindergarten'],
    ['Lillevik Rør AS', 'electric'], ['Nordkyst Reiser AS', 'transport'], ['Vindhaug Energi AS', 'consulting'],
    ['Sølvtind Eiendom AS', 'estate'], ['Kløverbakken Dyreklinikk AS', 'medical'], ['Heggvik Snekkeri AS', 'construction'],
    ['Myrvold Revisjon AS', 'accounting'], ['Torgsiden Handel AS', 'retail'], ['Østlia Sport AS', 'retail'],
    ['Breivoll Bilverksted AS', 'transport'], ['Fagerlund Trening AS', 'hospitality'], ['Langvik Økonomi AS', 'accounting'],
    ['Furuhaug Interiør AS', 'retail'], ['Kvitstein Arkitektur AS', 'architects']
  ];

  var CITIES = ['Oslo', 'Bergen', 'Trondheim', 'Stavanger', 'Drammen', 'Fredrikstad', 'Tromsø', 'Sandnes', 'Ålesund', 'Bodø', 'Hamar', 'Molde', 'Arendal', 'Gjøvik', 'Lillehammer', 'Harstad'];

  D.customers = [];
  HAND.forEach(function (h, i) {
    D.customers.push({
      id: h[0], name: h[1], prefix: h[2], city: h[3], sector: SECT[h[4]], devicesN: h[5],
      am: h[6], tech: h[7], hourBank: h[8] ? { size: h[8][0], left: h[8][1] } : null,
      orgnr: orgnr(9), status: 'customer', av: (i % 6) + 1, featured: true
    });
  });
  GEN.forEach(function (g, i) {
    var words = g[0].replace(/[^A-Za-zÆØÅæøå ]/g, '').split(' ');
    var prefix = (words[0].slice(0, 2) + words[1].charAt(0)).toUpperCase().replace(/Æ/g, 'A').replace(/Ø/g, 'O').replace(/Å/g, 'A');
    var techOwner = i < 12 ? 'ingrid' : 'jonas';
    var size = pick([null, 10, 15, 20, 20, 30]);
    D.customers.push({
      id: 'c' + (i + 15), name: g[0], prefix: prefix, city: pick(CITIES), sector: SECT[g[1]], devicesN: int(4, 14),
      am: pick(['anna', 'jonas']), tech: techOwner,
      hourBank: size ? { size: size, left: Math.round(size * (0.25 + rnd() * 0.7) * 4) / 4 } : null,
      orgnr: orgnr(pick([8, 9])), status: i === 22 ? 'prospect' : 'customer', av: ((i + 2) % 6) + 1, featured: false
    });
  });
  /* Atera alerts and devices reach a customer only through a confirmed Atera customer mapping.
     Two customers have none yet: Trollvik and the last generated one. */
  var NO_ATERA = ['trollvik', 'c40'];
  D.customers.forEach(function (c, i) {
    c.atera = NO_ATERA.indexOf(c.id) === -1 ? 'LINKED' : 'NOT_LINKED';
    c.ateraId = c.atera === 'LINKED' ? 4101 + i : null;
  });
  D.customer = function (id) { return D.customers.filter(function (c) { return c.id === id; })[0]; };

  /* ---------- Devices: Atera agents and Huntress agents of the same customer in one row ---------- */

  var OS_WS = ['Windows 11 Pro 24H2', 'Windows 11 Pro 24H2', 'Windows 11 Pro 23H2', 'Windows 11 Business', 'macOS 15'];
  D.devices = [];
  D.customers.forEach(function (c) {
    if (c.atera !== 'LINKED') return;
    var servers = c.devicesN >= 15 ? 2 : c.devicesN >= 9 ? 1 : 0;
    for (var n = 1; n <= c.devicesN; n++) {
      var isServer = n <= servers;
      var kind = isServer ? 'server' : (n % 3 === 0 ? 'desktop' : 'laptop');
      var host = isServer ? c.prefix + '-SRV-0' + n : c.prefix + (kind === 'laptop' ? '-LT-' : '-PC-') + String(n).padStart(2, '0');
      var hasAtera = rnd() > 0.06;
      var hasHuntress = rnd() > 0.12;
      D.devices.push({
        id: c.id + '-d' + n, customer: c.id, host: host, kind: kind,
        sources: [hasAtera ? 'atera' : null, hasHuntress ? 'huntress' : null].filter(Boolean),
        os: hasAtera ? (isServer ? 'Windows Server 2022' : pick(OS_WS)) : null,
        online: hasAtera ? rnd() > 0.12 : null
      });
    }
  });
  function addDevice(customer, host, kind, os) {
    var d = { id: customer + '-' + host.toLowerCase(), customer: customer, host: host, kind: kind, sources: ['atera', 'huntress'], os: os, online: true };
    D.devices.push(d);
    return d;
  }
  /* The same hostname exists at two customers: names alone never identify a device */
  addDevice('bergvik', 'RECEPTION-PC', 'desktop', 'Windows 11 Pro 23H2');
  addDevice('eikeli', 'RECEPTION-PC', 'desktop', 'Windows 11 Pro 24H2');
  addDevice('nordlys', 'NLD-HYPERV-HOST-01.drift.nordlys-intern.local', 'server', 'Windows Server 2022');
  D.device = function (customer, host) {
    return D.devices.filter(function (d) { return d.customer === customer && d.host === host; })[0];
  };
  D.devicesOf = function (customer) { return D.devices.filter(function (d) { return d.customer === customer; }); };

  /* ---------- Alerts: Atera reads one list for every customer and the CRM matches each alert by its
     Atera customer ID; Huntress incidents arrive per Huntress organisation (target state) ---------- */

  var alertSeq = 0;
  D.alerts = [];
  function addAlert(o) {
    alertSeq += 1;
    var dev = o.host ? D.device(o.customer, o.host) : null;
    var rec = {
      id: 'al' + alertSeq, customer: o.customer, severity: o.sev, kind: o.kind,
      status: o.status || 'OPEN', title: o.title, source: o.source || (o.kind === 'SECURITY_INCIDENT' ? 'huntress' : 'atera'),
      device: dev ? dev.id : null, deviceStatus: dev ? 'CONFIRMED' : (o.deviceStatus || 'UNAVAILABLE'),
      occurredAt: o.occurredAt, updatedAt: o.updatedAt || o.closedAt || o.occurredAt, task: o.task || null, race: o.race || null,
      detail: o.detail || null, closedAt: o.closedAt || null, closedBy: o.closedBy || null, reason: o.reason || null
    };
    D.alerts.push(rec);
    return rec;
  }

  addAlert({ customer: 'fjordlys', sev: 'CRITICAL', kind: 'SECURITY_INCIDENT', title: 'Possible credential theft on FJL-LT-07', host: 'FJL-LT-07',
    occurredAt: at(0, 7, 52), updatedAt: at(0, 8, 31),
    detail: S('Huntress melder om et verktøy som leser LSASS-minnet for å hente påloggingsdata. Hendelsesrapporten er sendt og venter på gjennomgang.',
      'Huntress reports a credential dumping tool reading LSASS memory. The incident report was sent and awaits review.',
      'Huntress melder om eit verktøy som les LSASS-minnet for å hente påloggingsdata. Hendingsrapporten er send og ventar på gjennomgang.') });
  addAlert({ customer: 'fjordlys', sev: 'HIGH', kind: 'DISK_CAPACITY', title: 'Disk capacity used: 97% (C:)', host: 'FJL-SRV-01',
    occurredAt: at(-1, 23, 10), task: 't2' });
  addAlert({ customer: 'bergvik', sev: 'HIGH', kind: 'SECURITY_INCIDENT', title: 'Mailbox rule review', deviceStatus: 'UNAVAILABLE',
    occurredAt: at(-1, 21, 40),
    detail: S('En ny videresendingsregel til en ekstern postkasse for resepsjon@. Ingen enhet: hendelsen gjelder en postkasse.',
      'A new forwarding rule to an external mailbox for resepsjon@. No device: the event belongs to a mailbox.',
      'Ei ny vidaresendingsregel til ei ekstern postkasse for resepsjon@. Inga eining: hendinga gjeld ei postkasse.') });
  addAlert({ customer: 'nordlys', sev: 'HIGH', kind: 'SECURITY_INCIDENT', title: 'Security incident awaiting review', host: 'NLD-LT-14',
    occurredAt: at(-2, 15, 20), updatedAt: at(-1, 9, 5), task: 't3' });
  addAlert({ customer: 'kvamme', sev: 'HIGH', kind: 'DISK_CAPACITY', title: 'Disk capacity used: 96% (C:)', host: 'KVS-LT-04',
    occurredAt: at(-4, 10, 5), task: 't1' });
  addAlert({ customer: 'eikeli', sev: 'HIGH', kind: 'SECURITY_INCIDENT', title: 'Security incident awaiting review', host: 'RECEPTION-PC',
    occurredAt: at(0, 6, 58), race: 'j5' });
  addAlert({ customer: 'havbris', sev: 'HIGH', kind: 'DISK_CAPACITY', title: 'Disk capacity used: 95% (D:)', host: 'HVB-PC-03',
    occurredAt: at(-1, 14, 30), task: 'j1' });
  addAlert({ customer: 'vestbris', sev: 'CRITICAL', kind: 'DISK_CAPACITY', title: 'Disk capacity used: 99% (C:)', host: 'VBL-SRV-02',
    occurredAt: at(0, 5, 12) });
  addAlert({ customer: 'c15', sev: 'HIGH', kind: 'SECURITY_INCIDENT', title: 'Security incident awaiting review', host: D.devicesOf('c15')[1].host,
    occurredAt: at(-1, 18, 2) });
  addAlert({ customer: 'bergvik', sev: 'LOW', kind: 'DISK_CAPACITY', title: 'Disk capacity used: 72% (C:)', host: 'RECEPTION-PC', occurredAt: at(-6, 11, 0) });
  addAlert({ customer: 'nordlys', sev: 'MEDIUM', kind: 'DISK_CAPACITY', title: 'Disk capacity used: 86% (E:)', host: 'NLD-HYPERV-HOST-01.drift.nordlys-intern.local', occurredAt: at(-3, 4, 40) });

  /* History for device timelines: closed at the source, closed in the CRM, hidden with a reason */
  addAlert({ customer: 'fjordlys', sev: 'MEDIUM', kind: 'DISK_CAPACITY', title: 'Disk capacity used: 91% (C:)', host: 'FJL-SRV-01', status: 'CLOSED_AT_SOURCE', occurredAt: at(-21, 2, 15), closedAt: at(-20, 10, 0) });
  addAlert({ customer: 'fjordlys', sev: 'HIGH', kind: 'DISK_CAPACITY', title: 'Disk capacity used: 95% (C:)', host: 'FJL-SRV-01', status: 'CLOSED', occurredAt: at(-9, 22, 50), closedAt: at(-8, 13, 20), closedBy: 'ingrid' });
  addAlert({ customer: 'fjordlys', sev: 'LOW', kind: 'SECURITY_INCIDENT', title: 'Security incident awaiting review', host: 'FJL-LT-07', status: 'HIDDEN', occurredAt: at(-30, 12, 0), closedAt: at(-30, 15, 0), closedBy: 'jonas',
    reason: S('Kjent testverktøy fra leverandøren', 'A known test tool from the vendor', 'Kjent testverktøy frå leverandøren') });

  /* Routine disk alerts everywhere Atera is linked */
  D.customers.forEach(function (c) {
    if (c.atera !== 'LINKED') return;
    var devs = D.devicesOf(c.id);
    var count = c.featured ? int(3, 7) : int(1, 4);
    for (var k = 0; k < count; k++) {
      var used = int(70, 92);
      var sev = used >= 85 ? 'MEDIUM' : used >= 76 ? 'LOW' : 'INFO';
      var when = at(-int(0, 12), int(0, 23), int(0, 59));
      if (when > P.NOW) when = new Date(when.getTime() - 86400000); /* an event never lies in the future */
      addAlert({ customer: c.id, sev: sev, kind: 'DISK_CAPACITY', title: 'Disk capacity used: ' + used + '% (' + pick(['C:', 'C:', 'D:']) + ')',
        host: pick(devs).host, occurredAt: when });
      rnd(); /* one more draw per alert keeps every later synthetic value (invoices, hours) unchanged */
    }
  });

  D.SEV_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };
  D.isUrgent = function (a) { return a.severity === 'CRITICAL' || a.severity === 'HIGH'; };
  D.isOpen = function (a) { return a.status === 'OPEN'; };
  D.alert = function (id) { return D.alerts.filter(function (a) { return a.id === id; })[0]; };
  D.alertsOf = function (customer) { return D.alerts.filter(function (a) { return a.customer === customer; }); };

  /* Atera alerts of Atera customers without a confirmed CRM link cannot be attributed: counted, never hidden */
  D.unmatchedAlerts = 2;

  /* ---------- Saved data per source (the background worker syncs it; pages only read what is saved) ---------- */

  D.syncedAt = at(0, 8, 30);
  D.sources = [
    { id: 'atera-agents', source: 'atera', label: 'source.ateraAgents', status: 'OK', asOf: at(0, 8, 30) },
    { id: 'atera-alerts', source: 'atera', label: 'source.ateraAlerts', status: 'OK', asOf: at(0, 8, 30) },
    { id: 'atera-tickets', source: 'atera', label: 'source.ateraTickets', status: 'OK', asOf: at(0, 8, 30) },
    { id: 'huntress-incidents', source: 'huntress', label: 'source.huntressIncidents', status: 'OK', asOf: at(0, 8, 35) },
    { id: 'huntress-agents', source: 'huntress', label: 'source.huntressAgents', status: 'OK', asOf: at(0, 8, 35) },
    { id: 'cloudally-backups', source: 'cloudally', label: 'source.cloudallyBackups', status: 'NOT_CONNECTED', asOf: null, why: 'source.cloudallyWhy' }
  ];
  /* Per-customer exceptions */
  D.sourceOverrides = { skarvoy: { 'huntress-incidents': { status: 'STALE', asOf: at(-3, 22, 0) } } };
  D.sourcesFor = function (customerId) {
    var o = D.sourceOverrides[customerId] || {};
    return D.sources.map(function (s) { return o[s.id] ? Object.assign({}, s, o[s.id]) : s; });
  };
})();
