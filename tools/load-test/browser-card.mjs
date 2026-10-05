#!/usr/bin/env node
// DEV-16-AC03. Real Chromium paint measurements; never infer LCP from k6/server timings.
// node tools/load-test/browser-card.mjs --manifest /absolute/dataset.json --output /absolute/browser-card.json
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import os from 'node:os';
import { summarizeBrowser, validateManifest } from './workday-contract.mjs';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const args = process.argv.slice(2);
function argument(name, fallback) { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; }
const manifestPath = argument('--manifest', process.env.DATASET_MANIFEST);
const output = argument('--output', 'browser-card-summary.json');
if (!manifestPath) throw new Error('--manifest is required');
const manifest = validateManifest(JSON.parse(await readFile(manifestPath, 'utf8')), { baseUrl: process.env.BASE_URL, allowRemote: process.env.ALLOW_REMOTE_TEST === '1' });
const samples = Number(argument('--samples', '10'));
const warmupSamples = Number(argument('--warmup', '1'));
const timeoutMs = Number(argument('--timeout-ms', '30000'));
const settleMs = Number(argument('--settle-ms', '2000'));
if (!Number.isInteger(samples) || samples < 1 || samples > 100 || !Number.isInteger(warmupSamples) || warmupSamples < 0 || warmupSamples > 10) throw new Error('Use 1–100 measured samples and 0–10 warmup samples.');
if (!(timeoutMs >= 5000 && timeoutMs <= 60000) || !(settleMs >= 1000 && settleMs <= 10000)) throw new Error('Invalid timeout/settling window.');
const profile = {
  name: 'Chromium desktop, cold browser cache, simulated constrained workstation', viewport: { width: 1365, height: 900 },
  deviceScaleFactor: 1, locale: 'en-GB', timezoneId: 'Europe/Oslo', colorScheme: 'light', headless: true,
  cpuSlowdown: Number(argument('--cpu-slowdown', '4')),
  network: { latencyMs: 40, downloadBytesPerSecond: 10 * 1024 * 1024 / 8, uploadBytesPerSecond: 1024 * 1024 / 8 },
  cache: 'A new browser context for each card; cache disabled. Authentication completed through the request context before measurement.',
  timeoutMs, settleMs, warmupSamples, measuredSamples: samples,
};
if (!Number.isFinite(profile.cpuSlowdown) || profile.cpuSlowdown < 1 || profile.cpuSlowdown > 20) throw new Error('CPU slowdown must be 1–20.');
const role = manifest.auth.users.find((u) => u.role === 'Crm.Sales') ?? manifest.auth.users.find((u) => u.weight > 0);
const baseUrl = manifest.baseUrl.replace(/\/$/, '');
const browser = await chromium.launch({ headless: true });
const report = {
  schemaVersion: 1, kind: 'crm-browser-card', createdAt: new Date().toISOString(), datasetId: manifest.datasetId,
  datasetChecksum: manifest.datasetChecksum, datasetProfile: manifest.profile, counts: manifest.counts, seed: manifest.seed,
  browser: { engine: 'Chromium', version: browser.version(), playwrightVersion: require('@playwright/test/package.json').version },
  host: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem() },
  profile, provider: manifest.provider, auth: { mode: manifest.auth.mode, role: role.role, externalSignInMeasured: false },
  definitions: {
    firstUsefulContent: 'First animation frame after the seeded organization name is visibly rendered as main h1 and at least one visible overview detail value (main section dl dd) is present. The time is relative to navigation start.',
    lcp: 'Latest real largest-contentful-paint entry observed until page load and the stated settling window, before any input/scroll. Navigation, HTTP, missing-content and missing-LCP failures remain in samples.',
    source: 'https://www.w3.org/TR/largest-contentful-paint/',
    thresholds: { firstUsefulMs: 2000, lcpMs: 2500, interpretation: 'Every measured card sample must meet both limits and have no request/render errors.' },
    limits: 'Synthetic Chromium lab profile only. CPU throttling is relative to the recorded host, not a substitute for the client devices and agreed deployment in EXT-05.',
  },
  warmup: [], samples: [],
};

async function measure(index, warming) {
  const org = manifest.organizations[(manifest.seed + index) % manifest.organizations.length];
  const context = await browser.newContext({ viewport: profile.viewport, deviceScaleFactor: profile.deviceScaleFactor,
    locale: profile.locale, timezoneId: profile.timezoneId, colorScheme: profile.colorScheme,
    ignoreHTTPSErrors: process.env.ALLOW_LOCAL_TLS === '1', serviceWorkers: 'block' });
  const sample = { index, organizationId: org.id, cache: 'cold', firstUsefulMs: null, lcpMs: null, elapsedMs: 0, httpErrors: [], requestFailures: [], errors: [] };
  const start = Date.now();
  try {
    const login = await context.request.get(`${baseUrl}${role.loginPath}`, { maxRedirects: 0, timeout: timeoutMs });
    const answer = await context.request.get(`${baseUrl}/bff/user`, { timeout: timeoutMs });
    const me = await answer.json();
    if (login.status() !== 302 || answer.status() !== 200 || me.id !== role.userId || me.authMode !== 'Development' || !me.roles?.includes(role.role)) throw new Error('Manifest identity does not match the isolated Development authentication harness');
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuSlowdown });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: profile.network.latencyMs,
      downloadThroughput: profile.network.downloadBytesPerSecond, uploadThroughput: profile.network.uploadBytesPerSecond });
    await page.route('**/*', async (route) => {
      if (new URL(route.request().url()).origin !== baseUrl) { sample.errors.push('A browser request to an external origin was blocked'); await route.abort('blockedbyclient'); }
      else await route.continue();
    });
    page.on('response', (response) => { if (response.status() >= 400) sample.httpErrors.push({ status: response.status(), path: new URL(response.url()).pathname.replace(/[\da-f]{8}-[\da-f-]{27,}/gi, ':id') }); });
    page.on('requestfailed', (request) => sample.requestFailures.push({ path: new URL(request.url()).pathname.replace(/[\da-f]{8}-[\da-f-]{27,}/gi, ':id'), error: request.failure()?.errorText ?? 'Request failed' }));
    page.on('pageerror', (error) => sample.errors.push(`Render error: ${error.name}`));
    await page.addInitScript(({ expectedName }) => {
      window.__crmPerf = { firstUsefulMs: null, lcpMs: null, observerError: null };
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) window.__crmPerf.lcpMs = entry.startTime;
        });
        observer.observe({ type: 'largest-contentful-paint', buffered: true });
      } catch { window.__crmPerf.observerError = 'LargestContentfulPaint observation is unavailable'; }
      const visible = (element) => {
        if (!element) return false;
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && box.top < innerHeight && box.bottom > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      function observeContent() {
        const title = document.querySelector('main h1');
        const detail = [...document.querySelectorAll('main section dl dd')].find(visible);
        if (title?.textContent?.trim() === expectedName && visible(title) && detail) {
          // A second animation frame follows the paint of the observed content.
          requestAnimationFrame(() => { window.__crmPerf.firstUsefulMs = performance.now(); });
        } else requestAnimationFrame(observeContent);
      }
      requestAnimationFrame(observeContent);
    }, { expectedName: org.name });
    const navigationStart = Date.now();
    const navigation = await page.goto(`${baseUrl}/organizations/${org.id}`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (!navigation || navigation.status() !== 200) sample.errors.push(`Card navigation returned ${navigation?.status() ?? 'no response'}`);
    try {
      await page.waitForFunction(() => window.__crmPerf?.firstUsefulMs !== null && window.__crmPerf?.firstUsefulMs !== undefined, undefined, { timeout: timeoutMs });
      await page.waitForLoadState('load', { timeout: timeoutMs });
      await page.waitForTimeout(settleMs);
    } catch { sample.errors.push('Card content or page load timed out'); }
    const measurements = await page.evaluate(() => ({ ...window.__crmPerf, elapsedMs: performance.now() })).catch(() => null);
    sample.firstUsefulMs = measurements?.firstUsefulMs ?? null;
    sample.lcpMs = measurements?.lcpMs ?? null;
    sample.elapsedMs = measurements?.elapsedMs ?? Date.now() - navigationStart;
    if (measurements?.observerError) sample.errors.push(measurements.observerError);
    if (sample.firstUsefulMs === null) sample.errors.push('First useful content was not observed');
    if (sample.lcpMs === null) sample.errors.push('LCP was not observed');
    if (sample.httpErrors.length || sample.requestFailures.length) sample.errors.push('HTTP or transport errors occurred during card rendering');
    if (!warming && index === 0) {
      const screenshot = resolve(dirname(output), 'browser-card-profile.png');
      await page.screenshot({ path: screenshot, fullPage: true });
      report.screenshot = screenshot;
    }
  } catch (error) {
    sample.errors.push(error.message);
    sample.elapsedMs = Math.max(Date.now() - start, timeoutMs);
  } finally { await context.close(); }
  return sample;
}

await mkdir(dirname(resolve(output)), { recursive: true });
try {
  for (let i = 0; i < warmupSamples; i++) report.warmup.push(await measure(i, true));
  for (let i = 0; i < samples; i++) {
    report.samples.push(await measure(i, false));
    // Keep completed and failed samples on disk even if a later sample is interrupted.
    await writeFile(output, JSON.stringify({ ...report, complete: false }, null, 2));
  }
  report.summary = summarizeBrowser(report.samples, timeoutMs);
  report.complete = true;
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output: resolve(output), profile: profile.name, summary: report.summary }));
  process.exitCode = report.summary.passed ? 0 : 1;
} finally { await browser.close(); }
