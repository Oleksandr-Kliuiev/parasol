import { isAbsolute, resolve } from 'node:path';

const roles = ['Crm.Admin', 'Crm.Technician', 'Crm.ServiceLead'];
const guid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function parseDemoArgs(argv) {
  const options = { minutes: 30 }; const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]; const value = argv[++index];
    if (!['--directory', '--minutes'].includes(flag) || !value || seen.has(flag))
      throw new Error('Use --directory <new absolute path> and optional --minutes <1..120>.');
    seen.add(flag);
    if (flag === '--directory') options.directory = value;
    else {
      if (!/^[1-9]\d*$/.test(value) || Number(value) > 120) throw new Error('Demo duration must be 1..120 whole minutes.');
      options.minutes = Number(value);
    }
  }
  if (!options.directory || !isAbsolute(options.directory) || resolve(options.directory) !== options.directory)
    throw new Error('A new normalized absolute demo directory is required.');
  return options;
}

/** Explicit public fields only: the composition's private state and personal tokens never reach the demo guide. */
export function demoDescriptor(fixture, minutes, now = Date.now()) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120 || !Number.isFinite(now)) throw new Error('Invalid demo duration.');
  const base = new URL(fixture.baseUrl);
  if (base.protocol !== 'https:' || base.hostname !== 'localhost' || !base.port || base.username || base.password
    || base.pathname !== '/' || base.search || base.hash) throw new Error('Demo must use the owned localhost HTTPS app.');
  if (!/^[a-f0-9]{12}$/.test(fixture.runId) || !guid.test(fixture.target?.customerId ?? '')
    || fixture.counts?.clients !== 40 || fixture.counts?.devices !== 400 || fixture.counts?.employees !== 3
    || fixture.employees?.length !== 3 || roles.some(role => fixture.employees.filter(e => e.role === role).length !== 1)
    || ['crmWebRestricted', 'crmWorkerRestricted', 'atlasRuntimeRestricted'].some(key => fixture.privileges?.[key] !== true))
    throw new Error('Demo requires the complete synthetic fixture and restricted runtime roles.');
  return {
    format: 1, kind: 'parasol-local-demo', runId: fixture.runId, status: 'ready',
    baseUrl: base.origin, startedAt: new Date(now).toISOString(), expiresAt: new Date(now + minutes * 60_000).toISOString(), minutes,
    logins: roles.map(role => ({ role, url: `${base.origin}/bff/dev-login?${new URLSearchParams({ role, returnUrl: '/' })}` })),
    customer: { name: 'Synthetic Client 01 AS', url: `${base.origin}/organizations/${fixture.target.customerId}` },
    scale: { clients: 40, devices: 400, employees: 3 }, workingProvidersConnected: false,
    temporaryLocalCertificate: true, restrictedRuntimes: true,
  };
}

/** A bounded wait with no polling, retained timer or abort listener after either exit path. */
export function waitForDemoStop(signal, milliseconds) {
  if (!Number.isInteger(milliseconds) || milliseconds < 1 || milliseconds > 120 * 60_000)
    throw new Error('Invalid bounded demo wait.');
  if (signal.aborted) return Promise.resolve('interrupted');
  return new Promise(resolve => {
    const finish = reason => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(reason); };
    const abort = () => finish('interrupted');
    const timer = setTimeout(() => finish('timeout'), milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}
