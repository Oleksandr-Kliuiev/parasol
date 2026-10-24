// Test-only CLI. The application never loads it and exposes no fixture endpoint.
import { readFile, writeFile, mkdir, stat, realpath } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { sql } from './harness/database.mjs';

const statePath = process.env.PARASOL_FINANCE_STATE;
if (!statePath) throw new Error('An owned local finance fixture is required.');
const info = await stat(statePath);
if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || await realpath(statePath) !== resolve(statePath))
  throw new Error('A private owned state file is required.');
const state = JSON.parse(await readFile(statePath, 'utf8'));
if (statePath !== join(state.directory, 'private/finance-state.json') || !/^crm_e2e_[a-z0-9_]+$/.test(state.sqlDatabase) ||
    state.root !== resolve(import.meta.dirname, '../../../..') || !Number.isInteger(state.ports.sql))
  throw new Error('Only this checkout and its owned E2E database are permitted.');
const uuid = value => { if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value)) throw new Error('Synthetic UUID required.'); return value; };
// Keep sqlcmd input lines bounded; concatenate long JSON outside literals, starting as nvarchar(max).
const quote = value => {
  if (value == null) return 'NULL';
  if (typeof value === 'number') return String(value);
  const chunks = String(value).match(/[\s\S]{1,1000}/g) ?? [''];
  const literals = chunks.map(chunk => "N'" + chunk.replaceAll("'", "''") + "'");
  return literals.length === 1 ? literals[0] : `CAST(${literals[0]} AS nvarchar(max))\n+ ` + literals.slice(1).join('\n+ ');
};
const insert = (table, row) => `INSERT INTO billing.[${table}] (${Object.keys(row).map(k => `[${k}]`).join(',')}) VALUES (${Object.values(row).map(quote).join(',')});`;
const at = '2026-10-18T10:00:00Z'; const day = '2026-01-01';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function pdf(label) {
  const text = `BT /F1 12 Tf 40 740 Td (${label}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${text.length} >>\nstream\n${text}\nendstream`];
  let out = '%PDF-1.4\n'; const offsets = [];
  for (const [i, object] of objects.entries()) { offsets.push(out.length); out += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = out.length; out += 'xref\n0 6\n0000000000 65535 f \n';
  out += offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(out + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'ascii');
}
const operation = process.argv[2]; const org = uuid(process.argv[3]);
// The SQL wrapper independently verifies the immutable Docker ID, ownership label and loopback port before every call.
const exists = await sql(state, `SELECT COUNT(*) FROM customers.Organizations WHERE Id=${quote(org)} AND IsDeleted=0;`);
if (Number(exists.trim()) !== 1) throw new Error('The synthetic customer must exist.');
if (operation === 'seed') {
  const customer = String(900000000 + Math.floor(Math.random() * 99999999));
  const scan = randomUUID(); const invoices = []; const statements = ['SET QUOTED_IDENTIFIER ON; SET ANSI_NULLS ON; SET ANSI_PADDING ON; SET ANSI_WARNINGS ON; SET ARITHABORT ON; SET CONCAT_NULL_YIELDS_NULL ON; SET NUMERIC_ROUNDABORT OFF; SET XACT_ABORT ON; BEGIN TRANSACTION;']; const documents = [];
  for (let n = 0; n < 52; n++) {
    const id = randomUUID(), voucher = randomUUID(), kind = n === 1 ? 'CreditNote' : 'Invoice';
    const number = n === 0 ? '20001' : n === 1 ? '20002' : String(9999 + n);
    const sign = n === 1 ? -1 : 1;
    const lines = Array.from({ length: n === 0 ? 26 : 1 }, (_, i) => ({ id: i + 1, sortOrder: i, lineType: 'Normal',
      description: i === 0 ? 'Synthetic support service with a deliberately long description for readable narrow layouts' : `Synthetic source line ${i + 1}`,
      productId: null, productCode: 'SUPPORT', unitCode: 'HUR', quantity: sign, unitPrice: 80, allowance: null, vatRate: .25,
      netAmount: 80 * sign, vatAmount: 20 * sign, totalAmount: 100 * sign, netPostedAmount: 1000 * sign, totalPostedAmount: 1250 * sign, sourceJson: '{}' }));
    const history = { externalId: voucher, externalCustomerId: customer, kind, currencyCode: 'EUR', netAmount: 80 * sign, totalAmount: 100 * sign,
      netPostedAmount: 1000 * sign, totalPostedAmount: 1250 * sign, balance: sign * 250, relatedInvoiceNo: n === 1 ? '20001' : null,
      isReversed: false, lastChangedAt: at, balanceChangedAt: at, lineCoverage: n === 0 ? 'RetrievedUnverified' : 'Reconciled', lines, sourceJson: '{}' };
    statements.push(insert('Invoices', { Id: id, System: 'poweroffice', InvoiceNo: number, ExternalId: voucher, ExternalCustomerId: customer,
      DocumentKind: kind, HistoryJson: JSON.stringify(history), OrganizationId: org, InvoiceDate: day, DueDate: '2026-01-15',
      TotalIncVat: 1250 * sign, Outstanding: 250 * sign, Status: 'Sent', Url: n === 0 ? 'https://example.invalid/synthetic-reference' : null, SyncedAt: at, CreatedAt: at, IsDeleted: 0 }));
    invoices.push({ id, voucher, number, kind });
  }
  statements.push(insert('CustomerLedgerSnapshots', { System: 'poweroffice', CustomerKey: customer, OrganizationId: org, ScanId: scan, ReadStartedAt: at, SavedAt: at }));
  const entries = [
    ...invoices.slice(0, 2).map(i => ({ kind: i.kind, voucher: i.voucher, type: i.kind === 'Invoice' ? 'OutgoingInvoice' : 'OutgoingCreditNote', amount: i.kind === 'CreditNote' ? -1250 : 1250, match: 500 })),
    ...Array.from({ length: 26 }, (_, i) => ({ kind: 'Payment', voucher: randomUUID(), type: 'BankJournal', amount: i === 1 ? 500 : -1000,
      match: i === 0 ? 500 : null, unknownCurrency: i === 1 })),
    { kind: 'WriteOff', voucher: randomUUID(), type: 'BankJournal', amount: -20 },
    { kind: 'Other', voucher: randomUUID(), type: 'ManualJournal', amount: -10 },
    { kind: 'Payment', voucher: randomUUID(), type: 'BankJournal', amount: -40, inactive: true },
  ];
  let sourceId = 1000000000 + Math.floor(Math.random() * 1000000000);
  for (const [index, item] of entries.entries()) {
    const id = randomUUID();
    const source = { externalId: sourceId++, externalCustomerId: customer, voucherId: item.voucher, voucherNo: index + 1, voucherType: item.type,
      invoiceNo: item.match ? '20001' : null, postingDate: item.inactive ? '2025-01-10' : '2026-01-10', voucherDate: day, dueDate: null,
      amount: item.amount, balance: 0, currencyAmount: item.amount / 10, currencyCode: item.unknownCurrency ? null : 'EUR', matchId: item.match ?? null,
      isWriteOff: item.kind === 'WriteOff', createdAt: at, lastChangedAt: at, kind: item.kind, sourceJson: '{}' };
    statements.push(insert('CustomerLedgerEntries', { Id: id, System: 'poweroffice', ExternalId: source.externalId, CustomerKey: customer,
      VoucherId: item.voucher, MatchId: source.matchId, Kind: item.kind, PostingDate: source.postingDate, LastChangedAt: at,
      LastSeenScanId: item.inactive ? randomUUID() : scan, LastSeenAt: at, SnapshotJson: JSON.stringify(source) }));
    statements.push(insert('CustomerLedgerVersions', { Id: randomUUID(), EntryId: id, SourceChangedAt: at, ObservedAt: at, SnapshotJson: JSON.stringify(source) }));
  }
  for (let version = 1; version <= 2; version++) {
    const content = pdf(`Synthetic original invoice version ${version}`), digest = hash(content), id = randomUUID();
    const key = `billing/invoice-pdfs/${invoices[0].id.replaceAll('-', '')}/${digest}.pdf`;
    const path = join(state.directory, 'private/documents', key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, content, { flag: 'wx', mode: 0o600 });
    statements.push(insert('InvoiceDocuments', { Id: id, InvoiceId: invoices[0].id, SourceName: 'Synthetic-invoice.pdf', ContentSha256: digest,
      ObjectKey: key, Length: content.length, ImportedAt: `2026-10-18T10:0${version}:00Z` }));
    documents.push({ id, hash: digest });
  }
  statements.push(insert('InvoiceDocumentChecks', { InvoiceId: invoices[0].id, HasPdf: 0, CheckedAt: '2026-10-18T10:03:00Z' }));
  statements.push('COMMIT TRANSACTION;'); await sql(state, statements.join('\n'));
  const shape = JSON.parse((await sql(state, `SELECT (SELECT Id, ISJSON(HistoryJson) AS ValidJson, LEN(HistoryJson) AS Characters FROM billing.Invoices WHERE OrganizationId=${quote(org)} FOR JSON PATH) AS Json;`)).trim());
  if (shape.length !== 52 || shape.some(row => row.ValidJson !== 1)) throw new Error('Synthetic history was not stored as valid JSON.');
  console.log(JSON.stringify({ organizationId: org, invoiceId: invoices[0].id, creditId: invoices[1].id, invoices: 52, payments: 27, documents }));
} else if (operation === 'corrupt') {
  const documentId = uuid(process.argv[4]);
  const row = JSON.parse((await sql(state, `SELECT d.ObjectKey FROM billing.InvoiceDocuments d JOIN billing.Invoices i ON i.Id=d.InvoiceId
    WHERE d.Id=${quote(documentId)} AND i.OrganizationId=${quote(org)} AND d.SourceName=N'Synthetic-invoice.pdf' FOR JSON PATH;`)).trim())[0];
  if (!row || !/^billing\/invoice-pdfs\/[a-f0-9]{32}\/[a-f0-9]{64}\.pdf$/.test(row.ObjectKey)) throw new Error('An owned synthetic PDF is required.');
  await writeFile(join(state.directory, 'private/documents', row.ObjectKey), pdf('Synthetic damaged local bytes'));
  console.log(JSON.stringify({ corruptedSyntheticPdf: true }));
} else throw new Error('Unsupported finance fixture operation.');
