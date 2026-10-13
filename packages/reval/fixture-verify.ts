import { randomUUID } from 'node:crypto';
import { AskFailure } from '../ask/contracts.ts';
import { AskPhase, phaseSql } from '../ask/phase.ts';
import { assertConfinedRuntimeRole, RUNTIME_ROLE_CHECK_SQL } from '../graph/runtime-role.ts';
import type { RuntimeRoleFacts } from '../graph/runtime-role.ts';
import { project } from '../ask/projection.ts';
import type { AskProjection } from '../ask/projection.ts';
import { readDbSource } from '../ask/read.ts';
import { remoteAnswer } from '../ask/remote/answer.ts';
import type { AskSourceRead } from '../ask/source.ts';
import { INTENTS } from '../../scripts/ask-remote-eval/dataset.ts';
import { expectedFactData } from '../../scripts/ask-remote-eval/expected-facts.ts';
import { buildSource } from '../../scripts/ask-remote-eval/fixtures.ts';
import type { FixtureSpec } from '../../scripts/ask-remote-eval/fixtures.ts';
import { checkAnswer, identity } from '../../scripts/ask-remote-eval/predicates.ts';
import type { FailureCode } from './codes.ts';
import { DATASET_MANIFEST_SHA256, loadFrozenDataset } from './dataset.ts';
import type { FrozenDataset } from './dataset.ts';
import { sameKeys, scopedKeys, setScope } from './inventory.ts';
import { sqlStateOf } from './physical.ts';
import type { QueryClient } from './physical.ts';
import { rawTransaction } from './pg-tx.ts';
import { loadSeedMapping, planKeys, seedPlan } from './seed-plan.ts';
import { syntheticSourceReference } from './source-clock.ts';

/**
 * DB = fixture proof inside the verifier V (03 "DB equals fixture proof", rs-b brief B8). One READ ONLY REPEATABLE READ
 * transaction under the confined runtime role, NO bearer/token/credential digest: registration + binding equality,
 * current ACTIVE actor with ONE membership of the registered client holding context:read AND ask:remote, then the ACCEPTED
 * phase1 source SQL/validators (`readDbSource`, through the accepted `phaseSql` runner) with the pinned reference as the
 * resource-age `now`, the accepted projection, and every five-intent answer of the accepted local compiler. Each is compared
 * INDEPENDENTLY with the frozen raw declaration (`buildSource` through the accepted validators), the hand-declared
 * expectation, `expectedFactData` and the offline `checkAnswer` comparator — never with a second copy of production output.
 * Raw facts, banks and answers stay inside this function; only booleans or one fixed code leave it. No write, Ask
 * orchestration, reservation, dispatch, publication or audit can happen here.
 */
export interface VerifyRequest {
  readonly registrationId: string; readonly databaseInstanceId: string; readonly workspaceId: string; readonly clientId: string;
  readonly actorId: string; readonly admissionId: string; readonly fixtureId: string; readonly fixtureGeneration: string;
}
export type VerifyOutcome =
  | { readonly kind: 'CHECKED'; readonly rowIdentity: boolean; readonly sourceProjection: boolean; readonly expectedFacts: boolean; readonly allFiveIntents: boolean }
  | { readonly kind: 'REFUSED'; readonly code: FailureCode };
class Refused extends Error { readonly code: FailureCode; constructor(code: FailureCode) { super(code); this.code = code; } }
const refused = (code: FailureCode): never => { throw new Refused(code); };
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const canonical = (s: AskSourceRead): string => JSON.stringify({ mode: s.mode, page: s.page, pageTruncated: s.pageTruncated, focus: s.focus,
  entities: [...s.entities.entries()], links: s.links, resources: s.resources });

/** Bank identities, every displayed fact value, resource statuses, entity, all-bank urgency and coverage vs the declaration. */
export function bankMatches(projection: AskProjection, spec: FixtureSpec, scope: { workspaceId: string; clientId: string }): boolean {
  const facts = expectedFactData(spec, scope);
  const ids = projection.bank.map(f => identity(f));
  if (!same(ids, spec.expected.bank) || !same(projection.coverage, spec.expected.coverage)) return false;
  for (const f of projection.bank) {
    const id = identity(f)!;
    if ((id.startsWith('O:') || id.startsWith('R:')) && !same(f.data, facts.get(id))) return false;
    if (id.startsWith('R:') && (f.data as { status: string }).status !== spec.expected.resourceStatus[id]) return false;
    if (id.startsWith('N:') && !same(f.data, spec.expected.entity)) return false;
  }
  if ((spec.expected.entity === null) !== !ids.some(id => id?.startsWith('N:'))) return false;
  const urgent = projection.bank.filter(f => f.kind === 'OBSERVATION' && (f.data.severity === 'HIGH' || f.data.severity === 'CRITICAL')).map(f => identity(f));
  return same(urgent, spec.expected.urgent);
}
/** Every one of the five observable intents through the accepted local compiler, judged by the independent predicates. */
export function allIntentsPass(projection: AskProjection, spec: FixtureSpec, scope: { workspaceId: string; clientId: string }): boolean {
  const facts = expectedFactData(spec, scope);
  return INTENTS.every(intent => {
    const frame = { requestId: randomUUID(), correlationId: randomUUID(), workspaceId: scope.workspaceId, clientId: scope.clientId, sourceMode: 'db' as const,
      focusObservationId: spec.requestedFocus, generatedAt: new Date().toISOString() };
    const { json } = remoteAnswer(intent, frame, projection, spec.requestedFocus);
    return checkAnswer(JSON.parse(json), spec.expected, intent, spec.requestedFocus, scope, facts).pass;
  });
}

const BINDING_SQL = `SELECT b."fixtureId" AS f, b.generation::text AS g, b."datasetManifestSha256" AS ds,
  pg_catalog.to_char(b."syntheticFreshnessAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ref
  FROM public."RevalFixtureBinding" b WHERE b."registrationId" = $1::uuid AND b."workspaceId" = $2 AND b."clientId" = $3`;
const REGISTRATION_SQL = `SELECT r."databaseInstanceId"::text AS dbi, r."actorId" AS ac, r."admissionId"::text AS adm, r."datasetManifestSha256" AS ds,
  r."syntheticOnly" AS syn FROM public."RevalSandboxRegistration" r WHERE r."registrationId" = $1::uuid AND r."workspaceId" = $2 AND r."clientId" = $3`;

/** The whole proof within `remainingMs` (statement/lock/idle timeouts of the transaction). Never throws. */
export async function verifyFixture(c: QueryClient, req: VerifyRequest, remainingMs: number,
  load: { dataset?: FrozenDataset } = {}): Promise<VerifyOutcome> {
  let begun = false;
  try {
    const dataset = load.dataset ?? loadFrozenDataset();
    const mapping = loadSeedMapping();
    const spec = dataset.byId.get(req.fixtureId as never) ?? refused('FIXTURE_MISMATCH');
    let plan;
    try { plan = seedPlan(dataset, req.fixtureId, mapping.mapping, mapping.sha256); } catch { refused('FIXTURE_MISMATCH'); }
    const scope = { workspaceId: req.workspaceId, clientId: req.clientId, actorId: req.actorId };
    if (dataset.file.scope.workspaceId !== scope.workspaceId || dataset.file.scope.clientId !== scope.clientId) refused('REGISTRATION_MISMATCH');
    const t = Math.max(1, Math.floor(remainingMs));
    // rc2 (review F9): the accepted runtime confinement check (the API's own startup check, R-EVAL readiness included).
    try { assertConfinedRuntimeRole((await c.query(RUNTIME_ROLE_CHECK_SQL)).rows[0] as unknown as RuntimeRoleFacts); }
    catch (e) { if (sqlStateOf(e) !== undefined) throw e; refused('UNAUTHORIZED'); }
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); begun = true;
    await c.query(`SET LOCAL statement_timeout = ${t}`); await c.query(`SET LOCAL lock_timeout = ${t}`);
    await c.query(`SET LOCAL idle_in_transaction_session_timeout = ${t}`);
    await setScope(c, scope);
    const reg = (await c.query(REGISTRATION_SQL, [req.registrationId, scope.workspaceId, scope.clientId])).rows;
    if (reg.length !== 1 || reg[0]!.dbi !== req.databaseInstanceId || reg[0]!.ac !== req.actorId || reg[0]!.adm !== req.admissionId
      || reg[0]!.ds !== DATASET_MANIFEST_SHA256 || reg[0]!.syn !== true) refused('REGISTRATION_MISMATCH');
    const b = (await c.query(BINDING_SQL, [req.registrationId, scope.workspaceId, scope.clientId])).rows;
    if (b.length !== 1 || b[0]!.f !== req.fixtureId || b[0]!.g !== req.fixtureGeneration) refused('FIXTURE_MISMATCH');
    let reference: Date;
    try { reference = syntheticSourceReference({ fixtureId: b[0]!.f as string, generation: b[0]!.g as string, syntheticFreshnessAt: b[0]!.ref as string,
      datasetManifestSha256: b[0]!.ds as string }); } catch { return refused('FIXTURE_MISMATCH'); }
    const actor = (await c.query(`SELECT a.status FROM public."Actor" a WHERE a."workspaceId" = $1 AND a.id = $2`, [scope.workspaceId, scope.actorId])).rows;
    const member = (await c.query(`SELECT m."clientId" AS cl, m.permissions FROM public."ClientMembership" m WHERE m."workspaceId" = $1 AND m."actorId" = $2`,
      [scope.workspaceId, scope.actorId])).rows.filter(m => m.cl === scope.clientId);
    if (actor.length !== 1 || actor[0]!.status !== 'ACTIVE' || member.length !== 1
      || !['context:read', 'ask:remote'].every(p => (member[0]!.permissions as string[]).includes(p))) refused('UNAUTHORIZED');
    const rowIdentity = sameKeys(await scopedKeys(c, scope), planKeys(plan!));
    let source: AskSourceRead | null = null;
    try {
      const phase = new AskPhase({ check() { /* no Ask run: the verifier owns no request */ } }, t);
      source = await readDbSource(phaseSql(rawTransaction(c), phase), { workspaceId: scope.workspaceId, clientId: scope.clientId }, spec.requestedFocus, reference);
    } catch (e) {
      // rc2 (review F6): only a DATA verdict of the accepted reader is a negative proof; a deadline, connection or other
      // failure is a fixed refusal, never all-false booleans.
      if (!(e instanceof AskFailure) || !['ASK_SOURCE_INVALID', 'ASK_TOO_LARGE', 'ASK_CONTEXT_UNAVAILABLE'].includes(e.code)) throw e;
      source = null;
    }
    await c.query('COMMIT'); begun = false;
    if (source === null) return { kind: 'CHECKED', rowIdentity, sourceProjection: false, expectedFacts: false, allFiveIntents: false };
    const declared = buildSource(spec, dataset.file.scope);
    const sourceProjection = declared.reachability.length === 0 && canonical(source) === canonical(declared.source);
    const projection = project(source);
    return { kind: 'CHECKED', rowIdentity, sourceProjection, expectedFacts: bankMatches(projection, spec, dataset.file.scope),
      allFiveIntents: allIntentsPass(projection, spec, dataset.file.scope) };
  } catch (error) {
    if (begun) await c.query('ROLLBACK').catch(() => undefined);
    if (error instanceof Refused) return { kind: 'REFUSED', code: error.code };
    if (error instanceof AskFailure) return { kind: 'REFUSED', code: error.code === 'ASK_DEADLINE' ? 'DEADLINE' : 'INTERNAL_FAILURE' };
    const code = (error as { code?: unknown }).code;
    return { kind: 'REFUSED', code: code === '57014' || code === '55P03' || code === '25P03' ? 'DEADLINE' : code === '42501' ? 'OWNER_REQUIRED' : 'INTERNAL_FAILURE' };
  }
}
