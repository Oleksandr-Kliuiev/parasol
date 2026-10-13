# S4-B RC1 independent acceptance review

**CHANGES_REQUIRED — one P2 finding (R1).**

Reviewer: **GPT-6 Astra (`gpt-6-astra`), native fresh independent subagent, actual runtime effort `xhigh`**. Date: 2026-10-09. This is the first acceptance review of this checkpoint; no other current-checkpoint reviewer verdict was supplied. Scope is B1–B5 of the approved Stage 4 MOCK architecture. S4-C is **NOT_STARTED**; LIVE is **DEFERRED_BY_OWNER**. This report does not confer financial production or LIVE readiness.

## Exact reviewed artifact

Repository: `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`, branch `planning/stage2-m365`, HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, including its declared dirty baseline.

| Identity | SHA-256 |
|---|---|
| `verification/stage4/S4B_RC1_MANIFEST.json` | `aefc6e2a82d3c2d924a8a8030c73f3b3429dad3b56bc1a30d94ddc0d6c04ca29` |
| Source package hash | `8513886b9ecb607522aa980ba9a7453311321298100a26f17b9658da7cb98b58` |
| `verification/stage4/S4B_RC1_PACKAGE.zip` | `1f6f7460f6d9072d259f9d1557a3905e1fb66b3a2bb0d811b057d5e8bda327e1` |
| Working inventory hash | `0df43e330aa4b0e08395dab7717c232d39812f5d080c40fb25ae5b80af10ba02` |
| Accepted S4-A seal | `74b94cfc74222fa75e89555e16398f3d1bf43e8c9b64db869a548223696c51e2` |
| Approved eight-file architecture hash | `d848b026efcc2af30c7900ef6f5325e31c04c11825d4ec089dcf6baf984873ec` |

Independently verified all 763 archive entries against manifest hashes and working files, all 804 working-inventory entries, both aggregate hash rules, the S4-A/design seal hashes, and all eight current normative files against the approved architecture manifest. The calculated baseline delta exactly matches the manifest: six changed paths, 27 additions, no removals. No schema, role, readiness, migration, earlier-stage source or historical-artifact change is concealed by the large HEAD diff. The accepted authority module's only code delta is the positive SQLSTATE rollback marker. All 804 inventory files remained unchanged after this review's tests and probes. Evidence: `astra-s4b-rc1/identity-start.json` and `identity-end.json` beside this report.

## R1 — P2: bind the completed aggregate to its claim before first publication

**Locations:** `packages/poweroffice/pass.ts:74–77`, `packages/poweroffice/capabilities.ts:27–29`, and `packages/poweroffice/publication.ts:73–79` (first persistence at `publication.ts:62`).

`runExportPass` obtains a detached, frozen aggregate, but records only `phase = 'COMPLETE'`; the claim retains no corresponding aggregate/fact identity. `publishFact` checks that phase and validates the shape of whichever `fact: unknown` its caller supplies. On an ACTIVE attempt it publishes that supplied aggregate without proving it is the completed export's fact. The stored-fact equality check at `publication.ts:49–57` runs only after SUCCEEDED, so it protects later replays, not the first publication or a subsequent explicit publication after a rolled-back attempt.

**Independent real-PG reproduction:** a genuine admission using the production MOCK composition and an actual built-in complete export returned a frozen summary with `totalCount = 3`. Passing the same genuine COMPLETE claim and an unrelated valid `{totalCount: 0, currencies: []}` to `publishFact` committed a zero snapshot, marked the attempt SUCCEEDED, and inserted its SUCCEEDED audit. Replaying the authentic three-item aggregate then returned `POWEROFFICE_PUBLICATION_CONFLICT`. This reproduction used neither `testFaultComposition`, mutable `claimRecord` access, a fabricated capability, nor direct domain-table mutation.

This violates the SAME-complete-fact obligation in `docs/stage4/S4B_IMPLEMENTATION_BRIEF.md:56–65`, the complete-pass-to-publication flow in `04_PORT_AND_SYNC.md:25–28`, and the B3/B4 boundary being accepted. A structurally valid aggregate is not proof of the completed export. A miswired trusted internal caller can silently publish the wrong financial summary as a known zero with coherent success metadata. The current `syncPowerOffice` orchestration passes `pass.summary` correctly; **this finding is not an external HTTP/CLI exploit claim**, and those entry points do not exist in this checkpoint.

**Required correction:** retain the exact detached immutable completed fact in private claim/fact state when the pass completes. Publication must derive its persisted aggregate from that state or reject a nonidentical supplied aggregate before any publication effects. Do not rely solely on a mutable phase marker or shape validation, and do not weaken authority, binding, deadline, replay or rollback rules. Preserve canonical identical replays where the contract permits them.

**Required regression:** the genuine built-in completed-pass case above must reject a different valid fact before the first publication, with no snapshot, terminal-state change or success audit; the original fact must remain publishable. Also exercise another claim's different completed fact and changed fact after a rolled-back first publication, plus existing identical replay and known-rollback retry checks. These can be repaired within the approved architecture. Obtain acceptance of the new exact artifact before dependent S4-C work.

Reproduction source: `/tmp/atlas-stage4/astra-s4b-rc1/fact-provenance.ts` (SHA `9355d38bcb2f66a92c762d17ddd7bcf22d08ba620d267e761707076e2caaee16`). Result: `fact-provenance.log` (SHA `a11ad3582fd244523253c4babeb76865f610de4567dd121be0ac6c11abcd700d`). The probe exits successfully because it asserts and records the defect; it is not an acceptance pass.

## Independent verification

Existing checks were run serially against this frozen source, with the existing generated client and disposable PostgreSQL 17.11 databases/unique roles:

| Independent command/evidence | Result |
|---|---|
| `node --experimental-strip-types --test tests/poweroffice-builtin.test.ts tests/poweroffice-composition.test.ts` | **12/12 passed**, zero failed/skipped |
| `/tmp/atlas-stage3/claude-tools/pgenv.sh node --experimental-strip-types --test --test-reporter=tap --test-concurrency=1 tests/pg/poweroffice-sync.pg.test.ts tests/pg/poweroffice-pages.pg.test.ts tests/pg/poweroffice-publication.pg.test.ts tests/pg/poweroffice-fk-victims.pg.test.ts tests/pg/poweroffice-recovery.pg.test.ts tests/pg/poweroffice-privacy.pg.test.ts tests/pg/poweroffice-authority.pg.test.ts` | **39/39 passed**, zero failed/skipped; 154.316 s |
| `pgenv.sh node --experimental-strip-types /tmp/atlas-stage4/astra-s4b-rc1/fact-provenance.ts` | Required defect reproduced with real built-in source and confined runtime |
| `pgenv.sh node --experimental-strip-types /tmp/atlas-stage4/astra-s4b-rc1/direct-update.ts` | **4/4 additional actual direct-UPDATE victim cases passed** |

Thus **51 existing tests passed**, plus four additional successful concurrency cases and one defect-reproduction probe. The 39 PG tests comprise all 32 new B tests and seven adjacent authority regressions. Their real DB-clock timeline verified the original 60-second read and 80-second claim deadlines, the intervening persistence window, expired BUSY, no-source recovery, post-deadline identical receipts, and revocation/binding refusal. Actual built-in cancellation and the 10-second in-flight deadline/late-inert tests passed. No clock override was used for service timing.

Independent logs under `/tmp/atlas-stage4/astra-s4b-rc1/`:

- `unit.log`: SHA `23ffe9bf837542674ab111d2fddd1c8f315980cab00c35bb9b3a20e56d442e7b`.
- `pg-targeted.log`: SHA `1012eff64be35e42530ba03f531a583a3bcbb8735644fffe8fb7daa75d4fdf3a`.
- `direct-update.ts`: SHA `5cdc57c333c8475eed64a7b60dcc15cb96e95f225f093d3f98d38587372d72e2`.
- `direct-update.log`: SHA `a384bc38e44ecd789ff701d01c90959f276f7c1eaea4c3769335ee85fcff9b5b`.

The frozen implementer evidence reports all 11 required checks passing, with **208 unit/PGlite and 507 PG tests**. I inspected its result manifest and bounded log summaries; those broad-suite results remain implementer evidence, not independent reruns. The report's “34 new PG tests” is a prose error: categories and suite delta total 32. The native writer receipt records actual `claude-opus-5-5`, explicit high, native subscription routing and no fallback; its final-segment usage/turn counters do not establish whole-run quota. No blanket rerun, build, generator, formatter, Git mutation or source edit was performed by this reviewer.

## FK qualification and mandatory B2/B4 evidence

The supplied four Connection-vs-Stage4 deadlock tests genuinely exercise PostgreSQL 40P01 with an owner `SELECT FOR UPDATE` followed by a direct non-key lifecycle UPDATE. Their plain non-key UPDATE case also correctly shows serialization: a non-key UPDATE does not inherently conflict with the FK's KEY SHARE. The frozen handoff's implication that every BEFORE-trigger UPDATE has an exclusive tuple lock is overbroad.

I additionally tested the literal direct mutation below, with **no preceding Connection row-lock SELECT**:

```sql
UPDATE public."Connection"
SET id = id, "lifecycleVersion" = "lifecycleVersion" + 1
WHERE "workspaceId" = $1 AND "clientId" = $2 AND id = $3;
```

Mentioning the FK-referenced key column in the UPDATE requests the key-conflicting tuple lock while leaving its actual immutable value unchanged; the installed BEFORE ROW fence trigger then waits on the workspace fence. A separate State holder arranged the cycle. Only the disposable owner session's `deadlock_timeout` was set (5 s or 400 ms) to select the victim; no server-wide setting or ACL change was involved.

| Boundary | Victim | Direct UPDATE | Stage4 outcome | Source calls | Persisted result |
|---|---|---|---|---:|---|
| Admission | Stage4 | Commits lifecycle 2 | `POWEROFFICE_DB_CONFLICT` | 0 | Prior domain state unchanged; no partial admission |
| Admission | UPDATE | `40P01`, rollback | Success | 1 | Valid lifecycle-1 claim/snapshot; mutation did not commit |
| Publication | Stage4 | Commits lifecycle 2 | Known-rollback re-run sees `POWEROFFICE_BINDING_CHANGED`; owned failure closes FAILED | 1 | Prior snapshot/pointer retained; no partial publication |
| Publication | UPDATE | `40P01`, rollback | Success | 1 | Exactly one new lifecycle-1 successful snapshot |

Each case also ran a subsequent explicit sync and checked that its snapshot used the committed current lifecycle. These four preserved independent probes satisfy the mandatory **B2/B4 direct-UPDATE victim evidence for the current RC1 source**. There is no additional required finding to commit automated copies, although retaining them as regressions is useful. The C3 cleanup victim requirement remains outside this checkpoint. No Stage4 Connection SELECT lock, new grant or normative amendment is needed.

## Other inspected properties and residual limits

- Genuine composition/session/claim/failure objects reject serialized or fabricated copies. No production module imports the fault seam; its imports are confined to tests. Internal exports, mutable records and minting helpers are trusted implementation code, not a sandbox against arbitrary code already running with the application's DB access. R1 needs no such arbitrary-code assumption.
- Admission/page/publication use the accepted authority sequence and final-lock token/actor/permission checks; port work follows the committed page admission outside DB transactions. Existing ACTIVE and retention-cap refusals occur without source calls.
- Publication retries only the private positive 40P01/40001 marker, at most three transactions, with the same per-invocation frozen aggregate and allocated identities. Raw P2034/P2028 and unknown outcomes are not positive rollback authority. Exhaustion, audit rollback and real deadlocks behaved as specified; this does not cure R1's missing binding across completion/publication calls.
- Owned failure after revocation/binding loss preserves prior snapshots and closes only ACTIVE before the original deadline; explicit recovery is freshly authorized, never initializes missing State, and permits disabled/lifecycle-drift closeout without source access. Source/authority failure codes and audits remain bounded.
- No S4-A isolation/role/readiness contract changed. Adjacent authority/tamper regressions passed; full unchanged A confinement tests were not unnecessarily repeated.
- Privacy checks capture actual child stdout/stderr and a positive-controlled local synthetic fetch/socket trap. The durable schema and code contain no raw-page staging/log path. The DB scan explicitly enumerates invoice IDs and company identifiers; despite its title, it does not enumerate export IDs. Absence of export-ID persistence is supported by code/schema inspection, not a direct export-ID scan assertion. HTTP/CLI/Gateway and C-only read/maintenance behavior remain unimplemented and unaccepted.
- All DB work used the silent approved wrapper and own disposable harness databases/roles, cleaned through test/probe teardown. The wrapper, credentials, `.env`, private pilot material and real vendor/account data were not read or printed. No shared/global/builtin/host-capable ACL tampering was added. The adjacent authority fixtures change only disposable DB-local objects/grants and restore/drop them; this is not a universal claim that every fixture mutation was rollback-only. No real tablespace, persistent pilot, deployment, financial write, outbound message, vendor call or schedule was performed.

**Remaining acceptance work: fix R1, preserve the exact new source/evidence identity, and obtain renewed S4-B acceptance.**
