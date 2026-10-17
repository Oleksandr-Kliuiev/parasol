import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FORMAT, fixturePlan, parseArgs, ROLES } from './plan.mjs';
import { secret, sqlPassword, createStateDirectory, freePort, jsonFile, safeEnvironment, command, startProcess, waitReady } from './runtime.mjs';
import { buildApplications } from './build.mjs';
import { certificates, writeAppConfig, appEnvironment, connectionString } from './config.mjs';
import { startDatabases, prepareSqlLogins, prepareAtlasDatabase, privileges, removeOwnedContainer } from './database.mjs';
import { bootstrapCrm, linkCustomers } from './bootstrap.mjs';
import { seedAtlas, COLLISION_WORKSPACE } from './seed.mjs';
import { recordingGateway } from './gateway.mjs';
import { executeControl } from './control.mjs';
import { seedTicketWork } from './ticket-work.mjs';
import { requireBrowserPass } from '../../scripts/test-result.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export function failureLabel(error, interrupted = false) {
  if (interrupted) return 'RUN_INTERRUPTED';
  const message = typeof error?.message === 'string' ? error.message : '';
  const commandExit = message.match(/ failed \((\d{1,3}|SIG[A-Z]{1,16})\); inspect its redacted stage log\.$/);
  if (commandExit) return `COMMAND_EXIT_${commandExit[1]}`;
  const http = message.match(/^Real CRM bootstrap endpoint failed with HTTP (\d{3})\.$/);
  if (http) return `CRM_BOOTSTRAP_HTTP_${http[1]}`;
  if (message === 'Real Development BFF sign-in failed.') return 'CRM_BFF_SIGN_IN_FAILED';
  if (/^(CRM Web|CRM Worker|Atlas API) exited before readiness\.$/.test(message)) return 'OWNED_APPLICATION_EXITED';
  if (message === 'Owned application readiness timed out.') return 'APPLICATION_READINESS_TIMEOUT';
  if (message === 'Owned PostgreSQL/SQL Server readiness failed.') return 'DATABASE_READINESS_FAILED';
  if (typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code)) return `DRIVER_${error.code}`;
  return 'UNCLASSIFIED_STAGE_FAILURE';
}
export function acceptedReport({ build, browser, evidence, cleanup, diagnostic }) {
  return !diagnostic && build?.builtInThisRun === true && browser?.expected === 10
    && browser.unexpected === 0 && browser.skipped === 0 && browser.flaky === 0 && cleanup === true
    && evidence?.taskCount === 1 && evidence.receiptCount === 1 && evidence.createAuditCount === 1
    && evidence.totalActivityLoggedCount === 2 && evidence.providerWrites === 0
    && Number.isSafeInteger(evidence.atlasRequests) && evidence.atlasRequests > 0
    && ['bodyIsNull', 'genericSubject', 'sourceTextAbsentFromTask', 'sourceTextAbsentFromAudit'].every(key => evidence[key] === true)
    && Object.keys(evidence.privileges ?? {}).length === 3
    && ['crmWebRestricted', 'crmWorkerRestricted', 'atlasRuntimeRestricted'].every(key => evidence.privileges?.[key] === true)
    && evidence.actualScale?.clients === 40 && evidence.actualScale.devices === 400 && evidence.actualScale.employees === 3
    && evidence.ticketWork?.timeCount === 1 && evidence.ticketWork.matchingTimeCount === 1
    && evidence.ticketWork.timeCreateAuditCount === 1 && evidence.ticketWork.receiptCount === 1
    && evidence.ticketWork.taskPreserved === true;
}

export function executionPolicy(options, onReady) {
  const demo = onReady !== undefined;
  if (demo && (typeof onReady !== 'function' || options.skipBuild || options.skipBrowser !== true))
    throw new Error('Interactive demos must build current sources and cannot run the acceptance browser suite.');
  return { demo, diagnostic: Boolean(demo || options.skipBuild || options.skipBrowser) };
}

export async function runComposition(options, { onReady } = {}) {
  const policy = executionPolicy(options, onReady);
  await createStateDirectory(options.directory);
  const inherited = safeEnvironment();
  // Imported Prisma test-harness children also receive this allowlist, never shell/database/provider credentials.
  for (const key of Object.keys(process.env)) if (!(key in inherited)) delete process.env[key];
  const state = { format: FORMAT, kind: 'parasol-local-composition', phase: 'initializing',
    root: ROOT, directory: options.directory, runId: randomBytes(6).toString('hex'), plan: fixturePlan(),
    sqlSaPassword: sqlPassword(), sqlWebPassword: sqlPassword(), sqlWorkerPassword: sqlPassword(), pgPassword: secret(), documentVolumeId: randomUUID(),
    employeeTokens: Object.fromEntries(ROLES.map(role => [role, secret()])) };
  state.sqlDatabase = `crm_e2e_composition_${state.runId}`;
  state.sqlContainer = `parasol-composition-${state.runId}-sql`; state.pgContainer = `parasol-composition-${state.runId}-pg`;
  state.ports = {};
  for (const kind of ['sql', 'pg', 'web', 'worker', 'atlas', 'gateway']) state.ports[kind] = await freePort();
  if (new Set(Object.values(state.ports)).size !== 6) throw new Error('Distinct ephemeral fixture ports were not available.');
  state.pgAdminUrl = `postgresql://postgres:${state.pgPassword}@127.0.0.1:${state.ports.pg}/postgres`;
  state.baseUrl = `https://localhost:${state.ports.web}`; state.atlasUrl = `http://127.0.0.1:${state.ports.atlas}`;
  state.atlasBridgeUrl = `http://127.0.0.1:${state.ports.gateway}`;
  state.sqlConnections = Object.fromEntries([['owner', 'sa', state.sqlSaPassword], ['web', 'composition_web', state.sqlWebPassword],
    ['worker', 'composition_worker', state.sqlWorkerPassword]].map(([kind, login, password]) => [kind, connectionString(state, login, password)]));
  const statePath = join(state.directory, 'private/state.json'); const manifestPath = join(state.directory, 'fixture.json');
  const reportPath = join(state.directory, 'report.json');
  const processes = []; let atlasDatabase; let gateway; let build; let browser; let evidence; let failedStage; let failureCode;
  const controller = new AbortController(); let stopRequested = false; let demoStopReason;
  const abort = () => { stopRequested = true; controller.abort(new Error('Composition run interrupted.')); };
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const watch = host => {
    processes.push(host);
    void host.exited.then(() => { if (!host.stopping) controller.abort(new Error('An owned application exited unexpectedly.')); });
    return host;
  };
  const stage = label => { controller.signal.throwIfAborted(); failedStage = label; console.log(`Composition: ${label}.`); };
  const save = () => jsonFile(statePath, { ...state, adminSession: undefined });
  const web = async enabled => {
    const config = await writeAppConfig(state, 'web', enabled);
    const host = startProcess('dotnet', [join(ROOT, 'apps/crm/src/Hosts/Crm.Web/bin/Release/net10.0/Crm.Web.dll')],
      { cwd: join(ROOT, 'apps/crm/src/Hosts/Crm.Web'), env: appEnvironment(config, state.baseUrl), label: 'CRM Web' });
    watch(host); await waitReady(`${state.baseUrl}/health/ready`, host, 200, 120_000, { ca: state.certificatePublic }); return host;
  };
  let cleanup = false; let success = false;
  try {
    stage('build compiled applications'); build = await buildApplications(state, options.skipBuild, controller.signal);
    stage('create isolated test certificate'); await certificates(state);
    state.certificatePublic = await readFile(state.certificatePublicPath, 'utf8'); await save();
    stage('start owned loopback databases'); await startDatabases(state, { ...options, signal: controller.signal });
    stage('migrate CRM and provision restricted application logins');
    const migrate = await writeAppConfig(state, 'migrate');
    await command('dotnet', [join(ROOT, 'apps/crm/src/Hosts/Crm.Web/bin/Release/net10.0/Crm.Web.dll'), '--migrate-only'],
      { cwd: join(ROOT, 'apps/crm/src/Hosts/Crm.Web'), env: appEnvironment(migrate, state.baseUrl), label: 'CRM database migrations',
        logPath: join(state.directory, 'logs/migrate.log'), secrets: [state.sqlSaPassword], signal: controller.signal });
    await prepareSqlLogins(state);
    stage('migrate Atlas and provision confined runtime role'); atlasDatabase = await prepareAtlasDatabase(state, controller.signal); await save();
    stage('bootstrap three real CRM employee identities and forty customers');
    const initialWeb = await web(false); await bootstrapCrm(state); await initialWeb.stop();
    stage('seed owned saved-ticket provenance'); await seedTicketWork(state); await save();
    stage('seed owned synthetic Atlas database'); await seedAtlas(atlasDatabase.owner, state.employees); await save();
    const atlas = startProcess(process.execPath, [join(ROOT, 'apps/atlas/dist/apps/api/src/main.js')], {
      cwd: join(ROOT, 'apps/atlas'), label: 'Atlas API', bindingLine: `Atlas PostgreSQL API: http://127.0.0.1:${state.ports.atlas}`, env: safeEnvironment({ ATLAS_MODE: 'db', ATLAS_RUNTIME_DATABASE_URL: state.atlasRuntimeUrl,
        ATLAS_API_PORT: String(state.ports.atlas), ATLAS_LISTEN_HOST: '127.0.0.1', ATLAS_ASK_MODE: 'off', ATLAS_OPERATOR_UI: '0', DECISIONS_MODE: 'rules' }) });
    watch(atlas); await waitReady(`${state.atlasUrl}/clients`, atlas, 401);
    gateway = await recordingGateway(state);
    stage('restart CRM with distinct personal source configurations and map verified customers');
    await web(true); await linkCustomers(state); delete state.adminSession;
    stage('start restricted CRM Worker');
    const workerConfig = await writeAppConfig(state, 'worker');
    const worker = startProcess('dotnet', [join(ROOT, 'apps/crm/src/Hosts/Crm.Worker/bin/Release/net10.0/Crm.Worker.dll')], {
      cwd: join(ROOT, 'apps/crm/src/Hosts/Crm.Worker'), env: appEnvironment(workerConfig, `https://localhost:${state.ports.worker}`), label: 'CRM Worker' });
    watch(worker); await waitReady(`https://localhost:${state.ports.worker}/health/ready`, worker, 200, 120_000, { ca: state.certificatePublic });
    const confined = await privileges(state);
    if (!Object.values(confined).every(Boolean)) throw new Error('Restricted application database privileges were not confirmed.');
    const clients = state.plan.clients; const target = { ...state.plan.target, customerId: clients[0].crmCustomerId };
    const manifest = { format: FORMAT, version: FORMAT, runId: state.runId, baseUrl: state.baseUrl, atlasUrl: state.atlasUrl,
      workspaceId: state.plan.workspaceId, collisionWorkspaceId: COLLISION_WORKSPACE,
      employees: state.employees.map(({ id, role, displayName, visibleClientIds }) => ({ id, role, displayName, visibleClientIds })),
      clients, target, restrictedClient: { customerId: clients[20].crmCustomerId, atlasClientId: clients[20].atlasClientId, name: clients[20].name },
      counts: state.plan.counts, privileges: confined, ticketWork: state.ticketWork };
    await jsonFile(manifestPath, manifest);
    state.phase = 'ready'; await save();
    if (policy.demo) {
      stage('serve local synthetic demo');
      demoStopReason = await onReady(manifest, controller.signal);
      if (controller.signal.aborted && !stopRequested) controller.signal.throwIfAborted();
      if (!['timeout', 'interrupted'].includes(demoStopReason)) throw new Error('Invalid local demo stop reason.');
    }
    if (!options.skipBrowser) {
      stage('run real browser composition acceptance');
      await command(process.execPath, [join(ROOT, 'apps/crm/web/node_modules/@playwright/test/cli.js'), 'test', '-c', join(ROOT, 'tools/composition/playwright.config.mjs')], {
        cwd: ROOT, env: safeEnvironment({ PARASOL_COMPOSITION_FIXTURE: manifestPath, PARASOL_COMPOSITION_STATE: statePath }),
        label: 'Composition browser acceptance', logPath: join(state.directory, 'logs/browser.log'), timeout: 960_000, signal: controller.signal });
      const result = JSON.parse(await readFile(join(state.directory, 'browser-artifacts/playwright-results.json'), 'utf8'));
      browser = requireBrowserPass(result, 0);
      stage('verify durable task and privacy evidence'); evidence = await executeControl(statePath, 'countsTaskEvidence');
    }
    failedStage = undefined; success = true;
  } catch (error) { failureCode = failureLabel(error, controller.signal.aborted); }
  finally {
    const errors = [];
    for (const host of processes.reverse()) try { await host.stop(); } catch { errors.push(host.label); }
    try { await gateway?.close(); } catch { errors.push('gateway'); }
    try { await atlasDatabase?.drop(); } catch { errors.push('Atlas database'); }
    for (const name of [state.pgContainer, state.sqlContainer]) try { await removeOwnedContainer(state, name); } catch { errors.push('owned database container'); }
    cleanup = errors.length === 0;
    // Owner credentials, personal tokens, cookies and test DP keys expire with their isolated run.
    if (cleanup) await rm(join(state.directory, 'private'), { recursive: true, force: true });
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
  const diagnostic = policy.diagnostic;
  const report = { format: FORMAT, runId: state.runId, accepted: success && acceptedReport({ build, browser, evidence, cleanup, diagnostic }),
    diagnostic, build, browser, evidence, cleanup, ...(policy.demo ? { demo: { stopReason: demoStopReason } } : {}),
    ...(failedStage ? { failedStage, failureCode } : {}) };
  await jsonFile(reportPath, report);
  console.log(`Composition report: ${reportPath}`);
  if (!report.accepted && !diagnostic || !success || !cleanup) throw new Error(`Composition did not pass${failedStage ? ` at: ${failedStage}` : ''}. See the safe report.`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runComposition(parseArgs(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
