import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run the real crm-web and crm-worker against SQL Server, with external APIs replaced by
// tools/dev-mocks/external-apis.mjs. Locally SQL runs in the vardahei-crm-sql container (README); CI uses a service container.
const dotnet = process.env.DOTNET ?? 'dotnet';
const sql = process.env.E2E_SQL ?? 'Server=localhost,14333;Database=crm_e2e;User Id=sa;Password=Local_Dev_Passw0rd!;TrustServerCertificate=True;Encrypt=True';
const mock = 'http://localhost:5299';
// HTTPS on the ASP.NET Core development certificate, as in production: the session cookie is Secure, and WebKit (unlike
// Chromium and Firefox) does not keep Secure cookies on http://localhost. The certificate need not be trusted.
const webUrl = 'https://localhost:5181';

// The tests write customers, contracts and billing runs, so they only ever run against a local test database: a server
// on this machine (CI maps its service container to localhost) and a database whose name says it is for e2e.
function checkDatabase(connectionString: string) {
  const parts = new Map(
    connectionString.split(';').filter(Boolean).map((part) => {
      const [key, ...value] = part.split('=');
      return [key!.trim().toLowerCase(), value.join('=').trim()] as const;
    }),
  );
  const server = (parts.get('server') ?? parts.get('data source') ?? '').replace(/^tcp:/i, '').split(/[,\\]/)[0]!.toLowerCase();
  const database = parts.get('database') ?? parts.get('initial catalog') ?? '';
  if (!['localhost', '127.0.0.1', '[::1]', '::1', '.', '(local)'].includes(server) && process.env.E2E_ALLOW_REMOTE_SQL !== '1') {
    throw new Error(`E2E_SQL points to "${server}". The e2e suite writes test data and runs against a local SQL Server only.`);
  }
  if (!/^crm_e2e/i.test(database)) {
    throw new Error(`E2E_SQL uses the database "${database}"; e2e databases are named crm_e2e… so a working database is never touched.`);
  }
}
checkDatabase(sql);

const hostArgs = [
  `--ConnectionStrings:crm="${sql}"`,
  `--Integrations:Brreg:BaseUrl=${mock}/enhetsregisteret/api/`,
  '--Integrations:PowerOffice:Enabled=true',
  '--Integrations:PowerOffice:ApplicationKey=mock',
  '--Integrations:PowerOffice:ClientKey=mock',
  '--Integrations:PowerOffice:SubscriptionKey=mock',
  `--Integrations:PowerOffice:BaseUrl=${mock}/v2/`,
  `--Integrations:PowerOffice:TokenUrl=${mock}/OAuth/Token`,
  '--Integrations:PowerOffice:WriteEnabled=true',
  '--RateLimits:ApiPerMinute=100000',
  '--Auth:ActiveUserCacheSeconds=0',
].join(' ');

// Hosts that are already running are reused only on request: they may be connected to another database than E2E_SQL.
const reuseServers = process.env.E2E_REUSE_SERVERS === '1';

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: process.env.CI ? 2 : 3,
  // A retry collects a trace of the failure; a test that only passes on its retry still fails the run.
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: true,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: webUrl,
    locale: 'en-GB',
    timezoneId: 'Europe/Oslo',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ignoreHTTPSErrors: true,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], colorScheme: 'light' }, testIgnore: /mobile\.spec\.ts/ },
    { name: 'desktop-dark', use: { ...devices['Desktop Chrome'], colorScheme: 'dark' }, testMatch: /a11y\.spec\.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ },
    // The daily scenarios tagged @critical also run in Firefox and WebKit. WebKit here is Playwright's build, not Safari on
    // macOS or iOS: it does not replace a check on the staff's real browsers and devices (DEV-18, EXT-10).
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, grep: /@critical/, testIgnore: /mobile\.spec\.ts/ },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, grep: /@critical/, testIgnore: /mobile\.spec\.ts/ },
  ],
  webServer: [
    { command: 'node ../tools/dev-mocks/external-apis.mjs 5299', url: `${mock}/health`, reuseExistingServer: false },
    {
      command: `${dotnet} run --project ../src/Hosts/Crm.Web --launch-profile http -- --urls ${webUrl} --Database:MigrateOnStartup=true ${hostArgs}`,
      url: `${webUrl}/health/ready`,
      ignoreHTTPSErrors: true,
      timeout: 300_000,
      reuseExistingServer: reuseServers,
    },
    {
      command: `${dotnet} run --project ../src/Hosts/Crm.Worker --launch-profile http -- --urls http://localhost:5191 --Hangfire:PrepareSchema=true ${hostArgs}`,
      url: 'http://localhost:5191/health/live',
      timeout: 300_000,
      reuseExistingServer: reuseServers,
    },
  ],
});
