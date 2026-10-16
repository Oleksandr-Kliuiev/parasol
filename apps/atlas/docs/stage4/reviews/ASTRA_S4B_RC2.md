# S4-B RC2 independent acceptance review

**ACCEPTED — RC1 R1 closed; no required findings remain in B1–B5.**

Date: 2026-10-10. Reviewer: fresh native **GPT-6 Astra (`gpt-6-astra`), explicit effective effort `xhigh`, `fork_turns: none`**, canonical task `/root/astra_s4b_rc2`. This is a fresh independent assessment because the repair changes completed-fact provenance. No other RC2 verdict was supplied. The prior RC1 finding and its reproduction were supplied as the repair target.

Model evidence is the orchestrator-observed native spawn assignment and returned canonical task, recorded at `/tmp/atlas-stage4/S4B_RC2_REVIEW_ASSIGNMENT.json`, with the original tool invocation retained in chat. This report's self-identification is not provider telemetry. The reviewer tools expose no additional independent response-model metadata; no effort change or alternate-model route was used during this assessment.

Scope: approved Stage 4 **MOCK S4-B B1–B5** only. **S4-C NOT_STARTED; LIVE DEFERRED_BY_OWNER.** This acceptance does not establish vendor accounting semantics, live export completeness, deployment, financial production readiness, public reads, API/CLI, or maintenance admission.

## Exact accepted artifact

Repository `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`, branch `planning/stage2-m365`, HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, including the declared accepted dirty baseline.

| Identity | SHA-256 |
|---|---|
| `verification/stage4/S4B_RC2_MANIFEST.json` | `303212b7d28d9d4c1d712101b85e81fe61b37dc7a059b481b4725540811eb924` |
| Source package hash | `309b6aff8b430f1b28887331db25e4886328ba6faa7afe1d781942772d12dd14` |
| `verification/stage4/S4B_RC2_PACKAGE.zip` | `8d70f85d83a2b0e311ab6c3b74f30bb9a6509bea8b3aa1c9ce83c757ac068570` |
| Working inventory hash | `7218465974eeed3bdaa30b7d881dcc83d505a254ec2f01b829e25812c3d6866a` |
| Accepted S4-A seal | `74b94cfc74222fa75e89555e16398f3d1bf43e8c9b64db869a548223696c51e2` |
| Approved eight-file architecture package | `d848b026efcc2af30c7900ef6f5325e31c04c11825d4ec089dcf6baf984873ec` |
| Architecture seal | `b37061ad1d673aa3ca05cefd049faeafdc98cd8d88d319921d5a8e44375305ad` |

Independently verified all **772 archive entries** against manifest hashes and working files, all **814 working-inventory entries**, both aggregate hash rules, HEAD/branch, dependency/design seals and all eight design files. The source ZIP has no extra or missing entry. The only paths outside the declared inventory are the RC2 manifest and ZIP themselves.

Recomputed deltas match the manifest exactly: versus the B baseline, six changed files, 37 additions, no removals; versus RC1, four changed files and ten additions, no removals. The RC1 source repair is exactly `capabilities.ts`, `pass.ts`, `publication.ts`, plus the new 99-line `poweroffice-provenance.pg.test.ts`; the other changes are status/history/evidence. No schema, roles, readiness, migration, earlier-stage source or approved normative change is hidden by the large HEAD diff. All 24 migration artifacts match the B baseline; unchanged baseline entries preserve the prior norms/history. The full inventory and archive were verified again after checks; see `astra-s4b-rc2/identity-end.json`.

## R1 closure and contract compatibility

RC1 allowed a genuine completed three-item export to publish an unrelated valid empty aggregate under the same claim. RC2 closes that exact gap:

- `capabilities.ts` holds a separate module-private WeakMap from the genuine claim to one completed fact. `bindCompletedFact` revalidates a detached deeply frozen summary, stores its canonical form once while READING, and then sets COMPLETE. `completedFact` refuses missing or ended claims. `endClaim` deletes the binding.
- `pass.ts` binds the accumulator's completed summary after all export validation. It still disposes the accumulator and closes the built-in session on every exit. No page, invoice ID, company key or export ID is added to the bound aggregate.
- `publication.ts` requires canonical equality with the bound fact before invoking publication. Both the persisted summary and stored-snapshot replay comparison use the bound value. A caller-supplied object cannot replace the completed fact before first publication, after rollback, or after success.

The three committed regressions pass on actual PostgreSQL using the production MOCK composition and genuine built-in exports: alternate valid first facts (empty and changed amounts), another genuine claim's different fact in both directions, and substitution after audit rollback. Each refusal leaves no snapshot/pointer/terminal/success-audit effect, and the authentic detached clone subsequently commits once with the original allocated identity.

My additional independent probe reproduces the original scenario as a refusal and verifies nearby properties without a fault composition or mutable claim-record access: property insertion order does not change canonical identity; mutating the supplied clone immediately after invocation cannot change the persisted fact; a genuine zero export cannot publish another claim's nonzero fact; two concurrent identical publications produce one snapshot and one SUCCEEDED audit; and ended claims refuse publication and another pass.

The earlier changed-fact refusal is compatible with the approved internal capability contract. It returns only the fixed conflict, with no DB transaction, business data or audit effect; it grants no authority. This is not a new public service or an authentication bypass. A structurally identical fact still enters the unchanged authority transaction and must pass current token, actor, all-of rights, binding and ownership checks. The independent revocation probe confirms changed input conflicts while authentic input fails current authentication, leaving the claim unpublished. Malformed facts still fail strict DTO validation. The handoff's fresh authorization requirement for an identical SUCCEEDED receipt remains enforced, including after the original deadline.

## Independent verification

All tests used the existing generated client and real PostgreSQL **17.11** where applicable. I ran **69 tests: 27 unit + 35 B PostgreSQL + 7 adjacent authority PostgreSQL; all passed, zero failed/cancelled/skipped**. I also ran **seven additional probe cases**, grouped as three provenance/ordering cases and four literal direct-UPDATE victim cases; all passed. Every test/probe process exited 0.

Commands, from the repository root (stdout/stderr retained only in the reviewer scratch directory):

```sh
node --experimental-strip-types --test --test-concurrency=1 tests/poweroffice-aggregate.test.ts tests/poweroffice-builtin.test.ts tests/poweroffice-composition.test.ts tests/poweroffice-dto.test.ts tests/poweroffice-policy.test.ts

/tmp/atlas-stage3/claude-tools/pgenv.sh node --experimental-strip-types --test --test-concurrency=1 tests/pg/poweroffice-provenance.pg.test.ts tests/pg/poweroffice-sync.pg.test.ts tests/pg/poweroffice-pages.pg.test.ts tests/pg/poweroffice-publication.pg.test.ts tests/pg/poweroffice-recovery.pg.test.ts tests/pg/poweroffice-fk-victims.pg.test.ts tests/pg/poweroffice-privacy.pg.test.ts

/tmp/atlas-stage3/claude-tools/pgenv.sh node --experimental-strip-types --test --test-concurrency=1 tests/pg/poweroffice-authority.pg.test.ts

/tmp/atlas-stage3/claude-tools/pgenv.sh node --experimental-strip-types /tmp/atlas-stage4/astra-s4b-rc2/provenance-independent.ts
/tmp/atlas-stage3/claude-tools/pgenv.sh node --experimental-strip-types /tmp/atlas-stage4/astra-s4b-rc2/direct-update.ts
```

Logs: `astra-s4b-rc2/focused-unit.log`, `focused-pg.log`, `authority-pg.log`, `provenance-independent.log`, `direct-update.log`. Source probes and the identity verifier are in the same scratch directory. Measured test-run durations: approximately 0.74 s unit, 148.25 s B PG, 5.63 s authority PG; these are not whole-review elapsed or subscription-usage figures.

Coverage includes genuine composition/session refusal and cancellation, bounded validated complete exports, active-claim/cap refusal, last-lock token expiry, fresh admission before every page, revocation/binding drift, atomic audit rollback, real deadlocks, three-attempt exhaustion, injected serialization rollback versus nonretryable cancellation/timeout, private failure ownership, and real original 60/80-second deadline/recovery/receipt cases without service clock overrides. The repair leaves SQL, lock ordering, allocated identity and retry classification unchanged. Known-rollback retries keep the same bound summary and IDs with fresh authority/binding/time and zero new source calls. No active claim revives on replay or recovery.

The frozen implementation evidence reports all **11 required final commands** passing with **208 unit/PGlite and 510 PG tests** on unchanged source before/after. I inspected that manifest, report, native execution receipt and bounded final-log summaries. Those broad results remain implementer evidence, not independent reruns. No blanket full suite, generator, build, formatter, snapshot update, Git mutation or repository edit was performed by this reviewer.

## FK, privacy and safety qualifications

I reran the preserved independent direct-UPDATE probe unchanged against RC2. Its actual statement has no preceding Connection `SELECT FOR UPDATE`:

```sql
UPDATE public."Connection"
SET id = id, "lifecycleVersion" = "lifecycleVersion" + 1
WHERE "workspaceId" = $1 AND "clientId" = $2 AND id = $3;
```

All four admission/publication × Stage4/UPDATE victim cases passed: admission's Stage4 victim returns DB_CONFLICT with no admission effects; publication's Stage4 victim performs a known-rollback retry, observes the new lifecycle, refuses BINDING_CHANGED and closes the owned failure while preserving the old snapshot; the opposite victims return PostgreSQL 40P01 to the UPDATE and allow one correct success. Each next explicit sync observes the committed lifecycle. This renews the mandatory B2/B4 evidence on the exact RC2 source.

The committed FK tests also pass, including their explicit tuple-lock holder and plain non-key UPDATE case. The frozen handoff's implication that every BEFORE-trigger UPDATE obtains a key-conflicting tuple lock remains overbroad: an ordinary non-key UPDATE can serialize without that FK conflict; naming the referenced key column as above obtains the relevant lock. No Stage4 Connection row lock or grant change is required. Cleanup victim evidence belongs to C3, outside this acceptance.

Privacy evidence includes the actual child stdout/stderr capture and positive-controlled local synthetic network trap. DB scanning explicitly enumerates invoice IDs and company keys; despite its title, it does not explicitly enumerate export IDs. Export-ID non-persistence is supported by code/schema inspection, not an export-ID scan assertion. The new private completed-fact state stores only the bounded aggregate and canonical form, is not logged/serialized, and releases its binding on claim end. Arbitrary trusted-module imports/minting helpers are not a sandbox against code already running inside the application; the repaired R1 required no such assumption.

All database work used the approved silent wrapper and newly created disposable databases/unique roles with teardown. I did not read the wrapper, `.env`, private pilot material, credentials or vendor/account data, and did not print URLs or tokens. No shared/global/builtin/host-capable ACL tamper was introduced; adjacent authority fixtures alter only their disposable DB-local objects and unique-role grants, restore/drop through their normal cleanup, and are not described as universally rollback-only. No real tablespace, persistent tenant/pilot operation, vendor API call, financial write, deployment, outbound message or schedule was performed. All reviewer processes finished before final identity verification; sole checkout ownership stayed with the orchestrator throughout.

The native implementer receipt records actual `claude-opus-5-5`, explicit high, native Anthropic subscription routing and no fallback. Its `rawUsage`/`numTurns` belong to the final SDK segment, not the whole cohesive session; cache counts and API estimates do not prove subscription-quota savings. Attributable subscription quota remains unknown.

**Acceptance is bound to the exact RC2 identity above. R1 is closed. S4-C remains NOT_STARTED and LIVE remains DEFERRED_BY_OWNER.**
