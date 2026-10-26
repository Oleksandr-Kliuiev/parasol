// Parasoll UX demo: every interface key used in code exists in NB, NN and EN, and the three sets match.
// Usage: node docs/ux/demo/tools/check-locales.mjs   (exit code 1 on any gap)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ctx = { console, Intl, Date, Math, JSON, String, Number, Object, Array, setTimeout, clearTimeout };
ctx.window = ctx;
ctx.addEventListener = () => {};
ctx.document = { addEventListener() {}, documentElement: { lang: '', getAttribute() { return null; } } };
ctx.localStorage = { getItem() { return null; }, setItem() {} };
ctx.location = { hash: '' };
vm.createContext(ctx);
for (const f of ['core.js', 'i18n.js', ...readdirSync(join(root, 'js/locales')).map((f) => 'locales/' + f)]) {
  vm.runInContext(readFileSync(join(root, 'js', f), 'utf8'), ctx, { filename: f });
}
const L = ctx.P.locales;

const used = new Set();
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) { if (f !== 'locales') walk(p); } else if (p.endsWith('.js')) files.push(p);
  }
})(join(root, 'js'));
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  for (const m of s.matchAll(/\bt\(\s*'([^']+)'\s*[,)]/g)) used.add(m[1]);
  for (const m of s.matchAll(/(?:label|hint): '([a-z]+\.[A-Za-z.]+)'/g)) used.add(m[1]);
}
/* Keys built at run time from enum values */
const ENUMS = {
  'nav.': ['dayShort', 'alertsShort', 'customersShort', 'timeShort', 'work', 'clients', 'money', 'system'],
  'keys.': ['palette', 'search', 'newTask', 'logTime', 'goDay', 'goAlerts', 'goCustomers', 'goTime', 'close'],
  'role.': ['technician', 'servicelead', 'admin'],
  'admin.': ['users', 'technicians', 'integrations', 'mappings', 'background', 'audit', 'recordAccess', 'privacy', 'maintenance', 'customFields', 'catalog', 'quoteTemplates', 'pipelineStages', 'migration'].flatMap(k => [k, k + 'Text']),
  'alert.kindText.': ['DISK_CAPACITY', 'SECURITY_INCIDENT'],
  'alert.work.': ['all', 'none', 'has'],
  'alertStatus.': ['OPEN', 'CLOSED', 'CLOSED_AT_SOURCE', 'HIDDEN'],
  'conn.': ['atera', 'poweroffice', 'huntress'],
  'conn.sync.': ['ateraAgents', 'ateraAlerts', 'ateraTickets', 'ateraTime', 'poCustomers', 'poInvoices', 'poLedger', 'huntressIncidents', 'huntressAgents'],
  'contact.': ['role0', 'role1', 'role2'],
  'contract.': ['p1', 'p2', 'p3', 'p4'],
  'cov.': ['EmptyUnverified', 'RetrievedUnverified', 'Reconciled'].flatMap(k => [k, k + 'Text']),
  'cust.chip.': ['all', 'mine', 'urgent', 'bank', 'unlinked', 'prospect'],
  'density.': ['comfortable', 'compact'],
  'deviceStatus.': ['CONFIRMED', 'UNRESOLVED', 'UNAVAILABLE', 'UNRESOLVEDText', 'UNAVAILABLEText'],
  'feed.': ['system', 'taskFromAlert', 'taskDone', 'ateraImport', 'assignedTo', 'approved'],
  'flag.': ['DELTA', 'NO_MAPPING', 'STALE_QUANTITY', 'INCOMPLETE_HOURS'],
  'fresh.': ['OK', 'STALE', 'ERROR', 'MISSING', 'UNAVAILABLE', 'NOT_CONNECTED', 'FIXTURE'],
  'inv.': ['Paid', 'Overdue', 'PartiallyPaid', 'Sent', 'Credited'],
  'kind.': ['DISK_CAPACITY', 'SECURITY_INCIDENT'],
  'ledger.': ['Invoice', 'CreditNote', 'Payment', 'WriteOff', 'Reversal', 'Other'],
  'perm.name.': ['service', 'activities', 'time.own', 'billing', 'contracts', 'sales', 'projects', 'reports', 'admin'],
  'priority.': ['Low', 'Normal', 'High'],
  'rem.': ['NoticeDeadline', 'HourBankLow', 'ContractEnding', 'NoticeDeadlineText', 'ContractEndingText'],
  'run.': ['Draft', 'Collected', 'Approved', 'Exported', 'Closed'],
  'sales.': ['qualify', 'quote', 'negotiate', 'won'],
  'sev.': ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'],
  'src.': ['atera', 'huntress', 'cloudally', 'poweroffice'],
  'source.': ['ateraAgents', 'ateraTickets', 'ateraAlerts', 'huntressIncidents', 'huntressAgents', 'cloudallyBackups', 'cloudallyWhy'],
  'status.': ['customer', 'prospect'],
  'task.group.': ['late', 'today', 'tomorrow', 'week', 'later', 'none'],
  'taskStatus.': ['Open', 'Done', 'Cancelled'],
  'tasks.kind.': ['all', 'alert', 'ticket', 'nodue'],
  'theme.': ['system', 'light', 'dark'],
  'ticketPriority.': ['Critical', 'High', 'Medium', 'Low'],
  'ticketStatus.': ['Open', 'Pending', 'Resolved', 'Closed'],
  'timeStatus.': ['New', 'Approved', 'NonBillable', 'Invoiced'],
  'type.': ['Task', 'Call', 'Meeting', 'Note', 'Email'],
  'alloc.': ['HourBank', 'Rate', 'NonBillable']
};
for (const [p, list] of Object.entries(ENUMS)) for (const k of list) used.add(p + k);

let failed = false;
for (const lang of Object.keys(L)) {
  const missing = [...used].filter((k) => !(k in L[lang]));
  console.log(`${lang}: ${Object.keys(L[lang]).length} keys, missing ${missing.length}${missing.length ? ': ' + missing.join(', ') : ''}`);
  if (missing.length) failed = true;
}
for (const lang of Object.keys(L).filter((l) => l !== 'nb')) {
  const a = Object.keys(L.nb).filter((k) => !(k in L[lang]));
  const b = Object.keys(L[lang]).filter((k) => !(k in L.nb));
  if (a.length || b.length) { failed = true; console.log(`${lang} differs from nb: missing ${a.join(', ')} extra ${b.join(', ')}`); }
}
console.log(failed ? 'FAIL' : 'PASS: all three languages are complete and in sync');
process.exit(failed ? 1 : 0);
