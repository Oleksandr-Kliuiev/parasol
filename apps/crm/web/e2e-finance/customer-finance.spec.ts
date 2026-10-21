import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createOrganization, signIn } from '../e2e/support';

interface Fixture { organizationId: string; invoiceId: string; creditId: string; documents: { id: string; hash: string }[] }
const execute = promisify(execFile);
const script = fileURLToPath(new URL('../../tools/testing/customer-finance-fixture.mjs', import.meta.url));
async function control(operation: 'seed' | 'corrupt', organizationId: string, documentId?: string): Promise<Fixture> {
  const result = await execute(process.execPath, [script, operation, organizationId, ...(documentId ? [documentId] : [])], { env: process.env, timeout: 60_000 });
  return JSON.parse(result.stdout) as Fixture;
}
async function setup(page: Page) {
  await signIn(page, 'Crm.Admin', '/organizations');
  const organization = await createOrganization(page, { name: 'Synthetic finance customer', status: 'Customer' });
  const fixture = await control('seed', organization.id);
  await signIn(page, 'Crm.Finance', `/organizations/${organization.id}?tab=invoices`);
  await expect(page.getByText('Invoice 20001', { exact: true })).toBeVisible();
  return fixture;
}
async function openInvoice(page: Page) {
  await page.getByRole('button', { name: 'View 20001', exact: true }).click();
  await expect(page.getByText('Synthetic support service with a deliberately long description for readable narrow layouts', { exact: true })).toBeVisible();
}
async function accessible(page: Page, info: TestInfo, name: string) {
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  for (const button of await page.getByRole('button', { name: 'Refresh', exact: true }).all()) await expect(button).toBeEnabled();
  await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined))); });
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).exclude('[data-tabster-dummy]').analyze();
  if (axe.violations.length) await info.attach(name + '-axe', { body: JSON.stringify(axe.violations), contentType: 'application/json' });
  expect(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => ({ target: n.target, reason: n.failureSummary })) }))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.title()).not.toBe('');
  if (process.env.UI_LAYOUT_AUDIT_MODULE) {
    const { auditPage } = await import(process.env.UI_LAYOUT_AUDIT_MODULE) as { auditPage: (page: Page) => Promise<{ level: string; rule: string; where: string; detail: string }[]> };
    const findings = await auditPage(page);
    await info.attach(name + '-audit', { body: JSON.stringify(findings), contentType: 'application/json' });
    expect(findings.filter(f => f.level === 'error' || f.level === 'warn')).toEqual([]);
  }
  await page.screenshot({ path: info.outputPath(name + '.png'), fullPage: true });
}

test('actual local invoices, credit notes, match-group payments and verified PDFs work from the customer card', async ({ page }, info) => {
  const fixture = await setup(page);
  const finance = page.getByRole('region', { name: 'Customer finance', exact: true });
  await expect(finance.getByText('Credit note 20002')).toBeVisible();
  await expect(finance.getByText('Showing 50 of 52')).toBeVisible();
  await finance.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(finance.getByText('Showing 52 of 52')).toBeVisible();
  await openInvoice(page);
  await expect(page.getByText('Net · EUR', { exact: true })).toBeVisible();
  await expect(page.getByText(/completeness is unverified/)).toBeVisible();
  const lines = page.getByRole('region', { name: 'Invoice lines', exact: true });
  await lines.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(lines.getByText('Synthetic source line 26', { exact: true })).toBeVisible();
  const pdf = page.getByRole('region', { name: 'Saved PDFs', exact: true });
  await expect(pdf.getByText(/PowerOffice reported no PDF/)).toBeVisible();
  const event = page.waitForEvent('download');
  await pdf.getByRole('button', { name: 'Download PDF 1', exact: true }).click();
  const download = await event;
  expect(download.suggestedFilename()).toBe(`invoice-${fixture.documents[0]!.id.replaceAll('-', '')}.pdf`);
  const path = info.outputPath('verified-source.pdf'); await download.saveAs(path);
  expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(fixture.documents[0]!.hash);
  const payments = page.getByRole('region', { name: 'Payments and entries', exact: true });
  await expect(payments.getByText(/no per-invoice payment amount is inferred/)).toBeVisible();
  await payments.getByRole('button', { name: 'Open related 20002', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Credit note 20002', exact: true })).toBeVisible();
  await expect(page.getByText(/Source references invoice 20001/)).toBeVisible();
  await page.getByRole('button', { name: 'Back to invoices' }).click();
  await finance.getByRole('tab', { name: 'Payments and entries', exact: true }).click();
  await expect(payments.getByText('Showing 25 of 27')).toBeVisible();
  await payments.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(payments.getByText('Showing 27 of 27')).toBeVisible();
  await expect(payments.getByText(/Absent from the latest scan/)).toBeVisible();
  await payments.getByRole('switch', { name: 'Only posted payments' }).uncheck();
  await expect(payments.getByText('Showing 25 of 31')).toBeVisible();
  await payments.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(payments.getByText('Write-off', { exact: true })).toBeVisible();
});

test('corrupt stored PDF is refused by the actual API and gives an actionable download error', async ({ page }) => {
  const fixture = await setup(page); await openInvoice(page);
  await control('corrupt', fixture.organizationId, fixture.documents[1]!.id);
  const response = page.waitForResponse(r => r.url().includes(fixture.documents[1]!.id + '/download'));
  await page.getByRole('button', { name: 'Download PDF 2' }).click();
  expect((await response).status()).toBe(500);
  await expect(page.getByRole('alert').filter({ hasText: 'PDF download failed' })).toBeVisible();
  const event = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download PDF 1' }).click();
  expect((await event).suggestedFilename()).toContain('invoice-');
});

test('read-only staff cannot request protected financial APIs and empty customer navigation clears old records', async ({ page }) => {
  const fixture = await setup(page);
  await signIn(page, 'Crm.Admin', '/organizations');
  const other = await createOrganization(page, { name: 'Synthetic empty customer', status: 'Customer' });
  await signIn(page, 'Crm.Finance', `/organizations/${other.id}?tab=invoices`);
  await expect(page.getByText('No invoices for this customer.')).toBeVisible();
  await expect(page.getByText('Invoice 20001')).toHaveCount(0);
  expect((await page.request.get(`/api/v1/billing/invoices/${fixture.invoiceId}/history?organizationId=${other.id}`)).status()).toBe(404);
  expect((await page.request.get(`/api/v1/billing/invoices/${fixture.invoiceId}/documents?organizationId=${other.id}`)).status()).toBe(404);
  expect((await page.request.get(`/api/v1/billing/invoices/${fixture.invoiceId}/documents/${fixture.documents[0]!.id}/download?organizationId=${other.id}`)).status()).toBe(404);
  let protectedReads = 0;
  page.on('request', request => { if (/customer-ledger|\/history\?|\/documents\?/.test(request.url())) protectedReads++; });
  await signIn(page, 'Crm.ReadOnly', `/organizations/${fixture.organizationId}?tab=invoices`);
  await expect(page.getByText('Customer finance', { exact: true })).toHaveCount(0);
  expect(protectedReads).toBe(0);
  expect((await page.request.get(`/api/v1/billing/customer-ledger?organizationId=${fixture.organizationId}`)).status()).toBe(403);
  expect((await page.request.get(`/api/v1/billing/invoices/${fixture.invoiceId}/documents`)).status()).toBe(403);
});

test('financial views and adjacent customer tabs fit all required widths and both themes', async ({ page }, info) => {
  test.setTimeout(240_000);
  const fixture = await setup(page);
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/organizations/${fixture.organizationId}?tab=invoices`);
      await expect(page.getByText('Invoice 20001', { exact: true })).toBeVisible();
      await accessible(page, info, `invoices-${width}-${theme}`);
      await openInvoice(page);
      await accessible(page, info, `detail-${width}-${theme}`);
      await page.getByRole('button', { name: 'Download PDF 1' }).hover();
      await page.screenshot({ path: info.outputPath(`hover-${width}-${theme}.png`), fullPage: true });
      await page.getByRole('button', { name: 'Back to invoices' }).click();
      await page.getByRole('region', { name: 'Customer finance', exact: true }).getByRole('tab', { name: 'Payments and entries', exact: true }).click();
      await expect(page.getByText('Posted payment', { exact: true }).first()).toBeVisible();
      await accessible(page, info, `payments-${width}-${theme}`);
      // Documents is one of the customer card's tabs under "More" (daily tabs in the row, UX 2026 §7.4): open it from there.
      await page.getByRole('tab', { name: /^More/ }).click();
      await page.getByRole('menuitem', { name: 'Documents', exact: true }).click();
      await expect(page.getByText('Customer finance', { exact: true })).toHaveCount(0);
      await accessible(page, info, `documents-${width}-${theme}`);
    }
  }
});

test('Nynorsk and Bokmål customer finance copy remains readable at the narrowest width', async ({ page }, info) => {
  const fixture = await setup(page); await page.setViewportSize({ width: 320, height: 900 });
  for (const [language, title, open] of [['nn', 'Kundeøkonomi', 'Vis 20001'], ['nb', 'Kundeøkonomi', 'Vis 20001']]) {
    const response = await page.request.put('/api/v1/identity/me/preferences', { data: { language }, headers: { 'X-CSRF': '1' } });
    expect(response.ok()).toBe(true);
    await page.goto(`/organizations/${fixture.organizationId}?tab=invoices`);
    await expect(page.getByText(title!, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: open!, exact: true }).click();
    await accessible(page, info, `locale-${language}-320`);
  }
  expect(fixture.organizationId).toBeTruthy();
});
