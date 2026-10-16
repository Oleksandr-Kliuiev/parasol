import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DATASET_MANIFEST_SHA256, FIXTURE_IDS, loadFrozenDataset, SEED_MAPPING_SHA256, SYNTHETIC_FRESHNESS_AT } from '../packages/reval/dataset.ts';
import { decodeFixtureCheck, FIXTURE_CHECK_KEYS } from '../packages/reval/payloads.ts';
import { UTC_TYPES } from '../packages/reval/pg-tx.ts';
import { decodeFixtureVerifyRequest, decodeFixtureVerifyResult, decodeChildHello } from '../packages/reval/private-frames.ts';
import { decodeSeedMapping, loadSeedMapping, planKeys, SEED_MAPPING_URL, SeedPlanError, seedPlan } from '../packages/reval/seed-plan.ts';
import { SourceClockRefused, syntheticSourceReference } from '../packages/reval/source-clock.ts';
import { originalRow } from '../scripts/ask-remote-eval/fixtures.ts';

// R-EVAL RS-B pure units (rs-b brief §2): frozen dataset identity, the reviewed seed mapping, deterministic seed plans of all
// eleven fixtures (FX04 refused as unrepresentable), the FX08 overflow sentinel, the source-only clock boundary, and the exact
// FIXTURE_CHECK payload / verifier private frames. No database.
const dataset = loadFrozenDataset();
const mapping = loadSeedMapping();
const plan = (id: string) => seedPlan(dataset, id, mapping.mapping, mapping.sha256);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

test('frozen dataset: manifest/fixture bytes pinned, eleven exact fixture IDs; any tampered byte refuses', () => {
  assert.equal(dataset.manifestSha256, DATASET_MANIFEST_SHA256);
  assert.deepEqual([...dataset.byId.keys()], [...FIXTURE_IDS]);
  const real = (name: string) => readFileSync(new URL(`../docs/stage5/ask/remote/eval/data/${name}`, import.meta.url));
  const tamper = (target: string) => (name: string) => { const b = Buffer.from(real(name)); if (name === target) b[b.length - 2] ^= 1; return b; };
  assert.throws(() => loadFrozenDataset(tamper('DATASET_MANIFEST.json')), /DATASET_MANIFEST/);
  assert.throws(() => loadFrozenDataset(tamper('fixtures.json')), /DATASET_FIXTURES/);
});

test('seed mapping: pinned sha256, strict closed decoder (extra/missing/duplicate keys, wrong literals)', () => {
  const bytes = readFileSync(SEED_MAPPING_URL);
  assert.equal(sha(bytes), SEED_MAPPING_SHA256);
  assert.equal(mapping.sha256, SEED_MAPPING_SHA256);
  assert.throws(() => loadSeedMapping(() => Buffer.concat([bytes, Buffer.from(' ')])), /SEED_PLAN_MAPPING_HASH/);
  const base = JSON.parse(bytes.toString('utf8'));
  const variants: [string, (m: any) => void][] = [
    ['extra key', m => { m.extra = 1; }], ['missing key', m => { delete m.entityLink; }], ['connection not FIXTURE', m => { m.connection.status = 'ACTIVE'; }],
    ['dataset digest', m => { m.datasetManifestSha256 = 'a'.repeat(64); }], ['sentinel not INFO', m => { m.overflowSentinel.severity = 'LOW'; }],
    ['itemCount', m => { m.resourceSnapshot.itemCountTruncated = 0; }], ['error code', m => { m.syncState.safeErrorCode = 'lower'; }],
    ['recorded > attempt', m => { m.syncState.recordedSeq = 5; }], ['attributes not empty', m => { m.externalEntity.attributes = { a: 1 }; }],
  ];
  for (const [name, change] of variants) { const m = structuredClone(base); change(m); assert.throws(() => decodeSeedMapping(m), /REVAL_SHAPE/, name); }
  assert.doesNotThrow(() => decodeSeedMapping(structuredClone(base)));
});

test('seed plans: deterministic, every row in the registered scope, exact declared projections (all eleven, FX04 via its exception)', () => {
  for (const id of FIXTURE_IDS) {
    const a = plan(id); const b = plan(id);
    assert.equal(JSON.stringify(a), JSON.stringify(b), `${id} deterministic`);
    for (const rows of Object.values(a.rows)) for (const r of rows) {
      assert.equal(r.workspaceId, 'syn-ws-reval'); assert.equal(r.clientId, 'syn-client-reval');
    }
    const spec = dataset.byId.get(id)!;
    // Every declared observation materializes its original row exactly (projected fields untouched).
    for (const o of a.rows.Observation.filter(x => x.id !== mapping.mapping.overflowSentinel.id)) {
      const decl = [...(spec.page ?? []), ...(spec.focus.offPage ? [spec.focus.offPage] : [])].find(x => x.id === o.id);
      const series = (spec.pageSeries ?? []).some(s => (o.id as string).startsWith(s.prefix));
      assert.ok(decl || series, `${id} ${String(o.id)} declared`);
      const raw = a.rows.RawEvent.find(r => r.id === o.eventId)!;
      assert.deepEqual(raw.normalized, { kind: originalRow({ id: o.id as string, source: raw.connectionId === 'syn-huntress-1' ? 'huntress' : 'atera', severity: o.severity as string }, dataset.file.scope).kind,
        summary: `SYNTH-SOURCE-MARKER summary of ${String(o.id)}` });
    }
    // MISSING = no SyncState; ERROR = no snapshot; OK/STALE = OK + snapshot with literal times; truncated ⇒ itemCount 1.
    for (const c of spec.connections) for (const [type, st] of Object.entries(c.states)) {
      const s = a.rows.SyncState.find(x => x.connectionId === c.id && x.resourceType === type);
      const n = a.rows.ResourceSnapshot.find(x => x.connectionId === c.id && x.resourceType === type);
      if (st.status === 'ERROR') { assert.equal(s?.status, 'ERROR'); assert.equal(n, undefined); assert.equal(s?.lastSuccessAt, st.lastSuccessAt); }
      else { assert.equal(s?.status, 'OK'); assert.equal(n?.asOf, st.asOf); assert.equal(n?.truncated, st.truncated); assert.equal(n?.itemCount, st.truncated ? 1 : 0); }
    }
  }
});

test('FX08: exactly one INFO overflow sentinel beyond the 100 declared rows, last in reader order, never a focus or expectation', () => {
  const p = plan('FX08'); const spec = dataset.byId.get('FX08')!;
  assert.equal(p.rows.Observation.length, 101);
  const rank: Record<string, number> = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
  const ordered = [...p.rows.Observation].sort((x, y) => rank[y.severity as string]! - rank[x.severity as string]!
    || String(y.createdAt).localeCompare(String(x.createdAt)) || String(x.id).localeCompare(String(y.id)));
  assert.equal(ordered[100]!.id, 'syn-obs-t101-overflow');
  assert.ok(!JSON.stringify(spec.expected).includes('syn-obs-t101-overflow'));
  for (const id of FIXTURE_IDS.filter(x => x !== 'FX08')) assert.ok(!plan(id).rows.Observation.some(o => o.id === 'syn-obs-t101-overflow'), id);
});

test('links keep declared order (first CONFIRMED wins); planKeys canonical', () => {
  const p = plan('FX02');
  assert.deepEqual(p.rows.EntityLink.map(l => [l.id, l.status]), [['syn-link-001', 'CONFIRMED'], ['syn-link-002', 'CONFIRMED']]);
  const keys = planKeys(p);
  assert.deepEqual(keys.Connection, ['syn-atera-1', 'syn-huntress-1']);
  assert.ok(keys.SyncState.every(k => k.split('\u0000').length === 2));
});

test('rc2 B1: the owner-approved FX04 exception stores ONLY that excluded candidate link as contact↔PERSON; exact match or refusal', () => {
  const p = plan('FX04');
  assert.deepEqual(p.rows.EntityLink.map(l => [l.status, l.resourceType, l.entityKind]), [['CANDIDATE', 'contact', 'PERSON']]);
  assert.deepEqual(p.rows.ExternalEntity.map(x => [x.resourceType, x.externalId, x.connectionId]), [['contact', 'syn-h-agent-0009', 'syn-huntress-1']]);
  // The frozen declaration is unchanged (the reader never selects a CANDIDATE link; no expectation mentions it).
  assert.equal(dataset.byId.get('FX04')!.readerExcludedLinks[0]!.resourceType, 'agent');
  // A declaration that does not EXACTLY match the exception stays unrepresentable.
  const variant = (change: (l: any) => void) => {
    const file = structuredClone(dataset.file); change(file.fixtures.find(f => f.fixtureId === 'FX04')!.readerExcludedLinks[0]);
    return { ...dataset, file, byId: new Map(file.fixtures.map(f => [f.fixtureId as never, f])) };
  };
  assert.throws(() => seedPlan(variant(l => { l.externalId = 'syn-h-agent-0010'; }), 'FX04', mapping.mapping, mapping.sha256), /SEED_PLAN_LINK_TYPE_INCOMPATIBLE/);
  assert.throws(() => seedPlan(variant(l => { l.status = 'REJECTED'; }), 'FX04', mapping.mapping, mapping.sha256), /SEED_PLAN_LINK/);
  // An exception whose declaration no longer matches is a mapping error, never silently ignored.
  const base = JSON.parse(readFileSync(SEED_MAPPING_URL, 'utf8'));
  const stale = structuredClone(base); stale.schemaExceptions[0].index = 1;
  assert.throws(() => seedPlan(dataset, 'FX04', decodeSeedMapping(stale), mapping.sha256), /SEED_PLAN_(LINK_TYPE_INCOMPATIBLE|SCHEMA_EXCEPTION_UNUSED)/);
  // Decoder: only CANDIDATE, only an incompatible declaration, only into the compatible type, owner approval marker required.
  for (const [name, change] of [['confirmed', (e: any) => { e.declared.status = 'CONFIRMED'; }], ['already compatible', (e: any) => { e.declared.resourceType = 'contact'; }],
    ['wrong target', (e: any) => { e.materializedResourceType = 'agent'; }], ['no approval', (e: any) => { e.approval = 'self'; }],
    ['other list', (e: any) => { e.list = 'links'; }], ['extra key', (e: any) => { e.note = 'x'; }]] as const) {
    const m = structuredClone(base); change(m.schemaExceptions[0]); assert.throws(() => decodeSeedMapping(m), /REVAL_SHAPE/, name);
  }
});

test('source-only clock: the pinned reference is released only for the frozen dataset/reference, a frozen fixture and a positive generation', () => {
  const ok = { fixtureId: 'FX01', generation: '1', syntheticFreshnessAt: SYNTHETIC_FRESHNESS_AT, datasetManifestSha256: DATASET_MANIFEST_SHA256 };
  assert.equal(syntheticSourceReference(ok).toISOString(), '2026-10-10T07:30:00.000Z');
  for (const bad of [{ fixtureId: 'FX12' }, { generation: '0' }, { generation: '01' }, { syntheticFreshnessAt: '2026-10-10T07:30:00.001Z' },
    { datasetManifestSha256: 'b'.repeat(64) }]) assert.throws(() => syntheticSourceReference({ ...ok, ...bad }), SourceClockRefused);
});

test('FIXTURE_CHECK payload: exact keys in 03 order, strict booleans, sourceMode db, realTimeFreshnessClaim false only', () => {
  const p = { fixtureId: 'FX03', fixtureGeneration: '7', datasetManifestSha256: DATASET_MANIFEST_SHA256, seedMappingSha256: SEED_MAPPING_SHA256,
    syntheticFreshnessAt: SYNTHETIC_FRESHNESS_AT, sourceMode: 'db', rowIdentity: true, sourceProjection: true, expectedFacts: false, allFiveIntents: true,
    financeUnchanged: true, realTimeFreshnessClaim: false };
  assert.deepEqual(Object.keys(p), [...FIXTURE_CHECK_KEYS]);
  assert.doesNotThrow(() => decodeFixtureCheck(p));
  for (const bad of [{ realTimeFreshnessClaim: true }, { sourceMode: 'fixture' }, { rowIdentity: 'true' }, { fixtureGeneration: '0' }, { fixtureId: 'FX12' },
    { syntheticFreshnessAt: '2026-10-10T07:30:00Z' }, { extra: 1 }]) assert.throws(() => decodeFixtureCheck({ ...p, ...bad }), /REVAL_SHAPE/, JSON.stringify(bad));
  const { financeUnchanged: _, ...missing } = p;
  assert.throws(() => decodeFixtureCheck(missing), /REVAL_SHAPE/);
});

test('verifier private frames: VERIFIER hello; closed request/result; CHECKED booleans vs REFUSED code are exclusive', () => {
  assert.equal(decodeChildHello({ contractVersion: 'RevalChildHelloV1', kind: 'VERIFIER', helloNonce: randomUUID() }).kind, 'VERIFIER');
  const req = { contractVersion: 'RevalFixtureVerifyRequestV1', helloNonce: randomUUID(), challenge: randomUUID(), remainingMs: 900, registrationId: randomUUID(),
    databaseInstanceId: randomUUID(), workspaceId: 'syn-ws-reval', clientId: 'syn-client-reval', actorId: 'syn-actor', admissionId: randomUUID(), fixtureId: 'FX02',
    fixtureGeneration: '3', endpoint: { socketDir: '/sock', port: 5432, database: 'atlas' }, runtimeRole: 'atlas_app', runtimeSecretFile: '/s/runtime',
    physical: { systemIdentifier: '7', databaseOid: '16384', postmasterStartTime: '1700000000', postmasterPid: '42', dataDirectory: '/data', socketDevice: '1', socketInode: '2' } };
  assert.doesNotThrow(() => decodeFixtureVerifyRequest(req));
  for (const bad of [{ remainingMs: 1401 }, { fixtureId: 'FX00' }, { fixtureGeneration: '0' }, { runtimeSecretFile: 'rel' }, { password: 'x' }]) {
    assert.throws(() => decodeFixtureVerifyRequest({ ...req, ...bad }), /REVAL_SHAPE/, JSON.stringify(bad));
  }
  const ok = { contractVersion: 'RevalFixtureVerifyResultV1', challenge: randomUUID(), outcome: 'CHECKED', rowIdentity: true, sourceProjection: false,
    expectedFacts: true, allFiveIntents: true, code: null };
  assert.doesNotThrow(() => decodeFixtureVerifyResult(ok));
  assert.doesNotThrow(() => decodeFixtureVerifyResult({ ...ok, outcome: 'REFUSED', rowIdentity: null, sourceProjection: null, expectedFacts: null,
    allFiveIntents: null, code: 'UNAUTHORIZED' }));
  for (const bad of [{ code: 'UNAUTHORIZED' }, { rowIdentity: null }, { outcome: 'REFUSED' }, { outcome: 'OK' }]) {
    assert.throws(() => decodeFixtureVerifyResult({ ...ok, ...bad }), /REVAL_SHAPE/, JSON.stringify(bad));
  }
});

test('UTC decoding of timestamp without time zone (Prisma raw semantics), other types unchanged', () => {
  const parse = UTC_TYPES.getTypeParser(1114, 'text') as (v: string) => Date;
  assert.equal(parse('2026-10-10 07:00:00').toISOString(), '2026-10-10T07:00:00.000Z');
  assert.equal(parse('2026-10-10 07:00:00.123').toISOString(), '2026-10-10T07:00:00.123Z');
  assert.equal((UTC_TYPES.getTypeParser(20, 'text') as (v: string) => unknown)('9007199254740993'), '9007199254740993', 'int8 stays a string');
});

test('static: maintenance/verifier code has no TRUNCATE, DDL, trigger/RLS/role bypass; production deps are unix-socket only; frozen and ordinary Ask bytes unchanged', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const root = new URL('../', import.meta.url);
  const read = (p: string) => readFile(new URL(p, root), 'utf8');
  for (const f of ['inventory', 'materialize', 'register', 'maintain-cli', 'maintain-deps', 'fixture-verify', 'verifier-exec', 'fixture-check', 'seed-plan', 'pg-tx']) {
    const code = (await read(`packages/reval/${f}.ts`)).replace(/^\s*(\*|\/\/).*$/gm, '');
    for (const forbidden of [/\bTRUNCATE\b/, /\bALTER\s+(TABLE|ROLE|FUNCTION)\b/i, /DISABLE\s+TRIGGER/i, /session_replication_role/, /\bSET\s+(LOCAL\s+)?ROLE\b/i,
      /NO FORCE/i, /\bDROP\s/i, /"legacyClosure"\s*=\s*true/, /row_security/i, /\bGRANT\b/, /\bREVOKE\b/]) {
      assert.ok(!forbidden.test(code), `${f}.ts matches ${forbidden}`);
    }
  }
  const deps = (await read('packages/reval/maintain-deps.ts')).replace(/^\s*(\*|\/\/).*$/gm, '');
  assert.deepEqual([...deps.matchAll(/host: ([^,;}]+)/g)].map(m => m[1]!.trim()), ['socketDir'], 'probe connects to the socket directory only');
  assert.ok(deps.includes('verifyPhysicalEndpoint('), 'both owner connections use the unix physical binding');
  const verifierEntry = await read('scripts/reval-server/fixture-verifier.ts');
  assert.ok(verifierEntry.includes('productionVerifierConnect(physical)') && !/host:/.test(verifierEntry));
  // Baseline bytes (verification/stage5/S5ASKREMOTE_REVAL_RSB_BASELINE.sha256): ordinary Ask code, offline/execution packages, frozen data.
  const baseline = new Map((await read('verification/stage5/S5ASKREMOTE_REVAL_RSB_BASELINE.sha256')).trim().split('\n').map(l => {
    const [hash, ...p] = l.split(/\s+/); return [p.join(' '), hash!] as const; }));
  const walk = async (rel: string): Promise<string[]> => (await readdir(new URL(rel, root), { withFileTypes: true }))
    .flatMap(e => e.isDirectory() ? [] : [`${rel}${e.name}`]).concat(...await Promise.all((await readdir(new URL(rel, root), { withFileTypes: true }))
      .filter(e => e.isDirectory()).map(e => walk(`${rel}${e.name}/`))));
  const files = [...await walk('packages/ask/'), ...await walk('scripts/ask-remote-eval/'), ...await walk('scripts/ask-remote-eval-execution/'),
    ...await walk('docs/stage5/ask/remote/eval/data/'), ...await walk('docs/stage5/ask/remote/reval-server/').then(x => x.filter(p => /\/0[1-6]_[A-Z_]+\.md$/.test(p)))];
  assert.ok(files.length > 60, String(files.length));
  // RS-C-A changes exactly its enumerated Ask hook files (rs-c brief §4; RC5 guard test pins their old hashes); the new
  // packages/ask/remote/evaluation.ts is the hook interface. Everything else stays byte-identical to the RS-B baseline.
  const rsca = new Set(['packages/ask/budget.ts', 'packages/ask/remote/db.ts', 'packages/ask/remote/service.ts', 'packages/ask/remote/evaluation.ts']);
  for (const f of files) if (!rsca.has(f)) assert.equal(sha(await readFile(new URL(f, root))), baseline.get(f), `${f} unchanged since the RS-B baseline`);
});
