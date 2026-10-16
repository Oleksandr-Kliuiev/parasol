import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../apps/crm/web/package.json', import.meta.url));
const { defineConfig, devices } = require('@playwright/test');
const fixturePath = process.env.PARASOL_COMPOSITION_FIXTURE;
if (!fixturePath || !isAbsolute(fixturePath)) throw new Error('An absolute owned composition fixture path is required.');
let fixture;
try { fixture = JSON.parse(readFileSync(fixturePath, 'utf8')); }
catch { throw new Error('The composition fixture manifest could not be read.'); }
const base = new URL(fixture.baseUrl);
if (base.protocol !== 'https:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
  || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
  throw new Error('Composition browsers may use only the owned loopback HTTPS application.');
}
const repository = fileURLToPath(new URL('../../', import.meta.url));
const artifacts = join(dirname(fixturePath), 'browser-artifacts');

export default defineConfig({
  testDir: join(repository, 'apps/crm/web/e2e-composition'),
  outputDir: join(artifacts, 'test-results'),
  timeout: 120_000,
  globalTimeout: 15 * 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  repeatEach: 1,
  forbidOnly: true,
  failOnFlakyTests: true,
  reporter: [['list'], ['json', { outputFile: join(artifacts, 'playwright-results.json') }]],
  use: {
    baseURL: base.href,
    locale: 'en-GB',
    timezoneId: 'Europe/Oslo',
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block',
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  // The owned launcher starts and verifies the genuine CRM, Worker and Atlas processes before invoking Playwright.
  projects: [{ name: 'composition-chromium', use: { ...devices['Desktop Chrome'] } }],
});
