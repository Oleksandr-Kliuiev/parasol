# S3-B RC1 independent acceptance review

**Decision: CHANGES_REQUIRED.** Two required P2 findings remain. S3-B is not accepted; S3-C remains gated.

Reviewer: fresh native Codex subagent `astra_s3b_rc1`, explicitly assigned `gpt-6-astra`, effective effort **xhigh**. Review date: 2026-10-09. This is an independent assessment of actual source and verification, not acceptance of the implementer's report. No inherited reviewer verdict was supplied. Model/effort attribution is the explicit native launch configuration; the coordinator retains the platform launch evidence. Attributable subscription usage is unavailable to this reviewer.

## Exact reviewed artifact

- Checkout: `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`.
- HEAD: `916a4d69853ff6da636e8609a2e0bd33aa787f66`.
- Manifest: `verification/stage3/S3B_RC1_MANIFEST.json`, SHA-256 `3e113d152f2dc25f04fd9a2a61888b9f0150a6f1f8f493547d9e66ae64cb933b`.
- Source package hash: `7515e441dd31c75ad652e590180c7b3befc378a241620798c6deed58eaa15877`; all **572** source entries checked against checkout and ZIP bytes.
- Source ZIP: `/tmp/atlas-stage3/S3B_RC1_SOURCE.zip`, SHA-256 `ace5ae451e31674a5251550112c8c888353584c4d91120e1193c73673aef270b`.
- Full working inventory: **604** entries, aggregate `eeecd434473a2b51f2e4ca3e7543419fd8cce7cff358cace3e805627654cfbe7`; zero mismatches before and after independent checks. Historical ZIPs remain inventoried, with their bytes excluded from the source ZIP.
- Baseline: `S3B_BASELINE.json`, SHA-256 `936c5b9ae2630a68915253fdfb52f474cc537c42a418bd0612de57f26036dbc6`, **591** entries. Independently derived delta agrees exactly: **17 changed / 13 added / 0 removed**.
- Approved architecture package: `e2d574185b53f28b5fc25f039a1b8c3df2cc7111133077fca2b4318809364d3c`. Prior accepted S3-A RC3 package: `754eee15cf8e89cd7f61d8914f4796d3a5314f44e41169fac33145495134a51c`.
- All 20 old migrations plus lock, prior S3-A verification artifacts, Stage 2 documentation (including ROADMAP), and frozen Stage 3 normative content remain unchanged from the supplied baseline. The S3-A roles upgrade fixture is byte-exact to accepted RC3 `prisma/roles.sql`, hash `40ce17f17a33fd8824a031ad287bc68ee22976c6351febd41b1acaa1d221de8a`.

## Required findings

### F1 — P2: terminal replay returns success after the current bearer expires during a row-lock wait

Locations: `packages/actions/approvals.ts:129` and `:155`; compare the clock/expiry checks at `:131–134` and `:158–161`.

`withFencedAdmission` authenticates after the fence lock, but revoke/cancel subsequently wait for request and approval locks. The successful REVOKED and CANCELLED replay branches return before the final DB clock and `callerExpired` check. Therefore a bearer that was valid at admission but expires during that wait still receives an authenticated success/result. The same callers are refused if their token is already expired when admission begins.

Independent PG17.11 reproduction for **both** operations: create and terminate the request; verify a valid own replay; set that caller's current token to expire in three seconds; hold the request row `FOR UPDATE`; begin replay and observe it blocked; wait until the token's expiry has passed by the DB clock; release the row. Actual results:

```text
revoke: expiredBeforeLockRelease=true, state=REVOKED, idempotent=true, auditDelta=0
cancel: expiredBeforeLockRelease=true, state=CANCELLED, idempotent=true, auditDelta=0
expected for both: ACTION_AUTHENTICATION_FAILED
```

This violates the fresh current bearer requirement in `02_CONTRACTS.md:14–17,88–89`, `03_DATA_AND_CONCURRENCY.md:54–56`, and the explicit implementation requirement that the caller's captured expiry may elapse while waiting for locks. `IMPLEMENTATION_STATUS.md:62–64` currently overstates the implemented guarantee. There is **no renewed approval, mutation, attempt, permit or external effect** in this reproduction; the defect is an authorization/result boundary, not an execution bypass.

Required repair: before either successful terminal replay, use the DB clock read after the final acquired request/approval lock to check the **current caller's** expiry. Preserve valid replay with no mutation/audit/renewal, and do not apply a stored-intent guard that would revive or rewrite terminal history. Add real wait tests for both terminal paths, covering waits on the request and, where present, approval row, so moving the check before the last lock cannot satisfy the tests. Check nearby early-return paths for the same fresh-caller boundary.

### F2 — P2: the reservation audit masks known DB conflicts as audit failures

Locations: `packages/actions/authority.ts:66–70`, reached from the new `packages/actions/reservation.ts:72–73`; related blanket mapping at `authority.ts:116` should be assessed in the same bounded repair.

`clientAudit` catches every exception and replaces it with `ACTION_AUDIT_FAILED`. A real SQL deadlock inside the audit INSERT is consequently hidden from `actionFailure`, which would correctly recognize it as a DB conflict. The frozen public error contract explicitly maps **40P01 / 40001 / Prisma P2034 to ACTION_DB_CONFLICT** (`02_CONTRACTS.md:105–106`); it does not exempt the audit statement inside the reservation transaction.

Independent PG17.11 reproduction: a disposable owner session holds `ACCESS EXCLUSIVE` on `AuditEvent`; reservation obtains its fence/request/approval locks and reaches its blocked audit INSERT; the holder then requests the same workspace fence row. The reservation backend is the deadlock victim. A passive Prisma query extension subsequently confirmed the original exception using the production `sqlState`/`isDbConflict` helpers:

```text
raw kind=PrismaClientUnknownRequestError, SQLSTATE=40P01, isDbConflict=true
actual returned code=ACTION_AUDIT_FAILED
expected returned code=ACTION_DB_CONFLICT
request=APPROVED, approval=APPROVED, attempts=0, auditDelta=0, no permit
```

The shared helper predates this checkpoint, but its reuse by the newly introduced reservation path fails S3-B's required error contract. Atomic rollback is correct; the fixed error classification is not.

Required repair: preserve recognized conflict failures through audit handling so the outer mapping returns `ACTION_DB_CONFLICT`; retain `ACTION_AUDIT_FAILED` for genuine audit-storage failures. No raw SQL/message leakage and no automatic retry. Add an actual conflict-at-audit regression in addition to the existing conflict-before-reservation and injected ordinary-audit-failure checks; cover the related security-denial mapping if changed.

## Independent verification

The checkout remained read-only throughout. Only disposable databases/roles, temporary protected fixture files managed by test helpers, and this report were written. No pilot/persistent DB, config, accounts, vendor/network port, generated source or evidence files were modified.

1. Programmatic SHA-256 verification of manifest aggregates, all inventory entries, ZIP entries/ZIP SHA, baseline SHA and exact delta; repeated inventory verification after tests: **PASS**.
2. Focused actual PostgreSQL suite:

   ```sh
   /tmp/atlas-stage3/claude-tools/pgenv.sh node --experimental-strip-types --test --test-concurrency=1 tests/pg/action-approvals.pg.test.ts tests/pg/action-guard.pg.test.ts tests/pg/action-reserve.pg.test.ts tests/pg/action-upgrade-s3b.pg.test.ts tests/pg/m365-confirm-clock.pg.test.ts
   ```

   **Exit 0; 28/28 passed, 0 failed**, about 31 seconds. Includes all 25 new S3-B tests and three accepted M365 clock-after-lock tests. Used PostgreSQL **17.11** and confined runtime roles. No build/generate command was rerun.
3. Independent terminal-replay expiry probe: both F1 cases reproduced; valid unexpired replay controls passed; cleanup completed. Command was inline `node --experimental-strip-types --input-type=module` under the same wrapper; reusable reproduction procedure appears below.
4. Independent reservation-audit deadlock probe: F2 reproduced with correct rollback/no permit. A passive query extension confirmed SQLSTATE **40P01**, recognized by the production helper. An intermediate diagnostic assertion incorrectly expected the P2034 representation and exited 1; cleanup still completed. The corrected diagnostic passed and established `PrismaClientUnknownRequestError` with embedded 40P01. This was a probe-assumption correction, not an implementation repair or a change to the deadlock scenario.
5. `git diff --check`: **exit 0**.
6. Narrow inspection of supplied final logs confirmed **177/177** unit/PGlite, **366/366** full PostgreSQL, PG17-check PASS and schema-drift PASS. The supplied evidence records the second 366/366 run and remaining checkpoint commands. These are implementer evidence, clearly separate from the independently rerun 28 tests and probes. Initial full-suite failures and their statistics-snapshot diagnosis are retained in the evidence.

### Reproduce the independent probes safely

Use the existing disposable harness and fixture helpers, never an existing tenant database. Run the following from the checkout with `/tmp/atlas-stage3/claude-tools/pgenv.sh node --experimental-strip-types --input-type=module`; it prints only safe outcome summaries. It does not write a source/probe file. The helpers generate their own synthetic credentials, create/drop a disposable database and roles, and create/remove protected temporary preview files. This is the compact combined form of the executed probes.

```js
import { PrismaClient } from '@prisma/client';
import { createTestDatabase } from './tests/support/pg-harness.ts';
import { CA, WA, MOCK, addActionFixtures, privateDir, runtimeClient } from './tests/support/action-fixtures.ts';
import { actionFlow, addApprovalActors, as, expireTokenIn, observe, settle,
  untilPassed, waitForWaiters } from './tests/support/action-approval.ts';
import { cancelAction, revokeApproval } from './packages/actions/approvals.ts';
import { sqlState, isDbConflict } from './packages/graph/fence-errors.ts';
import { openSession, inFlight } from './tests/support/pg-race.ts';
const pgdb = await createTestDatabase();
const base = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
let rawCodes = null;
const db = base.$extends({ query: { auditEvent: { async create({ args, query }) {
  try { return await query(args); } catch (e) {
    rawCodes = { sqlstate: sqlState(e), conflict: isDbConflict(e) }; throw e;
  }
} } } });
const runtime = await runtimeClient(pgdb.runtimeUrl), files = await privateDir();
let holder;
try {
  await addActionFixtures(pgdb.owner); await addApprovalActors(pgdb.owner);
  const flow = actionFlow(db, files), see = observe(runtime);
  for (const kind of ['revoke', 'cancel']) {
    const actor = kind === 'revoke' ? 'approver' : 'requester';
    const r = kind === 'revoke' ? await flow.approved() : await flow.request();
    const act = () => kind === 'revoke'
      ? revokeApproval(db, MOCK, as(actor), CA, r.requestId, r.inputHash)
      : cancelAction(db, MOCK, as(actor), CA, r.requestId);
    await act(); await act();
    await expireTokenIn(pgdb.owner, `tok-${actor}`, '3 seconds');
    const expiry = (await pgdb.owner.query('SELECT "expiresAt" FROM "ApiToken" WHERE id=$1', [`tok-${actor}`])).rows[0].expiresAt;
    holder = await openSession(pgdb.ownerUrl); await holder.client.query('BEGIN');
    await holder.client.query('SELECT 1 FROM "ActionRequest" WHERE id=$1 FOR UPDATE', [r.requestId]);
    const run = inFlight(act); await waitForWaiters(runtime, 1);
    await untilPassed(pgdb.owner, expiry); await holder.client.query('ROLLBACK');
    const result = await settle(run.result());
    console.log({ kind, result: typeof result === 'string' ? result : { state: result.state, idempotent: result.idempotent } });
    await holder.client.end(); holder = undefined;
    await pgdb.owner.query('UPDATE "ApiToken" SET "expiresAt"=NULL WHERE id=$1', [`tok-${actor}`]);
  }
  const r = await flow.approved();
  holder = await openSession(pgdb.ownerUrl); await holder.client.query('BEGIN');
  await holder.client.query("SET LOCAL deadlock_timeout='10s'");
  await holder.client.query('LOCK TABLE "AuditEvent" IN ACCESS EXCLUSIVE MODE');
  const run = inFlight(() => flow.reserve(r)); await waitForWaiters(runtime, 1);
  const inverse = inFlight(() => holder.client.query('SELECT 1 FROM "ActionAuthorityFence" WHERE "workspaceId"=$1 FOR UPDATE', [WA]));
  const outcome = await settle(run.result()); await inverse.result();
  await holder.client.query('ROLLBACK');
  console.log({ kind: 'audit-deadlock', rawCodes, outcome: typeof outcome === 'string' ? outcome : 'PERMIT_RETURNED',
    attempts: await see.attempts(r.requestId), request: (await see.request(r.requestId)).state,
    approval: (await see.approval(r.requestId)).decision });
} finally {
  if (holder) { await holder.client.query('ROLLBACK').catch(() => {}); await holder.client.end(); }
  await runtime.end(); await base.$disconnect(); await files.remove(); await pgdb.drop();
}
```

## Assessed boundaries and residual risks

- Apart from F1, the inspected mutating success paths read DB time after the explicit request/approval locks. Stored request/approval epoch, both nullable signing-expiry snapshots, ACTIVE signer rights on one membership, deployed versions and exact binding are checked behind the fence. No signer ApiToken SELECT surface was added; scoped Actor reads restore the client context and leave the token digest clear.
- Exact stored-preview/hash comparison and self-approval refusal, same-signer APPROVED replay without renewal, permanent guarded loss committed before refusal, explicit terminal decisions, one lifetime attempt, atomic consume/attempt/state/audit and post-commit WeakMap permit creation are coherent with the frozen design. Real focused tests cover owner mutations, ordering, ordinary rollback, missing/extra grants and upgrade.
- Permit material is private and bound to the committed stored intent/attempt. Consumption is single-use, unforgeable by serialization/copy and conservatively bounded by the original monotonic start deadline; failed/expired consumption leaves the durable latch consumed. No S3-C dispatch/result service or LIVE port exists in this checkpoint.
- Provisioning and readiness agree on the S3-B column allowlist. The SQL boundary remains the approved lifecycle/history/FK/CHECK boundary, not a claim that possession of arbitrary runtime SQL enforces every service-level permission/time rule. Direct SQL can perform lifecycle-allowed state changes and supply initial INSERT values; result/verification/mock writes and immutable UPDATEs remain closed. These disclosed limits are not treated as an unapproved architecture amendment or a new required DB redesign.
- The adjacent `pg_stat_clear_snapshot()` test-support change is appropriate for a polling observer in a transaction; it refreshes backend visibility without weakening the lock-order or clock assertions. The three affected M365 clock tests independently passed.
- Required repair evidence must identify a new frozen artifact and preserve the current baseline/history. Re-review must close F1/F2 against that exact artifact, retain genuine-audit-failure rollback and no-retry behavior, and check nearby authorization/error paths. This review neither accepts S3-B nor authorizes dependent S3-C work.
