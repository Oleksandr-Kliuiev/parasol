import { join } from 'node:path';
import { mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { command, jsonFile, secret, safeEnvironment } from './runtime.mjs';

export async function certificates(state) {
  const directory = join(state.directory, 'private');
  state.certificatePassword = secret();
  const passwordFile = join(directory, 'certificate-password'); const key = join(directory, 'temporary-key.pem'); const cert = join(directory, 'temporary-cert.pem');
  await writeFile(passwordFile, state.certificatePassword, { mode: 0o600 });
  await command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', key, '-out', cert], { label: 'Private test certificate generation' });
  state.certificatePath = join(directory, 'test.pfx');
  await command('openssl', ['pkcs12', '-export', '-out', state.certificatePath, '-inkey', key, '-in', cert, '-passout', `file:${passwordFile}`],
    { label: 'Private test certificate packaging' });
  state.certificatePublicPath = cert;
  await chmod(state.certificatePath, 0o600); await rm(key);
  await mkdir(join(directory, 'keyring'), { mode: 0o700 }); await mkdir(join(directory, 'documents'), { mode: 0o700 });
  await writeFile(join(directory, 'documents/.parasol-volume'), state.documentVolumeId + '\n', { mode: 0o600 });
}
export function connectionString(state, login, password) {
  return `Server=127.0.0.1,${state.ports.sql};Database=${state.sqlDatabase};User ID=${login};Password=${password};Encrypt=True;TrustServerCertificate=True`;
}
export function appConfig(state, kind) {
  const owner = kind === 'migrate'; const worker = kind === 'worker';
  const config = {
    AllowedHosts: 'localhost;127.0.0.1',
    ConnectionStrings: { crm: connectionString(state, owner ? 'sa' : worker ? 'harness_worker' : 'harness_web',
      owner ? state.sqlSaPassword : worker ? state.sqlWorkerPassword : state.sqlWebPassword) },
    Auth: { Mode: 'Development', ActiveUserCacheSeconds: 0 },
    Documents: { Provider: 'FileSystem', RootPath: join(state.directory, 'private/documents'), VolumeId: state.documentVolumeId },
    Hangfire: { DashboardEnabled: false, PrepareSchema: owner },
    Database: { MigrateOnStartup: false },
    Logging: { LogLevel: { Default: 'Warning', 'Microsoft.EntityFrameworkCore': 'Warning' } },
    Kestrel: { Certificates: { Default: { Path: state.certificatePath, Password: state.certificatePassword } } },
    Notifications: { EmailEnabled: false, FromAddress: '' }, Sales: { EmailEnabled: false },
    Integrations: {
      Brreg: { BaseUrl: 'http://127.0.0.1:1/disabled/' },
      PowerOffice: { Enabled: false, WriteEnabled: false, ApplicationKey: '', ClientKey: '', SubscriptionKey: '', BaseUrl: 'http://127.0.0.1:1/disabled/', TokenUrl: 'http://127.0.0.1:1/disabled/' },
      MicrosoftGraph: { Enabled: false, CalendarEnabled: false, MailEnabled: false, SharedMailboxes: [],
        SharePoint: { Enabled: false, SiteId: '' }, Teams: { Enabled: false },
        TenantId: '', ClientId: '', CertificatePath: '', CertificatePassword: '', ManagedIdentityClientId: '', BaseUrl: 'http://127.0.0.1:1/disabled/' },
      PartnerCenter: { Enabled: false, BillingReconciliationEnabled: false, TenantId: '', ClientId: '', ClientSecret: '', RefreshToken: '', BaseUrl: 'http://127.0.0.1:1/disabled/', TokenUrl: 'http://127.0.0.1:1/disabled/' },
      Atera: { Enabled: false, WriteEnabled: false, ApiKey: '', BaseUrl: 'http://127.0.0.1:1/disabled/' },
    },
    RateLimits: { ApiPerMinute: 1000, SignInPerMinute: 1000, MigrationPerHour: 120, ExportsPerHour: 120 },
  };
  if (!worker) {
    config.DataProtection = { KeyRingPath: join(state.directory, 'private/keyring'), CertificatePath: state.certificatePath, CertificatePassword: state.certificatePassword, BlobUri: '', KeyVaultKeyUri: '' };
  } else delete config.Auth;
  return config;
}
export async function writeAppConfig(state, kind) {
  const path = join(state.directory, 'private', `${kind}.json`);
  await jsonFile(path, appConfig(state, kind)); return path;
}
export function appEnvironment(configPath, urls) {
  return safeEnvironment({ ASPNETCORE_ENVIRONMENT: 'Development', DOTNET_ENVIRONMENT: 'Development',
    PARASOL_CONFIG_FILE: configPath, ASPNETCORE_URLS: urls });
}
