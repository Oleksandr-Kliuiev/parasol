// Automatic sync for the deployment (docs/deploy/DEPLOY.md): runs the accepted operator CLI (scripts/ops.ts) on a schedule as the
// dedicated scheduler actor (ATLAS_OPERATOR_TOKEN; its own per-client permissions), one job at a time, each bounded by a timeout.
// It adds no data path of its own: every read goes through the same commands, permissions, audit and RLS as a manual run.
//
// ATLAS_SYNC_JOBS — `;`-separated `kind:client[:connection]@interval` (interval: <n>m or <n>h, at least 1m):
//   live-read:C:N@15m      Atera/Huntress: activation if needed, health and one bounded sync (GET only)
//   m365-directory:C:N@6h  Microsoft 365 users, then devices (one directory attempt each)
//   m365-signins:C:N@1h    Microsoft 365 sign-ins: a new request for the closed hours since the last run (lag 1 h, ≤ 24 h)
//   worker@5m              one event-worker pass over the clients the scheduler may ingest for
// Prints one JSON line per run: job, exit code, duration and the command's own safe summary fields. Never a token or secret.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

type Kind = 'live-read' | 'm365-directory' | 'm365-signins' | 'worker';
interface Job { readonly kind: Kind; readonly client?: string; readonly connection?: string; readonly everyMs: number; due: number; signinsFrom?: number }

const OPS = fileURLToPath(new URL('./ops.ts', import.meta.url));
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HOUR = 3_600_000;
const TIMEOUT_MS = Number(process.env.ATLAS_SYNC_TIMEOUT_MS ?? 600_000);
const SUMMARY_KEYS = new Set(['command', 'status', 'outcome', 'connectionStatus', 'resourceType', 'rowCount', 'itemCount', 'safeErrorCode', 'retryAfterSeconds',
  'retryAt', 'errorKind', 'processed', 'requestId', 'mode', 'signIns']);

export function parseJobs(spec: string | undefined, now: number): Job[] {
  if (!spec || spec.trim() === '') throw new Error('ATLAS_SYNC_JOBS is required');
  return spec.split(';').map(s => s.trim()).filter(Boolean).map(entry => {
    const m = /^(live-read|m365-directory|m365-signins|worker)(?::([a-z0-9-]+))?(?::([a-z0-9-]+))?@([1-9][0-9]{0,3})([mh])$/.exec(entry);
    if (!m) throw new Error(`ATLAS_SYNC_JOBS: malformed entry ${entry}`);
    const kind = m[1] as Kind; const client = m[2]; const connection = m[3];
    if (kind === 'worker' ? client !== undefined : !(client && connection && ID.test(client) && ID.test(connection))) throw new Error(`ATLAS_SYNC_JOBS: ${entry} has the wrong arguments`);
    return { kind, client, connection, everyMs: Number(m[4]) * (m[5] === 'h' ? HOUR : 60_000), due: now };
  });
}

/** The closed-hour sign-in interval for this run: from the last run's end (else 3 h back), to the hour before the current one. */
export function signinWindow(job: Job, now: number): { from: number; to: number } | null {
  const to = Math.floor(now / HOUR) * HOUR - HOUR;
  const from = Math.max(job.signinsFrom ?? to - 2 * HOUR, to - 24 * HOUR);
  return to > from ? { from, to } : null;
}

export function commandsFor(job: Job, now: number): string[][] {
  const c = ['--client', job.client!, '--connection', job.connection!];
  switch (job.kind) {
    case 'live-read': return [['live-read', ...c]];
    case 'm365-directory': return [['m365-sync', ...c, '--resource', 'users'], ['m365-sync', ...c, '--resource', 'devices']];
    case 'm365-signins': {
      const w = signinWindow(job, now);
      return w ? [['m365-sync', ...c, '--resource', 'signins', '--from', new Date(w.from).toISOString(), '--to', new Date(w.to).toISOString()]] : [];
    }
    case 'worker': return [['worker-once']];
  }
}

function run(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', OPS, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let out = '';
    child.stdout.on('data', b => { if (out.length < 1_000_000) out += String(b); });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('close', code => { clearTimeout(timer); resolve({ code, out }); });
  });
}
function summary(out: string): Record<string, unknown> {
  try {
    const o = JSON.parse(out) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(o).filter(([k, v]) => SUMMARY_KEYS.has(k) && (typeof v !== 'object' || v === null || k === 'signIns')));
  } catch { return { unparsed: true }; }
}

async function main(): Promise<void> {
  const jobs = parseJobs(process.env.ATLAS_SYNC_JOBS, Date.now());
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { stopping = true; });
  console.log(JSON.stringify({ at: new Date().toISOString(), scheduler: 'started', jobs: jobs.map(j => `${j.kind}:${j.client ?? ''}:${j.connection ?? ''}@${j.everyMs / 60_000}m`) }));
  while (!stopping) {
    const now = Date.now();
    const job = jobs.filter(j => j.due <= now).sort((a, b) => a.due - b.due)[0];
    if (!job) { await new Promise(r => setTimeout(r, 5_000)); continue; }
    job.due = now + job.everyMs;
    for (const args of commandsFor(job, now)) {
      const started = Date.now();
      const { code, out } = await run(args);
      console.log(JSON.stringify({ at: new Date().toISOString(), job: job.kind, client: job.client ?? null, connection: job.connection ?? null, args: args[0],
        resource: args.includes('--resource') ? args[args.indexOf('--resource') + 1] : null, exit: code, ms: Date.now() - started, ...summary(out) }));
      if (job.kind === 'm365-signins' && code === 0) job.signinsFrom = signinWindow(job, now)!.to;
      if (stopping) break;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
