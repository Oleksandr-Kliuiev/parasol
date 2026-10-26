// Local stand-ins for external APIs, for demos, UI work and end-to-end tests without keys or internet:
//   PowerOffice Go API v2  — /OAuth/Token, /v2/Customers, /v2/ContactPersons (list, create, patch), /v2/Products,
//                             /v2/SalesOrders (find by reference, create), /v2/OutgoingInvoices (+ /{id}/Lines; an order becomes an invoice)
//                             (shapes from swagger.poweroffice.net)
//   Atera API v3 — /api/v3/customers, /contacts, /tickets (+ workhoursrecords), /agents, /alerts, /customvalues (shapes from the Atera docs),
//                  and test-only control routes under /_mock/atera (atera.mjs, README)
//   Enhetsregisteret (Brreg) — /enhetsregisteret/api/enheter
// Run: node tools/dev-mocks/external-apis.mjs [port]   (default 5299). Data is in memory and new on every start.
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createAtera } from './atera.mjs';

const port = Number(process.argv[2] ?? process.env.MOCK_PORT ?? 5299);
const startedAt = new Date().toISOString();
const run = Math.random().toString(36).slice(2, 7).toUpperCase();

function orgNumber(seed) {
  const weights = [3, 2, 7, 6, 5, 4, 3, 2];
  for (let n = seed; ; n++) {
    const digits = String(80000000 + (n % 19999999)).padStart(8, '0').split('').map(Number);
    let check = 11 - (digits.reduce((sum, d, i) => sum + d * weights[i], 0) % 11);
    if (check === 11) check = 0;
    if (check !== 10) return digits.join('') + check;
  }
}
const seed = Math.floor(Math.random() * 10_000_000);
// Ids differ per run so links created in an earlier run never match this run's customers.
const base = 1000 + Math.floor(Math.random() * 900_000);

// ---------------- PowerOffice ----------------
const customers = new Map(
  [
    { Id: base + 1, Name: `Havbris Rørlegger ${run} AS`, OrganizationNumber: orgNumber(seed), EmailAddress: `post@havbris-${run.toLowerCase()}.no`, InvoiceDeliveryType: 'EHF', City: 'BERGEN', AddressLine1: 'Bryggen 3', ZipCode: '5003' },
    { Id: base + 2, Name: `Fjordkraft Regnskap ${run}`, OrganizationNumber: null, EmailAddress: `kontakt@fjordregnskap-${run.toLowerCase()}.no`, InvoiceDeliveryType: 'PdfByEmail', City: 'OSLO', AddressLine1: 'Karl Johans gate 1', ZipCode: '0154' },
    { Id: base + 3, Name: `Nordkapp Elektro ${run} AS`, OrganizationNumber: orgNumber(seed + 1000), EmailAddress: `post@nordkapp-${run.toLowerCase()}.no`, InvoiceDeliveryType: 'PdfByEmail', City: 'HAMMERFEST', AddressLine1: 'Strandgata 7', ZipCode: '9600' },
  ].map((c) => [
    c.Id,
    {
      Id: c.Id, Number: c.Id, Name: c.Name, OrganizationNumber: c.OrganizationNumber, EmailAddress: c.EmailAddress,
      InvoiceEmailAddress: c.EmailAddress, InvoiceDeliveryType: c.InvoiceDeliveryType, PhoneNumber: '55 00 00 00',
      MailAddress: { AddressLine1: c.AddressLine1, ZipCode: c.ZipCode, City: c.City, CountryCode: 'NO' },
      IsActive: true, IsArchived: false, LastChangedDateTimeOffset: startedAt,
    },
  ]),
);
const contactPersons = [
  { Id: 1, ContactId: base + 1, FirstName: 'Ingrid', LastName: `Havbris${run}`, EmailAddress: `ingrid@havbris-${run.toLowerCase()}.no`, PhoneNumber: '900 00 001', Title: 'Daglig leder', IsActive: true, LastChangedDateTimeOffset: startedAt },
];
const products = [
  { Id: 1, Code: 'M365-BP', Name: 'Microsoft 365 Business Premium', ProductType: 'Service', UnitPrice: 250, IsArchived: false, LastChangedDateTimeOffset: startedAt },
  { Id: 2, Code: 'TIME', Name: 'Konsulenttime', ProductType: 'Service', UnitPrice: 1250, IsArchived: false, LastChangedDateTimeOffset: startedAt },
];
let nextId = base + 100;
// Sales orders the CRM exports, and the invoices PowerOffice would make of them (v2 OutgoingInvoices: a UUID, the
// voucher date, net/total/posted amounts and the balance, with the lines under /OutgoingInvoices/{id}/Lines).
const salesOrders = [];
const outgoingInvoices = [];
const outgoingInvoiceLines = new Map();
let nextOrderNo = 5000 + Math.floor(Math.random() * 900);
let nextInvoiceNo = 20000 + Math.floor(Math.random() * 900);
// Change times only ever grow, so a sync cursor at one invoice's time never hides another invoice made in the same ms.
let lastStamp = 0;
const stamp = () => new Date((lastStamp = Math.max(Date.now(), lastStamp + 1))).toISOString();
const cents = (value) => Math.round(value * 100) / 100;

// ---------------- Brreg ----------------
function enhet(nr, name, extra = {}) {
  return {
    organisasjonsnummer: nr, navn: name, organisasjonsform: { kode: 'AS', beskrivelse: 'Aksjeselskap' },
    naeringskode1: { kode: '62.020', beskrivelse: 'Konsulentvirksomhet tilknyttet informasjonsteknologi' },
    forretningsadresse: { adresse: ['Storgata 1'], postnummer: '0155', poststed: 'OSLO', landkode: 'NO' },
    postadresse: { adresse: ['Postboks 1'], postnummer: '0101', poststed: 'OSLO', landkode: 'NO' },
    hjemmeside: `www.${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.no`, konkurs: false, underAvvikling: false, underTvangsavviklingEllerTvangsopplosning: false,
    ...extra,
  };
}
const registry = new Map([
  ['923609016', enhet('923609016', 'EQUINOR ASA', { organisasjonsform: { kode: 'ASA', beskrivelse: 'Allmennaksjeselskap' } })],
  ['912345675', enhet('912345675', 'NORDLYS DRIFT AS', { konkurs: true })],
]);
const validOrgNumber = (nr) => {
  if (!/^\d{9}$/.test(nr)) return false;
  const w = [3, 2, 7, 6, 5, 4, 3, 2];
  let c = 11 - ([...nr.slice(0, 8)].reduce((s, d, i) => s + Number(d) * w[i], 0) % 11);
  if (c === 11) c = 0;
  return c !== 10 && c === Number(nr[8]);
};

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const page = (res, url, items) => {
  // Invoices are read by the time their balance changed, everything else by the time the record changed.
  for (const [parameter, field] of [['lastChangedDateTimeOffsetGreaterThan', 'LastChangedDateTimeOffset'], ['balanceLastChangedDateTimeOffsetGreaterThan', 'BalanceLastChangedDateTimeOffset']]) {
    if (!url.searchParams.has(parameter)) continue;
    const since = new Date(url.searchParams.get(parameter));
    items = items.filter((i) => new Date(i[field]) > since);
  }
  const size = Number(url.searchParams.get('PageSize') ?? 5000);
  const number = Number(url.searchParams.get('PageNumber') ?? 1);
  const slice = items.slice((number - 1) * size, number * size);
  return slice.length ? send(res, 200, slice) : send(res, 204);
};

// ---------------- Atera ----------------
// Created contacts and tickets take their ids from the same counter as PowerOffice records.
const atera = createAtera({ customers, base, run, orgNumber, newId: () => nextId++, send });

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      if (process.env.MOCK_LOG) console.log(new Date().toISOString(), req.method, url.pathname + url.search, body.slice(0, 300));

      if (url.pathname === '/health') return send(res, 200, { status: 'ok', run });

      // Brreg
      const enhetMatch = url.pathname.match(/^\/enhetsregisteret\/api\/enheter\/(\d+)$/);
      if (enhetMatch) {
        const nr = enhetMatch[1];
        if (registry.has(nr)) return send(res, 200, registry.get(nr));
        // Any other valid org number exists as a generated company, so tests can create unique organizations.
        return validOrgNumber(nr) && nr.startsWith('8') ? send(res, 200, enhet(nr, `TESTFIRMA ${nr} AS`)) : send(res, 404, { feilmelding: 'Ikke funnet' });
      }
      if (url.pathname === '/enhetsregisteret/api/enheter') {
        const name = (url.searchParams.get('navn') ?? '').toLowerCase();
        const found = [...registry.values()].filter((e) => e.navn.toLowerCase().includes(name));
        return send(res, 200, found.length ? { _embedded: { enheter: found }, page: { totalElements: found.length } } : { page: { totalElements: 0 } });
      }

      // Atera (API and test-only control routes)
      if (atera(req, res, url, body)) return;

      // PowerOffice
      if (url.pathname === '/OAuth/Token') return send(res, 200, { access_token: 'mock-token', token_type: 'bearer', expires_in: 1200 });
      if (!url.pathname.startsWith('/v2/')) return send(res, 404, { title: 'Unknown mock route' });
      if (req.headers.authorization !== 'Bearer mock-token') return send(res, 401, { title: 'Unauthorized' });
      if (url.pathname === '/v2/Customers' && req.method === 'GET') {
        const ref = url.searchParams.get('externalImportReference');
        const orgNo = url.searchParams.get('organizationNumbers');
        if (ref) return page(res, url, [...customers.values()].filter((c) => c.ExternalImportReference === ref));
        if (orgNo) return page(res, url, [...customers.values()].filter((c) => c.OrganizationNumber === orgNo));
        return page(res, url, [...customers.values()]);
      }
      if (url.pathname === '/v2/Customers' && req.method === 'POST') {
        const created = { ...JSON.parse(body), Id: nextId, Number: nextId, IsActive: true, IsArchived: false, LastChangedDateTimeOffset: new Date().toISOString() };
        customers.set(nextId++, created);
        return send(res, 201, created);
      }
      const customerMatch = url.pathname.match(/^\/v2\/Customers\/(\d+)$/);
      if (customerMatch) {
        const customer = customers.get(Number(customerMatch[1]));
        if (!customer) return send(res, 404, { title: 'Not found' });
        if (req.method === 'PATCH') {
          for (const op of JSON.parse(body)) customer[op.path.slice(1)] = op.value;
          customer.LastChangedDateTimeOffset = new Date().toISOString();
        }
        return send(res, 200, customer);
      }
      if (url.pathname === '/v2/ContactPersons') {
        const codes = url.searchParams.get('externalCodes')?.split(',');
        return page(res, url, codes ? contactPersons.filter((p) => codes.includes(p.ExternalCode)) : contactPersons);
      }
      const personCreate = url.pathname.match(/^\/v2\/ContactPersons\/(\d+)$/);
      if (personCreate && req.method === 'POST') {
        const created = { ...JSON.parse(body), Id: nextId++, ContactId: Number(personCreate[1]), LastChangedDateTimeOffset: new Date().toISOString() };
        contactPersons.push(created);
        return send(res, 201, created);
      }
      const personMatch = url.pathname.match(/^\/v2\/ContactPersons\/(\d+)\/(\d+)$/);
      if (personMatch) {
        const person = contactPersons.find((p) => p.ContactId === Number(personMatch[1]) && p.Id === Number(personMatch[2]));
        if (!person) return send(res, 404, { title: 'Not found' });
        if (req.method === 'PATCH') {
          for (const op of JSON.parse(body)) person[op.path.slice(1)] = op.value;
          person.LastChangedDateTimeOffset = new Date().toISOString();
        }
        return send(res, 200, person);
      }
      if (url.pathname === '/v2/Products') return page(res, url, products);
      if (url.pathname === '/v2/SalesOrders' && req.method === 'GET') {
        const refs = url.searchParams.get('externalImportReferences')?.split(',') ?? [];
        return page(res, url, refs.length > 0 ? salesOrders.filter((o) => refs.includes(o.ExternalImportReference)) : salesOrders);
      }
      if (url.pathname === '/v2/SalesOrders' && req.method === 'POST') {
        const posted = JSON.parse(body);
        const orderNo = nextOrderNo++;
        const total = (posted.Lines ?? []).reduce((sum, l) => sum + l.Quantity * l.UnitPrice * (1 - (l.DiscountPercent ?? 0) / 100), 0);
        const order = {
          Id: nextId++, OrderNo: orderNo, CustomerId: posted.CustomerId, CustomerNo: posted.CustomerId,
          ExternalImportReference: posted.ExternalImportReference, CustomerReference: posted.CustomerReference,
          OrderDate: posted.OrderDate, Status: 'Draft', TotalAmount: total, LastChangedDateTimeOffset: new Date().toISOString(),
        };
        salesOrders.push(order);
        // Finance invoices the order in Go; the mock does it right away so the CRM can mirror the invoice back, 25 % VAT.
        const id = randomUUID();
        const lines = (posted.Lines ?? []).map((l, index) => {
          const net = cents(l.Quantity * l.UnitPrice * (1 - (l.DiscountPercent ?? 0) / 100));
          const gross = cents(net * 1.25);
          return {
            Id: nextId++, SortOrder: l.SortOrder ?? index, LineType: 'Normal', Description: l.Description, ProductCode: l.ProductCode ?? null,
            Quantity: l.Quantity, ProductUnitPrice: l.UnitPrice, VatRate: 0.25, NetAmount: net, VatAmount: cents(gross - net),
            TotalAmount: gross, NetPostedAmount: net, TotalPostedAmount: gross,
          };
        });
        const net = cents(lines.reduce((sum, l) => sum + l.NetAmount, 0));
        const gross = cents(lines.reduce((sum, l) => sum + l.TotalAmount, 0));
        const changed = stamp();
        outgoingInvoiceLines.set(id, lines);
        outgoingInvoices.push({
          Id: id, InvoiceNo: nextInvoiceNo++, OrderNo: orderNo, CustomerId: Number(posted.CustomerId),
          ExternalImportReference: posted.ExternalImportReference, VoucherType: 'OutgoingInvoice', VoucherDate: changed.slice(0, 10),
          DueDate: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10), CurrencyCode: 'NOK',
          NetAmount: net, TotalAmount: gross, NetPostedAmount: net, TotalPostedAmount: gross, Balance: gross, IsReversed: false,
          LastChangedDateTimeOffset: changed, BalanceLastChangedDateTimeOffset: changed,
        });
        return send(res, 201, order);
      }
      if (url.pathname === '/v2/OutgoingInvoices') return page(res, url, outgoingInvoices);
      const invoiceLines = url.pathname.match(/^\/v2\/OutgoingInvoices\/([0-9a-f-]{36})\/Lines$/i);
      if (invoiceLines) return page(res, url, outgoingInvoiceLines.get(invoiceLines[1].toLowerCase()) ?? []);
      send(res, 404, { title: 'Unknown mock route' });
    });
  })
  .listen(port, () => console.log(`External API mocks on http://localhost:${port} (run ${run})`));
