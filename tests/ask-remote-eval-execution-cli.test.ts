import '../scripts/ask-remote-eval/guard-preload.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContext } from '../scripts/ask-remote-eval-execution/corpus.ts';

// Execution instrument CLI processes and static boundaries: no live/paid mode, TTY-only operator session, guard first,
// no network/child/worker/environment surface in the tool, reproducible committed rehearsal receipt.

const cli = (args: string[], input?: string) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings',
  'scripts/ask-remote-eval-execution/cli.ts', ...args], { encoding: 'utf8', input, env: { PATH: process.env.PATH ?? '' }, timeout: 120_000 });
const DIR = new URL('../scripts/ask-remote-eval-execution/', import.meta.url);
const sources = readdirSync(DIR).filter(n => n.endsWith('.ts')).map(n => [n, readFileSync(new URL(n, DIR), 'utf8')] as const);
const ctx = loadContext();

test('usage: there is no live/paid mode; unknown commands and flags exit 2', () => {
  for (const args of [[], ['--live'], ['rehearse', '--live'], ['session'], ['session', '--receipt-dir'], ['artifact-check', '--write-receipt'], ['run', '--paid']]) {
    const r = cli(args);
    assert.equal(r.status, 2, args.join(' ')); assert.match(r.stderr, /^USAGE: /); assert.equal(r.stdout, '');
  }
  assert.equal(cli(['help']).status, 0);
});

test('operator session refuses a non-interactive stdin: a piped script cannot consent or submit', () => {
  const r = cli(['session', '--receipt-dir', '/tmp'], 'admission\nconfirm x 1\nconsent\nsubmit RE-SUM-001\n');
  assert.equal(r.status, 2); assert.equal(r.stderr, 'SESSION_REQUIRES_INTERACTIVE_TTY\n'); assert.equal(r.stdout, '');
});

test('artifact-check: identity verified for local use; live admission BLOCKED with named blockers', () => {
  const r = cli(['artifact-check']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as Record<string, any>;
  assert.equal(out.ok, true); assert.equal(out.localUseReady, true); assert.equal(out.liveAdmissionReadiness, 'BLOCKED'); assert.equal(out.liveAcceptanceEligible, false);
  assert.ok(out.admissionBlockers.includes('HUMAN_LABEL_ATTESTATION_PENDING'));
  assert.deepEqual(out.drift, []);
});

test('rehearse: all scenarios pass, replay deterministic, output safe and equal to the committed receipt', () => {
  const r = cli(['rehearse']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as Record<string, any>;
  assert.equal(out.ok, true); assert.equal(out.replay, 'DETERMINISTIC_REHEARSAL_REPLAY_VERIFIED'); assert.equal(out.receiptScan, 'CLEAN');
  assert.equal(out.scenarios.pass, out.scenarios.total); assert.equal(out.semanticEvaluation, false); assert.equal(out.liveAcceptanceEligible, false);
  for (const c of ctx.cases) assert.ok(!r.stdout.includes(JSON.stringify(c.question).slice(1, 41)), c.caseId);
  const committed = readFileSync(new URL('../docs/stage5/ask/remote/execution/rehearsal/EXECUTION_REHEARSAL_RECEIPT.json', import.meta.url), 'utf8');
  assert.equal(r.stdout, committed);
});

test('replay --receipt: a saved receipt is schema-checked and its numeric evidence replayed; tampering fails closed', () => {
  const full = (JSON.parse(readFileSync(new URL('../docs/stage5/ask/remote/execution/rehearsal/EXECUTION_REHEARSAL_RECEIPT.json', import.meta.url), 'utf8')) as Record<string, any>).fullRunReceipt;
  const dir = mkdtempSync(join(tmpdir(), 'reval-replay-'));
  try {
    writeFileSync(join(dir, 'ok.json'), JSON.stringify(full));
    const ok = cli(['replay', '--receipt', join(dir, 'ok.json')]);
    assert.equal(ok.status, 0, ok.stdout);
    assert.deepEqual(JSON.parse(ok.stdout), { command: 'replay', ok: true, schema: 'VALID', numeric: 'VERIFIED_SAVED_ARITHMETIC', failed: [], livePerCase: 'SEE_REHEARSAL_REPLAY' });
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ ...full, liability: { ...full.liability, confirmedChargedMicro: 1 } }));
    const bad = cli(['replay', '--receipt', join(dir, 'bad.json')]);
    assert.equal(bad.status, 1); assert.equal(JSON.parse(bad.stdout).numeric, 'MISMATCH');
    writeFileSync(join(dir, 'unsafe.json'), JSON.stringify({ ...full, note: 'x' }));
    assert.equal(cli(['replay', '--receipt', join(dir, 'unsafe.json')]).stdout, '{"command":"replay","ok":false,"schema":"RECEIPT_UNREADABLE_OR_UNSAFE"}\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('static boundary: guard installed first, no network/child/worker/env/eval surface, files within the context budget', () => {
  const cliSource = sources.find(([n]) => n === 'cli.ts')![1];
  const staticImports = cliSource.split('\n').filter(l => /^import /.test(l));
  assert.deepEqual(staticImports, ["import { installNetworkGuard } from '../ask-remote-eval/net-guard.ts';"]);
  assert.ok(cliSource.indexOf('installNetworkGuard();') < cliSource.indexOf('await import('));
  const forbidden = /from 'node:(child_process|worker_threads|cluster|http|https|http2|net|tls|dgram|dns)'|\bfetch\(|process\.env|\beval\(|new Function\(|\bspawn|\bexec(Sync|File)?\(/;
  for (const [name, text] of sources) {
    assert.ok(!forbidden.test(text), name);
    assert.ok(text.split('\n').length <= 500, `${name} exceeds 500 lines`);
    assert.ok(!/from '\.\.\/ask-remote-eval\/(rehearsal|scenarios|provider-stub|commands|cli)\.ts'/.test(text), `${name} must not import offline simulation/CLI modules`);
  }
  const operator = sources.find(([n]) => n === 'operator.ts')![1];
  assert.ok(!/rehearsal|fake-v2/.test(operator.split('\n').filter(l => l.startsWith('import')).join('\n')), 'operator session never loads the fake');
});
