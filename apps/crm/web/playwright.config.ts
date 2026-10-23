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
  `--Integrations:PowerOffice:BaseUrl=${mock}/v2/`,
  `--Integrations:PowerOffice:TokenUrl=${mock}/OAuth/Token`,
  '--Integrations:PowerOffice:WriteEnabled=true',
  // M38: Atera against the stand-in. Its syncs run when a test starts them (POST /api/v1/integrations/jobs/{id}/trigger): the
  // crons are Hangfire's "never" (31 February), so no scheduled read resolves another test's alerts in between.
  '--Integrations:Atera:Enabled=true',
  `--Integrations:Atera:BaseUrl=${mock}/api/v3/`,
  // M39: the ticket and time actions write to the stand-in only (it keeps what it got); a real account is never configured here.
  '--Integrations:Atera:WriteEnabled=true',
  // M43: customer.create — the "Connect services" wizard creates the customer in the stand-in.
  ...['ticket.reply', 'ticket.note', 'ticket.status', 'ticket.priority', 'ticket.technician', 'ticket.close', 'time.record', 'alert.resolve', 'alert.delete',
    'customer.create']
    .map((kind, index) => `--Integrations:Atera:EnabledActions:${index}=${kind}`),
  '--Integrations:Atera:AlertUrlTemplate=https://atera.example.invalid/alerts/{0}',
  ...['CustomerSyncCron', 'ContactSyncCron', 'TicketSyncCron', 'RecentTicketSyncCron', 'WorkHoursSyncCron', 'AgentSyncCron', 'PatchSyncCron',
    'AlertSyncCron', 'TicketConversationSyncCron']
    .map((cron) => `--Integrations:Atera:${cron}="0 0 31 2 *"`),
  // M41: Huntress against its stand-in, the same way: reads on request only, actions to the stand-in only.
  '--Integrations:Huntress:Enabled=true',
  `--Integrations:Huntress:BaseUrl=${mock}/huntress/v1/`,
  '--Integrations:Huntress:WriteEnabled=true',
  // Huntress allows an account 60 requests a minute and Parasoll keeps 15 of them for people's actions; the stand-in has no limit,
  // and three browsers answering incidents at once would wait out that minute, so it is given more (never Huntress's own address).
  '--Integrations:Huntress:AccountRequestsPerMinute=1200',
  '--Integrations:Huntress:ReadRequestsPerMinute=600',
  '--Integrations:Huntress:ActionRequestsPerMinute=600',
  ...['incident.approve', 'incident.reject', 'incident.step', 'incident.resolve', 'incident.comment', 'escalation.resolve', 'agent.isolate', 'agent.release',
    'agent.uninstall', 'organization.create'].map((kind, index) => `--Integrations:Huntress:EnabledActions:${index}=${kind}`),
  ...['OrganizationSyncCron', 'AgentSyncCron', 'AlertSyncCron', 'ReportSyncCron', 'ReportFileSyncCron'].map((cron) => `--Integrations:Huntress:${cron}="0 0 31 2 *"`),
  // M43: the stand-in serves the reports' PDFs itself, on the loopback host the CRM reaches it on.
  '--Integrations:Huntress:ReportFileHosts:0=localhost',
  // M42: CloudAlly's partner API on the stand-in; every kind of action on, the schedules off (tests start the reads).
  '--Integrations:CloudAlly:Enabled=true',
  `--Integrations:CloudAlly:BaseUrl=${mock}/cloudally/`,
  '--Integrations:CloudAlly:WriteEnabled=true',
  ...['backup.run', 'backup.activate', 'backup.pause', 'backup.resume', 'account.deactivate', 'restore.export', 'restore.other', 'restore.in-place',
    'account.create']
    .map((kind, index) => `--Integrations:CloudAlly:EnabledActions:${index}=${kind}`),
  ...['AccountSyncCron', 'BackupSyncCron', 'BillSyncCron'].map((cron) => `--Integrations:CloudAlly:${cron}="0 0 31 2 *"`),
  // CloudAlly publishes no limit and Parasoll keeps to 120 requests a minute. A backups read asks for every linked account's tasks,
  // the stand-in gathers the accounts of every engine's tests, and three browsers wait on one read, so by the last engine a read
  // outlasted a test's wait (M43): the stand-in is given more, as Huntress's is (never CloudAlly's own address).
  '--Integrations:CloudAlly:RequestsPerMinute=1200',
  '--RateLimits:ApiPerMinute=100000',
  // Every test signs in through the development entry point from one address; the real budget has its own integration test.
  '--RateLimits:SignInPerMinute=100000',
  // One development user per role runs the scenarios of every engine within the hour, so the per-user hourly budgets for
  // exports (10) and imports/migration (60) would refuse the engines that run last. The budgets have integration tests
  // (ExportApiTests; RequestHardeningTests checks that every import and export carries its policy).
  '--RateLimits:ExportsPerHour=100000',
  '--RateLimits:MigrationPerHour=100000',
  '--Auth:ActiveUserCacheSeconds=0',
  // Issued quote documents belong to the database that references them (DEV-08): the e2e database gets its own folder,
  // otherwise the orphan cleanup of either worker would remove the other database's documents.
  '--Documents:RootPath=../../../.local/documents-e2e',
].join(' ');
// As in production (DEV-04-AC05), only crm-worker gets the provider keys; crm-web works from the switches and stored data.
const providerKeys = [
  '--Integrations:PowerOffice:ApplicationKey=mock',
  '--Integrations:PowerOffice:ClientKey=mock',
  '--Integrations:PowerOffice:SubscriptionKey=mock',
  '--Integrations:Atera:ApiKey=mock',
  '--Integrations:Huntress:ApiKey=mock',
  '--Integrations:Huntress:ApiSecret=mock',
  '--Integrations:CloudAlly:ClientId=mock',
  '--Integrations:CloudAlly:ClientSecret=mock',
  '--Integrations:CloudAlly:Email=api@parasoll.example',
  '--Integrations:CloudAlly:Password=mock',
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
    // The interface animates its entrances (app/motion.ts); tests measure the settled page, as a person with reduced
    // motion sees it, so geometry and contrast checks never catch a card mid-flight.
    contextOptions: { reducedMotion: 'reduce' },
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
      command: `${dotnet} run --project ../src/Hosts/Crm.Worker --launch-profile http -- --urls http://localhost:5191 --Hangfire:PrepareSchema=true ${hostArgs} ${providerKeys}`,
      url: 'http://localhost:5191/health/live',
      timeout: 300_000,
      reuseExistingServer: reuseServers,
    },
  ],
});
