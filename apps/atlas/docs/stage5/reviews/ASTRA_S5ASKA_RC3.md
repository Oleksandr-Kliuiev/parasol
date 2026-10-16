# ASK-A S5ASKA-rc3 independent acceptance

**APPROVE — ASK-A backend OFF/MOCK only. No required findings remain. R2a and R2b are closed; R1, R3 and R4 remain closed.** This accepts the exact artifact below, not ASK-B, external inference or deployment.

Fresh native task explicitly assigned `gpt-6-astra`, effective effort `xhigh`. The named assignment establishes runtime selection; underlying provider response-model telemetry and attributable subscription usage are not exposed to this reviewer and are not claimed observed. This is independent actual-code acceptance. No implementation repair, original-checkout write, API/credit use, remote inference or deployment was performed.

## Exact artifact and preservation

Repository `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`; HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `planning/stage2-m365`, including the frozen dirty/untracked inventory.

- Package `S5ASKA-rc3`: `213eec92b91a907514161c485258304e197babb42fd5c63da66e3849112f5362`.
- Manifest `verification/stage5/S5ASKA_RC3_MANIFEST.json`: `16957c64efc4b13814dce9edb861328b4ef0d1b7e1e304171b27e359121cb82b`.
- Source archive `/tmp/atlas-stage5/S5ASKA_RC3_SOURCE.zip`: `9cabae880b974acf6953620aa31a5e3b519ae80287b80fadf40dfc12822bd52d`.
- Review brief: `b657735649f1cc0c89465b58bedbfea6862621df91c8c1d1d3437ac2234764e7`.
- Implementation evidence: `569910c5c87a44062b13b82d110f076d3d7140791021425ec2e3de17e90c62dc`.
- Approved six-file architecture: `a9e43a42655ddfea64577d9640fa5778bbf9acf2bd979abdb55e53459a4ab13a`; seal `90b5ad7c598f5b89a193bfd7035efe1539bc13feaf0d9338d7fc7b49425e2c15`.

Before and after review, the identity verifier passed: exact path set, **1125 working files, 215 built files, 1066 archive members**. I inspected its assumptions and independently checked unique/sorted/safe paths, archive-to-working hash correspondence, all extracted source bytes, baseline deltas and all rebuilt bytes. The repair delta is the seven declared changed paths and six added bookkeeping/test/report files, with no removal. All six norms, shared authentication, schema/roles/dependencies and accepted operator/browser source are preserved. All **33 operator built files** match the pre-ASK-A baseline. Scratch and fresh production builds each reproduce all **215** frozen built files. See `identity-before.log`, `identity-after.log`, `independent-identity-details.json`, `preservation.json`.

## Required closure and nearby invariants

**R2a closed.** `packages/ask/phase.ts:45–85` guards every raw and model-delegate call, preserving method receivers, tagged/raw arguments and shared `currentToken` semantics. It checks the run and absolute phase before timeout setup, after that await, and after the actual statement. The timeout is rebound to remaining phase time. The shared auth source remains byte-identical; all its internal awaits now use the Ask-only guarded transaction. This covers private auth, both fenced hints/re-authentication, and denial/final post-INSERT checks.

Independent real-PG delivery-delay matrix (`source/review-all-boundaries.test.ts`, `independent-all-boundaries.log`) visits **every actual SQL/delegate/timeout-setting return** of normal auth/admit/denial/publish: 14/42/36/36 boundaries, each with terminal and original-deadline interruption, **256 cases**. No subsequent statement starts; interrupted audit/denial rows roll back. A separate delayed transaction-cleanup-delivery gate keeps the same owner held; release occurs exactly once after draining. All **nine** digest-setting locations additionally pass the real two-second phase-deadline variant, including phase1/phase2 hints, after-lock token checks and post-INSERT checks. These are eight top-level tests, all passing.

The unchanged prior independent helper reproducer also passes: zero late token SELECT starts and no token SELECT physically waiting on the independently locked ApiToken table. This establishes real SQL behavior with an injected successful-response delivery delay; it does not claim an ordinary HTTP timing reproduction. The exhaustive matrix records driver calls; the physical table-lock probe and packaged physical tests provide complementary PostgreSQL observations. Eleven independent proxy-contract tests verify raw/tagged/model binding, argument identity, timeout rebinding and terminal/original/phase stops during timeout setup and actual statement awaits.

**R2b closed.** `packages/ask/fixture.ts:94–118` checks after deferred demo delivery before either audit append or source access, and checks after authorization before charging. The original two independent fixture probes pass. Packaged deferred-demo denial/publish/admission × terminal/deadline cases and positive controls pass, with no late audit/source work and exact owner settlement. Admission's one charge made *before* its source/demo await remains intentional; there is no new charge after interruption. Fixture evidence is an injected deferred dependency, not normal HTTP scheduling or DB authority evidence.

**R1 stays closed.** The original independent ApiToken→Actor sequential-wait probe returns ASK_DEADLINE at 2002 ms with no remaining Actor wait. The isolated packaged physical auth/admit/publish cases report public failure at **2001/2002/2001 ms** and sampled owner release after runtime drain at **2008/2008/2010 ms**. Final-audit wait rolls back, recovery releases once, the original eight-second deadline remains fixed, and the original disconnect probe starts no Entity query after Observation unblocks. No premature owner release was observed, including in the original rc1 probe; that earlier probe is not recharacterized here.

**R3/R4 stay closed.** Original hidden UNAVAILABLE malformed/4.5 MB snapshot probes return ASK_SOURCE_INVALID/ASK_TOO_LARGE without completion audit. Packaged PENDING/UNAVAILABLE, valid missing/null and source validation/cap cases pass. Malformed percent paths preserve raw→auth→semantic→scope ordering, 401 then authenticated 403 with exactly one workspace denial, including fixture/DB and synchronous HEAD/OPTIONS rejection.

Reviewed Q1–Q6/Q9 and backend Q8 in actual code and focused checks: exact DTO/error/parser aliases; synchronous provisional ownership on both routes; exact actor/rate binding; two confined FOR SHARE phases with captured identity/scope/epoch and DB-clock post-audit checks; no answer on uncertain/failed commit; whole-original source validation before reduction; coverage/focus eligibility; exact compiler matrix with independent urgency; safe audit allowlists and no action/business writes. No additional required finding or norm amendment.

## Independent verification

- Isolated API/UI build, full unit/PGlite/context-budget suite **326/326**, root typecheck: pass.
- Focused Ask units plus prior fixture probes: **48/48** (46 packaged + 2 independent).
- Confined PostgreSQL 17 Ask suite: **47/47** in the isolated copy; prior independent hostile/token probes: **6/6** (the five original failures plus R2a).
- Exhaustive real-PG boundary matrix: **8/8 top-level tests**, 256 terminal/original cases + 9 phase cases; proxy contract: **11/11**.
- Independent negative controls: bypassing the guarded view produces one late SELECT physically blocked at PostgreSQL; removing fixture denial/publish post-await checks produces the corresponding late audit. All three controls fail on concrete assertions. Exact original SHA256 bytes restored; restoration probes **14/14** and all 1066 source/215 build identities match. See `negative-controls.py`, `negative/results.json`, individual logs and `negative/restored.log`.
- Independently verified hashes/lengths of **52** durable supplemental files and assessed all **14** implementer check logs, including **326 unit, 616 PG, 50 browser** passing. Those full PG/browser totals are inspected bound implementer evidence, not a claim that this reviewer reran those entire suites. Existing repair controls contain real failures and restoration proof.
- Fresh independent production copy from the sealed archive: offline `npm ci`, generate, build and offline production prune pass. Foreign-cwd OFF gives clients200/Gateway201/Ask404. MOCK+console gives capability200 with correlation/CSP/no-store, cited AskAnswerV1 with independent urgent ref, wrong-Host421, and **32/32 served asset hashes**. All **215** built files equal the frozen artifact. `production-proof.py`, `production/results.json` and logs preserve this local smoke; it is not a deployment.

Setup qualifications are preserved rather than counted as product failures: the silent PG wrapper enters a fixed cwd, so the first 47-test invocation read identical frozen checkout bytes; two subsequent relative-file launch attempts failed before tests. Absolute scratch runners corrected this, and both reviewer probes and the complete 47-test Ask suite were rerun isolated. An archive lacks `.git`, causing the unrelated protected-output unit test to create its synthetic `never-written.json`; after adding a scratch Git marker, that leftover caused a second setup failure. Inspecting the exact test diagnosed both; the synthetic file was moved to `setup-never-written.json`, the focused test passed, then all 326 passed. Original checkout/build/dependencies remained untouched and passed the final identity check.

## Residual limits

Physical proof covers measured lock-wait cancellation, transaction rollback and selected delayed delivery/cleanup orderings. Promise settlement or the phase timer alone does not prove arbitrary engine/pool/network cleanup; no such guarantee is claimed. The timer does not release the owner, and unsettled held work retains capacity. Per-process quotas, ignored-abort retention, shared-fence contention, non-atomic multi-query reads and unknown-commit no-answer behavior remain explicit limits.

Existing documented post-compilation oversized-answer 413 with `ask.failed/ASK_TOO_LARGE`, display marker, phase1 freshness clock, ENTITY descriptor enums and generic-parser logging qualifications remain unchanged. No external inference, real tenant/vendor, deployment or ASK-B/browser Ask journey is accepted here. All review subprocesses/servers finished; completed PG cleanup hooks dropped their disposable databases. Full local evidence/probes are indexed by `EVIDENCE_INVENTORY.json` beside this report.
