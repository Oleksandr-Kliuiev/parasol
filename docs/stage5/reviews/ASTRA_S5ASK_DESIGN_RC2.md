# Ask Atlas design RC2 — independent architecture review

**Verdict: CHANGES_REQUIRED.** Two required findings remain. This review does not authorize ASK-A implementation, accept code, or admit remote inference/LIVE/deployment.

Fresh native Codex reviewer assignment: **gpt-6-astra / xhigh**. No delegation; no other reviewer's current verdict or historical Ask verdict was read. Backend response-model receipts and attributable usage are not exposed to this reviewer; bind the orchestrator's native dispatch/runtime evidence to this report rather than treating this statement as provider identity proof. No CLI, provider, authentication or billing configuration was changed.

## Reviewed identity

Repository: `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`.

- Package: `S5ASK-DESIGN-rc2`, six normative files only (`README`, `AGENTS`, `01_SPEC`, `02_CONTRACTS`, `03_SECURITY_AND_STATE`, `04_PLAN_AND_ACCEPTANCE`).
- Package SHA-256: `bbed28ec187d7846ff5a292d7c40992dea496913f0361b0d555abe6450873854`.
- Manifest SHA-256: `2dcc3a0305b5bc67235fc3f2d43c90d8fe9bfeacbe0d07e6ad138d99826912ae`.
- Archive SHA-256: `e55830c1345d3a6f6c0a71faa3ba6e018bc4db58d0ae9ff4de179b5ea9879cde`.
- HEAD: `916a4d69853ff6da636e8609a2e0bd33aa787f66`; branch: `planning/stage2-m365`.
- Accepted S5-B dependency package: `0346dc1293e06dfe04c58cda197eb276baedf0784df1aef08f6cd951692f0d6b`; seal SHA-256: `2e6b7b27bab868b997a8f93cc80e68d09549da6ee8529a7a2a2ca70016e637e4`; closure SHA-256: `4b52961d8ce4d2f3c8781a79003be2adb553bf757093c6f097aeca9eaacd5b2e`.

## Required findings

### R1 — P1: Guard and capability authentication have no owner before database work

**Contract:** `docs/stage5/ask/03_SECURITY_AND_STATE.md:8`, `:57`, `:61`, `:70`, `:76`; acceptance Q6 at `04_PLAN_AND_ACCEPTANCE.md:37`.

The prescribed order executes the bearer guard before reserving capacity, and the reservation requires the authenticated guard identity. However, the accepted DB guard starts a separate Prisma authentication transaction (`apps/api/src/db/auth.ts:19`–25; `packages/auth/prisma-auth.ts:12`–30). This happens before either fenced phase. Authenticated capability GET also performs this work, but its task ownership/admission path is unspecified.

Consequently, arbitrarily many concurrent requests can enter or queue authentication transactions without holding any of the four owners. Public timeout/disconnect can leave this work draining outside the owner accounting. The existing authentication helper also receives no remaining original deadline or explicit Ask pool/statement budget. The promise-retention rules for later planner/DB phases do not close this earlier boundary. Applying the eight-second public timeout alone still leaves the physical-work bound untrue.

**Required closure:** Specify a bounded owner before the first asynchronous Ask authentication operation on both enabled routes. One coherent design is a provisional global permit, later bound to the authenticated actor without releasing/reacquiring its physical-work ownership. Keep rolling question charges after positive phase1 authority; define whether/how capability authentication uses actor limits without charging a question. Specify authentication's pool/transaction/statement budgets, retention through confirmed cleanup, and the resulting raw/syntax/authentication/capacity/semantic error precedence. Preserve non-Ask authentication behavior through an Ask-private boundary.

**Closure checks:** Block authentication before phase1 using a real PG barrier and controlled ignored-cancellation seams. Exercise more than four POSTs and mixed capability GET/POST requests, valid and invalid credentials, public deadlines, and disconnects. Prove a fixed maximum of active/queued underlying authentication owners; no replacement work while owners drain; eventual exactly-once release only after actual cleanup; no phase1/read/audit after terminal timeout; no rolling charge for capability/invalid/denied requests. Verify deadline starts before body/guard and is never reset, with fixed AskErrorV1 and no sensitive diagnostics.

### R2 — P2: SOURCE_STATE cannot identify its eligible resource from the specified planner input

**Contract:** `docs/stage5/ask/02_CONTRACTS.md:65`–67, `:106`–108, `:127`, `:131`–133; missing-resource behavior at `03_SECURITY_AND_STATE.md:13`; Q4 at `04_PLAN_AND_ACCEPTANCE.md:35`.

The planner receives focusRef and descriptors containing source/type but no connection identity or server-derived focus-resource relationship. SOURCE_STATE must select exactly the resource matching the focus observation's source/type/connection tuple. Consider focus E1 and resource E2 with the same source/type: one bank has E2 on the focus connection, another has E2 on a different connection while the focus tuple is absent. These inputs are indistinguishable to the planner. Putting the matching tuple first *when present* does not reveal absence. Missing required resources are permitted, and the read explicitly promises no atomic snapshot.

Selecting E2 in both cases turns a legitimate insufficient-evidence case into ASK_PLANNER_INVALID; returning empty refs in both avoids that error but prevents a useful positive SOURCE_STATE answer. The implementer would need to invent an additional relationship channel or weaken the intended supported journey.

**Required closure:** Add a precise server-derived eligibility field, for example `focusResourceRef: ERef | null`, computed only from the validated focus and exact tuple in the finalized bank. Define focusRef as the focus OBSERVATION ref (or null), and define the deterministic mock's SOURCE_STATE selection/empty-ref behavior. Keep connection IDs and other raw identifiers out of planner descriptors. The compiler and browser must retain their independent exact-tuple checks; the new field conveys eligibility, not authority.

**Closure checks:** Paired banks with otherwise identical descriptors but matching versus unrelated connections; multiple connections sharing source/type; missing focus; absent exact tuple with unrelated resources present; and matching MISSING/ERROR/FIXTURE resource states. Require a cited positive result for the eligible fact, INSUFFICIENT for absent eligibility, and rejection of a deliberately injected unrelated ref. Verify the relationship field cannot be supplied by HTTP/browser input and contains only a current request-local ref/null.

## Other assessment and implementation notes

The reviewed design has a sound OFF/MOCK boundary: no external adapter/flag, planner authority, tool fallback or business mutation. The bootstrap parser order and non-Ask goldens are explicit. Whole-source validation precedes mapper repairs; projections, coverage, focus, exact entity identity, claim/cardinality rules, mandatory independent urgency, and browser generation isolation are defined sufficiently apart from R2. The final authority/audit sequence includes post-INSERT expiry and deadline checks, rollback behavior, and unknown-commit limitations. Retaining permits for ignored-abort planner work is correct once R1 covers the earlier work too.

Implementation must bind phase2 to the captured phase1 workspace/client/actor and compare a fence epoch only within that same workspace. Treat `same workspace`/scope revalidation as a captured-scope invariant, not merely agreement between a fresh phase2 hint and its subsequent lookup. A token replacement/rebinding barrier with coincident epochs in two workspaces is a useful acceptance probe. Explicit wording in the implementation brief would remove avoidable ambiguity.

The Ask raw matcher must cover every path spelling that can reach an Ask controller, or reject aliases before the fallback parser; otherwise framework route normalization could bypass the private parser. Include case/trailing-slash/percent-encoding variants in Q1 tests. These are implementation checks, not additional architecture findings.

## Preservation and limits

Both before and after review, `verify_s5ask.py 2` verified all six normative hashes, package hash, exact archive contents/hash, 1,048 manifest working entries, 197 built entries, baseline, dependency seal/closure, HEAD and branch. Independently enumerated the working tree: exactly 1,050 files (the manifest's 1,048 plus its own manifest/archive); built inventory exactly 197. All paths and hashes were identical before/after. Snapshot SHA-256 for both `before.json` and `after.json`: `ade4c4959e424ad8147f5e9690c080928def39b5a53559ba7816b7ae5735f203`; receipt: `PRESERVATION.json` beside this report.

Independently compared the 1,032-entry Ask baseline: exactly the five declared administrative edits, plus the declared Ask docs/evidence additions; no source/test/build/dependency changes. The accepted S5-B manifest/archive verified; its 971 archived files differ only at those five administrative paths, and all 197 built files match. Package/lockfile hashes match the baseline.

This is a read-only architectural/static-source assessment. No tests, builds, database access, browser, network, environment/private configuration or credential inspection was performed. Scratch/report files were written only under `/tmp/atlas-stage5/astra-s5ask-design-rc2/`. Implementation behavior remains unverified and must pass the prescribed actual-code checkpoint gates. A later architecture approval would authorize ASK-A only, conditional on the other named reviewer's approval of the same artifact.
