import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run the real crm-web and crm-worker against SQL Server, with external APIs replaced by
// tools/dev-mocks/external-apis.mjs. Locally SQL runs in the vardahei-crm-sql container (README); CI uses a service container.
const dotnet = process.env.DOTNET ?? 'dotnet';
const sql = process.env.E2E_SQL ?? 'Server=localhost,14333;Database=crm_e2e;User Id=sa;Password=Local_Dev_Passw0rd!;TrustServerCertificate=True;Encrypt=True';
const mock = 'http://localhost:5299';
const webUrl = 'http://localhost:5181';

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

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: webUrl,
    locale: 'en-GB',
    timezoneId: 'Europe/Oslo',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], colorScheme: 'light' }, testIgnore: /mobile\.spec\.ts/ },
    { name: 'desktop-dark', use: { ...devices['Desktop Chrome'], colorScheme: 'dark' }, testMatch: /a11y\.spec\.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: [
    { command: 'node ../tools/dev-mocks/external-apis.mjs 5299', url: `${mock}/health`, reuseExistingServer: false },
    {
      command: `${dotnet} run --project ../src/Hosts/Crm.Web --launch-profile http -- --urls ${webUrl} --Database:MigrateOnStartup=true ${hostArgs}`,
      url: `${webUrl}/health/ready`,
      timeout: 300_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `${dotnet} run --project ../src/Hosts/Crm.Worker --launch-profile http -- --urls http://localhost:5191 --Hangfire:PrepareSchema=true ${hostArgs}`,
      url: 'http://localhost:5191/health/live',
      timeout: 300_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
