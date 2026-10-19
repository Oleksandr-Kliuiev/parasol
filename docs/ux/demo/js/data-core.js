/* Parasoll UX demo: synthetic staff, roles, customers, devices and Atlas observations.
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
      return s.slice(0, 3) + ' ' + s.slice(3, 6) + ' ' + s.slice(6);
    }
  }

  /* ---------- Staff and roles ---------- */

  D.staff = {
    ingrid: { id: 'ingrid', name: 'Ingrid Solberg', first: 'Ingrid', initials: 'IS', av: 1 },
    jonas: { id: 'jonas', name: 'Jonas Lie', first: 'Jonas', initials: 'JL', av: 2 },
    anna: { id: 'anna', name: 'Anna Dahl', first: 'Anna', initials: 'AD', av: 3 }
  };

  /* Permission names mirror the CRM (Permissions.cs); money follows finance.read */
  D.roles = {
    technician: {
      staff: 'ingrid', label: 'role.technician', entra: 'Technician',
      perms: ['atlas', 'activities', 'time.own', 'service', 'contracts', 'projects']
    },
    servicelead: {
      staff: 'jonas', label: 'role.servicelead', entra: 'ServiceLead',
      perms: ['atlas', 'activities', 'time.own', 'time.manage', 'service', 'sla', 'billing', 'contracts', 'projects']
    },
    admin: {
      staff: 'anna', label: 'role.admin', entra: 'Admin · Finance',
      perms: ['atlas', 'activities', 'time.own', 'time.manage', 'service', 'sla', 'billing', 'finance', 'contracts',
        'sales', 'projects', 'reports', 'admin', 'integrations', 'licensing']
    }
  };

  P.me = function () { return D.staff[D.roles[P.state.role].staff]; };
  P.can = function (perm) { return D.roles[P.state.role].perms.indexOf(perm) !== -1; };

  /* ---------- Customers ---------- */

  var S = function (ru, en, nb) { return { ru: ru, en: en, nb: nb }; };
  var SECT = {
    accounting: S('Бухгалтерия', 'Accounting', 'Regnskap'),
    estate: S('Недвижимость', 'Real estate', 'Eiendom'),
    facility: S('Эксплуатация зданий', 'Facility services', 'Drift og vedlikehold'),
    dental: S('Стоматология', 'Dental clinic', 'Tannklinikk'),
    kindergarten: S('Детский сад', 'Kindergarten', 'Barnehage'),
    law: S('Юридическая фирма', 'Law firm', 'Advokatfirma'),
    electric: S('Электромонтаж', 'Electrical contractor', 'Elektroinstallasjon'),
    bakery: S('Пекарня', 'Bakery', 'Bakeri'),
    architects: S('Архитектура', 'Architects', 'Arkitekter'),
    seafood: S('Морепродукты', 'Seafood', 'Sjømat'),
    medical: S('Медицинский центр', 'Medical centre', 'Legesenter'),
    logistics: S('Логистика', 'Logistics', 'Logistikk'),
    construction: S('Строительство', 'Construction', 'Bygg og anlegg'),
    marina: S('Гавань и сервис', 'Marina', 'Småbåthavn'),
    retail: S('Розничная торговля', 'Retail', 'Varehandel'),
    transport: S('Транспорт', 'Transport', 'Transport'),
    hospitality: S('Гостиницы и кафе', 'Hospitality', 'Overnatting og servering'),
    consulting: S('Консалтинг', 'Consulting', 'Rådgivning')
  };

  var HAND = [
    ['fjordlys', 'Fjordlys Regnskap AS', 'FJL', 'Bergen', 'accounting', 23, 'anna', 'ingrid', ['ingrid', 'jonas'], [20, 4.5]],
    ['havbris', 'Havbris Eiendom AS', 'HVB', 'Stavanger', 'estate', 14, 'anna', 'jonas', ['jonas'], [10, 1.75]],
    ['nordlys', 'Nordlys Drift AS', 'NLD', 'Tromsø', 'facility', 31, 'anna', 'ingrid', ['ingrid'], [40, 26.5]],
    ['bergvik', 'Bergvik Tannklinikk AS', 'BVT', 'Bergen', 'dental', 12, 'anna', 'ingrid', ['ingrid', 'jonas'], [15, 11.25]],
    ['solsiden', 'Solsiden Barnehage SA', 'SOL', 'Trondheim', 'kindergarten', 6, 'jonas', 'jonas', ['jonas'], null],
    ['kvamme', 'Kvamme & Sønn Advokatfirma DA', 'KVS', 'Oslo', 'law', 18, 'anna', 'ingrid', ['ingrid'], [30, 14]],
    ['lindas', 'Lindås Elektro AS', 'LIN', 'Lindås', 'electric', 9, 'jonas', 'jonas', ['jonas'], null],
    ['trollvik', 'Trollvik Bakeri AS', 'TRB', 'Ålesund', 'bakery', 5, 'jonas', 'jonas', [], null],
    ['granlund', 'Granlund Arkitekter AS', 'GRA', 'Oslo', 'architects', 16, 'anna', 'jonas', ['jonas'], [20, 12.5]],
    ['skarvoy', 'Skarvøy Sjømat AS', 'SKS', 'Bodø', 'seafood', 22, 'anna', 'ingrid', ['ingrid'], [20, 9]],
    ['eikeli', 'Eikeli Legesenter AS', 'EIK', 'Bærum', 'medical', 19, 'anna', 'ingrid', ['ingrid', 'jonas'], [25, 3.75]],
    ['vestbris', 'Vestbris Logistikk AS', 'VBL', 'Drammen', 'logistics', 27, 'jonas', 'jonas', ['jonas'], [30, 21]],
    ['aerlige', 'Ærlige Bygg AS', 'AEB', 'Kristiansand', 'construction', 11, 'jonas', 'ingrid', ['ingrid'], null],
    ['havnelys', 'Havnelys AS', 'HNL', 'Haugesund', 'marina', 7, 'jonas', 'ingrid', ['ingrid'], null]
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
      am: h[6], tech: h[7], members: h[8].length ? h[8].concat(['anna']) : [], hourBank: h[9] ? { size: h[9][0], left: h[9][1] } : null,
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
      members: i < 24 ? [techOwner, 'anna'] : i === 24 ? ['anna'] : [],
      hourBank: size ? { size: size, left: Math.round(size * (0.25 + rnd() * 0.7) * 4) / 4 } : null,
      orgnr: orgnr(pick([8, 9])), status: i === 22 ? 'prospect' : 'customer', av: ((i + 2) % 6) + 1, featured: false
    });
  });
  /* Two customers are not linked to Atlas: Trollvik (mapping missing) and the last generated one */
  D.customers.forEach(function (c) {
    c.atlas = c.members.length ? 'READY' : 'NOT_LINKED';
    if (c.atlas === 'NOT_LINKED') c.members = [];
  });
  D.customer = function (id) { return D.customers.filter(function (c) { return c.id === id; })[0]; };
  /* Havnelys did not answer within the per-customer time budget in the last attention read */
  D.customer('havnelys').readStatus = 'TIMEOUT';

  /* ---------- Devices (Atlas registry + saved Atera inventory where a link is confirmed) ---------- */

  var OS_WS = ['Windows 11 Pro 24H2', 'Windows 11 Pro 24H2', 'Windows 11 Pro 23H2', 'Windows 11 Business', 'macOS 15'];
  D.devices = [];
  D.customers.forEach(function (c) {
    if (c.atlas !== 'READY') return;
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
  /* The same hostname exists at two customers: names alone never identify a machine */
  addDevice('bergvik', 'RECEPTION-PC', 'desktop', 'Windows 11 Pro 23H2');
  addDevice('eikeli', 'RECEPTION-PC', 'desktop', 'Windows 11 Pro 24H2');
  addDevice('nordlys', 'NLD-HYPERV-HOST-01.drift.nordlys-intern.local', 'server', 'Windows Server 2022');
  D.device = function (customer, host) {
    return D.devices.filter(function (d) { return d.customer === customer && d.host === host; })[0];
  };
  D.devicesOf = function (customer) { return D.devices.filter(function (d) { return d.customer === customer; }); };

  /* ---------- Atlas observations ---------- */

  var obsSeq = 0;
  D.observations = [];
  function obs(o) {
    obsSeq += 1;
    var dev = o.host ? D.device(o.customer, o.host) : null;
    var rec = {
      id: 'o' + obsSeq, customer: o.customer, severity: o.sev, kind: o.kind,
      route: o.route || (o.kind === 'SECURITY_INCIDENT' ? 'HUMAN_REVIEW' : (o.sev === 'HIGH' || o.sev === 'CRITICAL' ? 'INVESTIGATE' : 'MONITOR')),
      status: o.status || 'OPEN', summary: o.summary, source: o.source || (o.kind === 'SECURITY_INCIDENT' ? 'huntress' : 'atera'),
      device: dev ? dev.id : null, deviceStatus: dev ? 'CONFIRMED' : (o.deviceStatus || 'UNAVAILABLE'),
      occurredAt: o.occurredAt, updatedAt: o.updatedAt || o.occurredAt, task: o.task || null, race: o.race || null,
      detail: o.detail || null, resolvedAt: o.resolvedAt || null
    };
    D.observations.push(rec);
    return rec;
  }
  D.obs = obs;

  var SEC = S;
  obs({ customer: 'fjordlys', sev: 'CRITICAL', kind: 'SECURITY_INCIDENT', summary: 'Possible credential theft on FJL-LT-07', host: 'FJL-LT-07',
    occurredAt: at(0, 7, 52), updatedAt: at(0, 8, 31),
    detail: SEC('Huntress сообщает о запуске средства извлечения учётных данных из памяти процесса LSASS. Отчёт об инциденте отправлен и ожидает проверки.',
      'Huntress reports a credential dumping tool reading LSASS memory. The incident report was sent and awaits review.',
      'Huntress melder om et verktøy som leser LSASS-minnet for å hente påloggingsdata. Hendelsesrapporten er sendt og venter på gjennomgang.') });
  obs({ customer: 'fjordlys', sev: 'HIGH', kind: 'DISK_CAPACITY', summary: 'Disk capacity used: 97% (C:)', host: 'FJL-SRV-01',
    occurredAt: at(-1, 23, 10), task: 't2' });
  obs({ customer: 'bergvik', sev: 'HIGH', kind: 'SECURITY_INCIDENT', summary: 'Mailbox rule review', deviceStatus: 'UNAVAILABLE',
    occurredAt: at(-1, 21, 40),
    detail: SEC('Новое правило пересылки во внешний ящик у пользователя resepsjon@. Устройство не определено: событие относится к почтовому ящику.',
      'A new forwarding rule to an external mailbox for resepsjon@. No device: the event belongs to a mailbox.',
      'En ny videresendingsregel til en ekstern postkasse for resepsjon@. Ingen enhet: hendelsen gjelder en postkasse.') });
  obs({ customer: 'nordlys', sev: 'HIGH', kind: 'SECURITY_INCIDENT', summary: 'Security incident awaiting review', host: 'NLD-LT-14',
    status: 'ACKNOWLEDGED', occurredAt: at(-2, 15, 20), updatedAt: at(-1, 9, 5), task: 't3' });
  obs({ customer: 'kvamme', sev: 'HIGH', kind: 'DISK_CAPACITY', summary: 'Disk capacity used: 96% (C:)', host: 'KVS-LT-04',
    occurredAt: at(-4, 10, 5), task: 't1' });
  obs({ customer: 'eikeli', sev: 'HIGH', kind: 'SECURITY_INCIDENT', summary: 'Security incident awaiting review', host: 'RECEPTION-PC',
    occurredAt: at(0, 6, 58), race: 'j5' });
  obs({ customer: 'havbris', sev: 'HIGH', kind: 'DISK_CAPACITY', summary: 'Disk capacity used: 95% (D:)', host: 'HVB-PC-03',
    occurredAt: at(-1, 14, 30), task: 'j1' });
  obs({ customer: 'vestbris', sev: 'CRITICAL', kind: 'DISK_CAPACITY', summary: 'Disk capacity used: 99% (C:)', host: 'VBL-SRV-02',
    occurredAt: at(0, 5, 12) });
  obs({ customer: 'c15', sev: 'HIGH', kind: 'SECURITY_INCIDENT', summary: 'Security incident awaiting review', host: D.devicesOf('c15')[1].host,
    occurredAt: at(-1, 18, 2) });
  obs({ customer: 'bergvik', sev: 'LOW', kind: 'DISK_CAPACITY', summary: 'Disk capacity used: 72% (C:)', host: 'RECEPTION-PC', occurredAt: at(-6, 11, 0) });
  obs({ customer: 'nordlys', sev: 'MEDIUM', kind: 'DISK_CAPACITY', summary: 'Disk capacity used: 86% (E:)', host: 'NLD-HYPERV-HOST-01.drift.nordlys-intern.local', occurredAt: at(-3, 4, 40) });

  /* Resolved history for device timelines */
  obs({ customer: 'fjordlys', sev: 'MEDIUM', kind: 'DISK_CAPACITY', summary: 'Disk capacity used: 91% (C:)', host: 'FJL-SRV-01', status: 'RESOLVED', occurredAt: at(-21, 2, 15), resolvedAt: at(-20, 10, 0) });
  obs({ customer: 'fjordlys', sev: 'HIGH', kind: 'DISK_CAPACITY', summary: 'Disk capacity used: 95% (C:)', host: 'FJL-SRV-01', status: 'RESOLVED', occurredAt: at(-9, 22, 50), resolvedAt: at(-8, 13, 20) });
  obs({ customer: 'fjordlys', sev: 'LOW', kind: 'SECURITY_INCIDENT', summary: 'Security incident awaiting review', host: 'FJL-LT-07', status: 'SUPPRESSED', occurredAt: at(-30, 12, 0), resolvedAt: at(-30, 15, 0) });

  /* Routine disk observations everywhere Atlas is linked */
  D.customers.forEach(function (c) {
    if (c.atlas !== 'READY') return;
    var devs = D.devicesOf(c.id);
    var count = c.featured ? int(3, 7) : int(1, 4);
    for (var k = 0; k < count; k++) {
      var used = int(70, 92);
      var sev = used >= 85 ? 'MEDIUM' : used >= 76 ? 'LOW' : 'INFO';
      var when = at(-int(0, 12), int(0, 23), int(0, 59));
      if (when > P.NOW) when = new Date(when.getTime() - 86400000); /* an event never lies in the future */
      obs({ customer: c.id, sev: sev, kind: 'DISK_CAPACITY', summary: 'Disk capacity used: ' + used + '% (' + pick(['C:', 'C:', 'D:']) + ')',
        host: pick(devs).host, status: rnd() > 0.85 ? 'ACKNOWLEDGED' : 'OPEN', occurredAt: when });
    }
  });

  D.SEV_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };
  D.isUrgent = function (o) { return o.severity === 'CRITICAL' || o.severity === 'HIGH'; };
  D.isActive = function (o) { return o.status === 'OPEN' || o.status === 'ACKNOWLEDGED'; };
  D.canSee = function (customerId) {
    var c = D.customer(customerId);
    return !!c && c.members.indexOf(P.me().id) !== -1;
  };
  D.visibleObservations = function () {
    return D.observations.filter(function (o) { return D.canSee(o.customer); });
  };

  /* ---------- Source freshness (per Atlas read) ---------- */

  D.atlasReadAt = at(0, 8, 37);
  D.sources = [
    { id: 'atera-agents', source: 'atera', label: 'source.ateraAgents', status: 'OK', asOf: at(0, 8, 30) },
    { id: 'atera-tickets', source: 'atera', label: 'source.ateraTickets', status: 'OK', asOf: at(0, 8, 30) },
    { id: 'atera-alerts', source: 'atera', label: 'source.ateraAlerts', status: 'UNAVAILABLE', asOf: null },
    { id: 'huntress-incidents', source: 'huntress', label: 'source.huntressIncidents', status: 'OK', asOf: at(0, 8, 35) },
    { id: 'huntress-agents', source: 'huntress', label: 'source.huntressAgents', status: 'OK', asOf: at(0, 8, 35) },
    { id: 'm365', source: 'microsoft365', label: 'source.m365', status: 'STALE', asOf: at(-1, 6, 0) }
  ];
  /* Per-customer exceptions */
  D.sourceOverrides = { skarvoy: { 'huntress-incidents': { status: 'STALE', asOf: at(-3, 22, 0) } } };
  D.sourcesFor = function (customerId) {
    var o = D.sourceOverrides[customerId] || {};
    return D.sources.map(function (s) { return o[s.id] ? Object.assign({}, s, o[s.id]) : s; });
  };

  /* Microsoft 365 saved counts (not licences, not machines) */
  D.m365 = {
    fjordlys: { users: 27, registrations: 25, coverage: 'COMPLETE', asOf: at(0, 6, 0) },
    nordlys: { users: 44, registrations: 38, coverage: 'PARTIAL', asOf: at(0, 6, 0), gap: [at(-1, 2, 0), at(-1, 5, 0)] },
    bergvik: { users: 14, registrations: 12, coverage: 'COMPLETE', asOf: at(0, 6, 0) },
    eikeli: { users: 31, registrations: 22, coverage: 'UNAVAILABLE', asOf: at(-2, 6, 0) },
    kvamme: { users: 21, registrations: 19, coverage: 'COMPLETE', asOf: at(0, 6, 0) }
  };
})();
