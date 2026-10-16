# Independent acceptance review — S5ASKREMOTE-REVAL-SERVER-RSC-C-rc1 (RS-C part C)

Date 2026-10-12. Artifact: manifest `verification/stage5/S5ASKREMOTE_REVAL_RSCC_RC1_MANIFEST.json` (sha256 `6b46220f…`), packageHash
`5fe179ea…`, report `IMPLEMENTATION_REPORT_C.md`, checks `S5ASKREMOTE_REVAL_RSCC_RC1_CHECKS.json`.


- **Reviewer.** Native Claude `claude-opus-5-5`, launched through the Claude Code Agent tool with a fresh context, at the requested
  effort `max`; the effort setting cannot be confirmed from inside the session. Disclosure (same as the RS-C-A/RS-C-B reviews): the
  scratchpad path of this session carries the host session id `d0382327-d726-4375-8d23-49e794437702`, which
  `IMPLEMENTATION_REPORT_C.md` names as the implementer session. I had no implementer conversation and no other reviewer's verdict.
  To look for baseline copies I listed and hashed the files under that session's `~/.claude/file-history/`; none matched a baseline
  hash and I did not read their content.
- **Gate.** Owner policy 2026-10-11: one native Opus 5.5 `max` review per RS-C part is the acceptance gate.
- **Normative basis.** SERVER-DESIGN-rc4 `04_TRANSIENT_HANDOFF.md` (whole file), `03_FIXTURES_AND_CLOCK.md` (FX10, "all 200 case
  paths", switch procedure), `05_PROOFS_AND_ACCEPTANCE.md` (RS-C, Browser focus, Browser generations, Handoff, GO integration,
  Integration), `06_LOCAL_PROTOCOL.md` where referenced. Accepted console contracts `docs/stage5/03_SECURITY_AND_STATE.md`,
  `apps/operator/AGENTS.md` (incl. the ASK-REMOTE R-C rules). Parents: RS-C-A rc2 and RS-C-B rc3 seals (`carriedToRSCC`) and their
  reviews. The implementer brief `IMPLEMENTATION_BRIEF_C.md` was judged against the architecture, not taken as approval.

Verdict: CHANGES_REQUIRED

Two required (P2) findings, no blocking (P1) finding. Everything else checked holds, including all 200 case paths (re-run
independently), NB7, the carried server fixes, the identity candidate layer and an ordinary console that stays byte-identical.

## 1. Identity (recomputed)

| Item | Result |
|---|---|
| Manifest file `S5ASKREMOTE_REVAL_RSCC_RC1_MANIFEST.json` | sha256 `6b46220f9c70b7886d54df01761f72d83e52aa1c02d9bee1605a5e7d734196af` — matches |
| Baseline file | sha256 `fffb3c52…8f3f8a9b5b` = manifest `baselineFileSha256`; 2051 entries; `baselineHead` `916a4d69…` = git HEAD |
| Delta (`git ls-files -co --exclude-standard` vs baseline) | 17 changed, 47 added, 0 removed. 23 added files are excluded by the rule (the baseline file, the RC1 manifest/checks and 20 evidence logs) |
| Package sets | changed 17 and added 24: exactly the manifest's `changed`/`added`; all 41 per-file hashes (and the 17 baseline hashes) match |
| packageHash (rule in the file) | `5fe179ea9fcdb7e23c4242b822c8734bc411ac7b47a209e855b94df5cf99c74b` — matches |
| Checks receipt | all 20 log hashes match; `exits.txt` = unit 1 (the RC5 identity-only set) and every other check 0 |
| Clean rebuild (copy, `npm run api:build`) | `dist/` identical to the checkout (except `dist/native`, which `api:build` does not produce); ordinary console manifest `e18fe8d4…` (same as the RS-B/RS-C-A/RS-C-B builds); measured manifest `48b20df9e383e7540fb05f9e4b9a723d6659ddc8987d625c6ebd43767a13f13f` |
| Ordinary console vs accepted R-C | all 42 `dist/operator/*` files equal the R-C RC1 `builtInventory` exactly; no `apps/operator/src` file is in the delta |
| Instrument `artifact-check` (checkout and clean copy) | `ok:true`, `drift:[]`, 1995 files; candidate `RS-C-C` sha256 `05d49a7259b0092bd45937d8427592c07a0eb904696595a9a937b29a4698bcd4`, `accepted:false`; `executionToolSha256` `6c7da68d…` (= `rerun-artifact-check.txt`) |

## 2. Findings

### F1 — P2 — The bridge serves the measured console without the accepted console boundary on its API paths
- **Where.** `apps/api/src/reval/evaluation.ts:99-102`: the accepted `operatorMiddleware` (Host gate and security headers) runs only
  for `/operator` paths. `tests/pg/reval-eval-console.pg.test.ts:38-42` asserts this ("no console headers on API paths").
- **Norm.** `docs/stage5/03_SECURITY_AND_STATE.md:5-9`: while the console is served, "requests must have Host exactly
  `127.0.0.1:<configuredPort>`; reject other hosts before static/API dispatch" (the DNS-rebinding defence), and line 22-23: console API
  requests also get no-store. 04:320 for the handoff route: "Retain existing private bearer, Host and no-store boundaries". The
  accepted serving (`apps/api/src/operator/http.ts:32-49`) gates and decorates every path; `tests/pg/operator-http.pg.test.ts:85-120`
  requires 421 for `/clients` and `/clients/:id/overview` with `rebind.example:<port>`, and "a refused Host never reaches
  authorization or its audit". The brief §1.2 promises the accepted "Host/header middleware"; report §2 narrows it to `/operator`.
- **Evidence (probe on the built in-process bridge S, Docker PG17).** `GET /clients` with `Host: attacker.test:<port>` and a valid
  bearer → 200 with the client list and no `Cache-Control`; on the accepted console-enabled server the same request is 421
  (asserted by `operator-http.pg.test.ts:94-99`, which passes in my test:pg run).
  `GET /operator/` with that Host → 421. A registered-scope Ask POST with that Host and no session header → 503 and
  `rejectedUnpairedCount` 0→1 (a rebinding page reaches the measured counters before any Host check).
- **Impact.** Defence in depth only: a rebinding page cannot obtain the bearer (closure only, `credentials:'omit'`), and the handoff
  route and the evaluation gate keep their own exact Host/Origin checks. It is still a weakening of an accepted console contract,
  which the measured build may not weaken.
- **Required fix.** In bridge mode, apply the accepted console boundary to every request, as the console-enabled ordinary server does:
  the Host gate before static/API dispatch, and the headers on every response. Keep the fixed 400 for the evaluation header on
  console paths; for example, run the accepted `operatorMiddleware` for non-console paths before the header middleware, and leave
  the console-path install where it is. Adjust the tests that now expect 400 for a wrong Host on the handoff/Ask paths (421 then
  comes first; an invalid Origin stays 400). If the RS-C-A fixed-400 statuses on those two paths must stay, gate every other path
  with 421 and keep the headers. Or obtain an explicit architecture decision that exempts the bridge API. Add a test with a rebinding
  Host on `/clients` and on the Ask path.

### F2 — P2 — The pane's current completions do not apply the accepted current-error rules (04 table row "Current matching completion")
- **Where.** `apps/operator/measured/eval-controller.ts:136-150`: of the evaluation Ask's current failures, only `UNAUTHORIZED`
  disconnects, and only a 503 `ASK_REMOTE_NOT_ADMITTED` without a receipt ends the pair. A current 403 and a current 409
  `ASK_REMOTE_POLICY_CHANGED` change nothing else. `:93`: a current PAIR 401 is a fixed code only, with no disconnect. Brief §3 dropped
  the clause (`IMPLEMENTATION_BRIEF_C.md:104`).
- **Norm.** 04:167 "May show only its eligible answer/error and handoff; **apply existing current-generation error rules**".
  `03_SECURITY_AND_STATE.md:30` "401 on a current request disconnects globally"; `:34-35` "This full scope reset is deliberate for
  EVERY current 403"; `apps/operator/AGENTS.md:62` "a CURRENT validated 409 ASK_REMOTE_POLICY_CHANGED clears input/answer/consent and
  marks Ask unavailable with only a manual refresh".
- **Evidence (unit probe on the accepted controller + measured holder, temporary copy).**
  - After a current 409 `ASK_REMOTE_POLICY_CHANGED` the pane stays `PAIRED`, the console capability stays `REMOTE` with the stale
    disclosure, and an immediate type→choose→consent→Ask SENDS a second request with the same stale acknowledgement (2 Ask POSTs).
  - After a current 403 the pair and the selected scope stay (`selection c-db`, `session READY`).
  - After a PAIR 401 `UNAUTHORIZED` the session stays `READY`.
- **Impact.** The server stays authoritative, and the run is already terminal after a claimed-arm failure. But the pane invites
  further submits with a stale scope or tuple, which the gate counts as duplicate/integrity events, and nothing tells the operator
  that the capability is stale. In the measured build the only capability refresh is a reconnect (the accepted Ask panel is masked).
- **Required fix.**
  - Current 403 on the evaluation Ask: apply the accepted full scope reset plus one picker refresh, or at least end the pair, clear the
    pane and require a deliberate client reselection, if mirroring the reset needs an accepted-`src` change.
  - Current 409 `ASK_REMOTE_POLICY_CHANGED`: end the pair, clear the pane and block consent/submit until a fresh capability exists. In
    this build that is a new credential epoch, so state "reconnect to refresh" in fixed text and in the RUNBOOK.
  - Current PAIR 401: disconnect.
  - Add unit tests. Alternatively, record an explicit architecture waiver of this clause.

### F3 — P3 — Pane edge cases that cost evidence or show a stale pair
- A refused Ask click after an eligible completion (`eval-controller.ts:121`; the button is only `aria-disabled`,
  `view-eval.ts:85`) sets `send:'NONE'` and clears the answer. The evidence can then never be sent, so the case becomes
  `LOCAL_HANDOFF_UNVERIFIED`. Probe: `sendBefore=AVAILABLE`, refusal `EMPTY`, `sendAfter=NONE`, 0 RESPONSE sent. Suggest keeping the
  completion and handoff on a local refusal (a refusal is not an event of the 04 table), or disabling Ask until an edit.
- RESPONSE codes for which the server revokes the pair (`packages/reval/eval-handoff-route.ts:105-109`: authority codes such as `SCOPE_MISMATCH`, plus
  `ADMISSION_NOT_ACTIVE`, `POLICY_CHANGED`, `FIXTURE_MISMATCH`) leave the pane "Paired until …" (probe). Only `PAIR_REVOKED`,
  `PAIR_EXPIRED` and `UNAUTHORIZED` end it (`:164`).
- The 503 `ASK_REMOTE_NOT_ADMITTED` path ends the pair, and that clears the error at once (`status:'IDLE'`). The operator never sees the
  refusal code.

### F4 — P3 — Test-strength gaps (code correct by inspection)
- I ran 20 unit mutations of the pane: 14 were detected. Of the 6 survivors, one is an equivalent redundant barrier (not nulling the
  private handoff reference after a send; the `send` state already blocks a second send). Five show untested properties:
  - stale PAIR completion;
  - stale RESPONSE completion;
  - the pair-expiry timer;
  - an invalid 200 with a receipt must not be handoff-eligible;
  - a stale 401 must not disconnect.

  For the last one, the "late answer/error/401" tests never deliver the late value: `bounded()` settles the aborted exchange as
  `NETWORK` first (`apps/operator/src/transport.ts:127-131`). Already-resolved stale values are untested.
- No test asserts that C's build manifest covers `dist/operator-measured` (`packages/reval/launch.ts:48`; grep finds no assertion).
- External invalidations and stale completions are tested at unit level only. Nothing checks the new panel's layout (the accepted
  console has visual checks at 320/768/1440 px).
- FX10 `hasFocus:false` is derived, not asserted on the wire: no focus fact plus `focusExtra:false` (`tests/ui/eval-200.spec.ts:60-62`)
  implies a non-FOUND focus, and so `focusRef = null` (`packages/ask/projection.ts:61,77`). The scripted provider capture could assert
  it directly.

### F5 — P3 — Report/receipt accuracy and carried items
- `IMPLEMENTATION_REPORT_C.md:7` says the brief "is in the baseline". It is not: the manifest lists it under `added`.
- `S5ASKREMOTE_REVAL_RSCC_RC1_CHECKS.json:63` says "no file used by test:ui changed afterwards", yet
  `scripts/reval-instrument/candidate.ts` changed afterwards (05:50). It is in the test:ui import closure
  (`tests/support/eval-browser.ts:6,20` → `identity.ts` → `candidate.ts`). The change cannot affect the browser path, and my re-run
  covers it, but the statement is inaccurate.
- An RS-C-B `carriedToRSCC` item is neither delivered nor re-carried: "seal a build inventory for RS-B/RS-C-A/RS-C-C outputs so rebuilt
  outputs can be pinned instead of recorded". The "swept vs expired-uncollected" item is re-carried without a destination.
- NB7 reports the ARM_CASE round trip only (`scripts/reval-instrument/run.ts:167-174`). The PRE→ARM interval inside C's 2 s PRE-age
  bound (verify plus fsync), which RS-C-B carried explicitly, is exercised by the six successes but not measured or reported.
- `candidate.ts` derives 7 phantom `dist/apps/operator/measured/*.js` entries; they are recorded as `MISSING` and folded into the
  digest. This is harmless, but the measured outputs actually live in `dist/operator-measured/`, which the recorded
  `manifest.json` covers.

## 3. What was confirmed

- **Measured build.**
  - It is separate and flat, with an exact manifest. It contains `main-measured.js` and no `main.js`.
  - It passes the accepted forbidden-construct scan, plus a storage scan (`eval-artifact.spec`).
  - Its `index.html` has no inline code and balanced markup. CSP is enforced on the served assets.
  - The ordinary build is byte-identical to the accepted R-C inventory and contains nothing of the pane.
  - Only the bridge serves the measured build, only under `/operator` (the ordinary server is unchanged). Missing assets exit 44
    before listening (test and code path).
  - C's build manifest includes `dist/operator-measured`.
- **Holder (`credential-measured.ts`).**
  - Bearer and session token live in one closure. There is no getter or serialization.
  - Exactly three new network operations: PAIR without the session header, evaluation Ask with it, RESPONSE with it.
  - Fixed fetch options. Nothing is sent without a credential, a path, a valid body or a session.
  - A credential change drops the session.
  - Bodies equal 04 exactly and pass the server's strict decoders (parity test).
- **04 table.**
  - Rows typing, selection, edit-after-selection, consent, submit (capture then clear, without self-invalidation), external
    invalidation (pair kept for context/queue/page/filter/selection; ended for credential, client or capability) and stale completion
    follow the code and the tests.
  - 14 of 20 mutations are detected: a stale Ask completion applied; a submit that invalidates itself; an edit that keeps the choice;
    a choice that clears the draft; the pair kept on a credential/client/capability change; consent without a choice; a submit that
    ignores the boxes as shown; queue/context changes that do not invalidate; the session header on the ordinary REMOTE operation;
    a credential replacement that keeps the session; PAIR200 extra keys; a 503 that keeps the pair; a recorded request that differs
    from the sent body; RESPONSE without the session.
  - "Current completion" deviates (F2).
- **Pairing.**
  - Manual only, with no probe (real browser).
  - Exact PAIR200 validation, mirrored by the server decoder.
  - The pair is lost on expiry (timer), on a 503 NOT_ADMITTED without a receipt, and on a RESPONSE PAIR_REVOKED/EXPIRED/UNAUTHORIZED.
- **Handoff.**
  - The exact parsed body, status, correlation and receipt of the current completion only.
  - One manual send; 204 is not shown as a commit.
  - An eligible AskErrorV1 with a receipt can be handed off.
- **Server fixes.**
  - `nextAck`: a timer expiry is `ACK_WAIT_EXPIRED` → 504 DEADLINE, and close → IPC_LOST. There is no TDZ or race in `Link.nextAck`.
- **N1 matrix (probes).**
  - Unrecognized → 404; HEAD/OPTIONS on Ask → ordinary 404.
  - OPTIONS on recognized routes → ordinary 404, the same as without the header.
  - Recognized routes, including case and trailing-slash variants and HEAD, and console paths → fixed 400 with no-store and a
    correlation id.
  - No silently accepted route found. Behaviour outside bridge mode is unchanged (main.ts and ask-http unchanged; the
    evaluation.ts imports have no side effects).
- **Identity.**
  - All 17 changed chain files are enumerated, and no unlisted chain file changed (`artifact-check` ok).
  - The RS-C-B rc3 anchors bind by path and hash, plus seal status and manifest.
  - Post-seal equality (`CANDIDATE_SEAL_MISMATCH`) is sound for the candidate phase.
  - The receipt v3 allowlist requires `revision.candidate {id:'RS-C-C', sha256, accepted}` and the 9 anchors.
  - The RC5 guard enumerates exactly `RSCC_SOURCE_DELTAS` (the map and `operator-build.ts`, with R-C old hashes) and one overlay; every
    other overlay stays at its pin.
- **Proofs.**
  - **200-path E2E.** The real browser drives the sealed pane, with the real `receiveTransfer` against the frozen case. The test plays
    C through the hub methods; the provider is scripted to the frozen intent, so "semantic MATCH" is an executability proof, not a
    model result (honestly disclosed). Paced at ≤10 per 61.5 s. All 15 FX10 cases send `syn-obs-not-found`.
  - **NB7.** Real O/C/S plus the RS-C-B code under a PTY; pre/post-consumption injections behave as claimed. Its reordered corpus is
    test-only; production builds the order from `bindCorpus` unchanged (`operator.ts:74,129`).
- **No key or provider path.** The new and changed code has no env, key or URL use. The bridge seams still resolve no key.
- **OPEN decision (report §4).** It is factual: the RS-B switch refuses with any other backend
  (`packages/reval/inventory.ts:76-81`), and 04:111 stops a run on S restart. It is not an RS-C-C defect; see §5.

## 4. Commands (temporary copies under `/private/tmp/rscc-review-opus`, deleted afterwards)

| Command | Result |
|---|---|
| Identity script (`git ls-files -co --exclude-standard` vs baseline; packageHash rule; per-file hashes; receipt log hashes) | all match (§1) |
| `npm run api:build` (copy) + `diff -rq dist` | identical; manifests `e18fe8d4…` / `48b20df9…` |
| `cli.ts artifact-check` (checkout; copy with `dist/native`) | `ok:true`, `drift:[]`, candidate `05d49a72…` |
| `npm run typecheck`, `ui:typecheck`, `tsc -p apps/operator/tsconfig.measured.json --noEmit` | pass |
| `node --test tests/operator-eval-*.test.ts tests/reval-eval-runtime.test.ts tests/reval-instrument-identity.test.ts tests/reval-rc5-guard.test.ts` | 20 pass, 1 skipped (historical view) |
| `node --test tests/*.test.ts` (copy) | 579: 570 pass, 8 fail, 1 skipped. The 8 are the RC5 identity-only set (`CORPUS_IDENTITY_MISMATCH`), the same names as `rerun-unit.txt` |
| `ATLAS_REVAL_NATIVE_PG_FIXTURE=… npm run test:pg` (copy) | **775/775** (259 s); NB7: 8 attempted, 6 ok, 1 before (unconsumed), 1 after (consumed, stopped); ARM p50 12 / max 13 ms; READY ≤1 ms; GO→COMMIT p50 384 ms |
| Playwright `eval-pane.spec.ts`, `eval-artifact.spec.ts` (copy) | 3/3 |
| `ATLAS_REVAL_E2E_200=1` Playwright `eval-200.spec.ts` (copy, independent re-run) | **1 passed (19.7 min): 200 COMMITTED, semantic MATCH, truth true, FX10 MISSING 15, 1177 s** |
| `npm run test:ui` (copy, without the 200-path flag) | 89 passed, 1 skipped (the flag-gated 200-path) |
| Server mutation (copy): remove the global header guard, rebuild, `reval-eval-console.pg.test.ts` | N1 test fails (detected); restored |
| PG probes (built in-process bridge S): N1 edges, rebinding Host on API/console/Ask paths | as in F1 and §3 |
| Unit probes (current 409/403/PAIR 401; refused click; RESPONSE revoking codes); 20 unit mutations | as in F2–F4 |
| `atlas*` DB/role census (Docker) and native cluster census, before and after; leftover processes | Docker 14 DBs / 148 roles unchanged; native 0 DBs / 1 role; no test, server or browser process left |

I did not re-run `schema:validate`, `db:check:pg17`, `db:check:drift` or `api:smoke`, because the delta touches no `prisma/` file.
The receipt's logs for those checks hash-match.

## 5. Residuals and notes for RS-D

- **OPEN architecture/owner decision (blocks any admitted run, not RS-C-C).** The frozen interleaved order (03:65) cannot run in one
  admitted run: the accepted RS-B switch needs every other backend gone, and 04:111 stops the run when S restarts. Route this to the
  architecture gate (Astra/Fable xhigh) before RS-D integration. The options are those listed in report §4, and each changes run
  semantics.
- **Seal.** The RS-C-C seal must carry `candidateSha256` of the finally accepted bytes. For rc1 as reviewed it is `05d49a72…`; repairs
  change it. After the seal, `docs/RUNBOOK.md` and `docs/AI_CONTEXT_MAP.md` are pinned through the candidate digest, so the next
  part must pin the RS-C-C manifest and declare administrative deltas, or any routing edit refuses the instrument.
- **Still carried.**
  - Provider key pass-through (PENDING).
  - T2.
  - ATTESTED admission/capability/stage/consent.
  - macOS `F_FULLFSYNC`.
  - The swept vs expired-uncollected `OBSERVATION_UNAVAILABLE` distinction.
  - The optional binding of the receipt to C's `buildManifestSha256`; S's own IDENTITY still reports zeros, so `loadedBinding` stays
    UNVERIFIED.
  - The build-inventory pinning (F5).
  - PROCESS_CENSUS, DRAIN and POST census.
  - Egress/privacy/platform proofs, including browser profile, clipboard and recording sinks, and Private Network Access.
- **Census notes for RS-D.** Registered-scope submits without the header are counted before any Host/Origin check (RS-C-A design). Even
  with F1 fixed, a cross-site simple POST can still raise `rejectedUnpairedCount`. Evidence reads from the measured console write
  ToolExecution/audit rows in the sandbox, and the POST census must expect them.
- Docker PG17 = regression evidence; native = test-fixture evidence; nothing was MEASURED. Paid/provider calls: 0. Data/budget: NOT_ADMITTED.


---

## rc2 re-review — S5ASKREMOTE-REVAL-SERVER-RSC-C-rc2 (bounded, same reviewer session)

This is a bounded re-review of the rc1 findings F1–F5 and of regressions in the rc1→rc2 delta. The reviewer and the disclosure are
the same as above: there was no implementer conversation and no other reviewer's verdict. Date 2026-10-12.

Verdict (rc2): APPROVE_RS_C_C

F1–F5 are closed (F5 apart from the residual report text, N1). There is no P1 or P2 finding. The new items are optional P3s or notes.

### R1. Identity (recomputed)

| Item | Result |
|---|---|
| Manifest `S5ASKREMOTE_REVAL_RSCC_RC2_MANIFEST.json` | sha256 `ecc2030a29c4ddf8ecd8338e9a64547e9c7112cbfe65707ae0a5de9703feb0c1` — matches |
| Delta vs baseline (`fffb3c52…`, same rule) | 19 changed + 26 added = exactly the manifest sets; all 45 per-file hashes match; 0 removed |
| packageHash | `79bb82ab75df883c818c9ef42c2b49f0e5c7d272fa0894cc3db9756a8145cba1` — matches |
| rc1→rc2 | 21 package files changed (incl. `scripts/reval-instrument/run.ts` and `tests/pg/reval-eval-handoff.pg.test.ts`, both newly changed against the baseline); 2 tests added (`tests/operator-eval-errors.test.ts`, `tests/reval-measured-build.test.ts`); nothing removed |
| Checks `S5ASKREMOTE_REVAL_RSCC_RC2_CHECKS.json` | sha256 `92a5b7cc…` — matches; all 15 log hashes match. Every package file predates the check window, so no file changed after the run |
| Clean rebuild (copy) | `dist/` identical to the checkout; ordinary manifest `e18fe8d4…` and `dist/operator` = R-C RC1 `builtInventory` (42/42); measured manifest `0884c6d5f5c5cf1854f237efd8e6fb5aceaf98b61743cb197fa2560a1908e05c` |
| `cli.ts artifact-check` (checkout and clean copy) | `ok:true`, `drift:[]`, 1995 files; candidate `RS-C-C` `906a5db03e9e0f55c1c583f9a4fd4293c552abc09a84bf918696975bbeb58238`, `accepted:false`; `executionToolSha256` `e7359786…` (= rc2 evidence) |
| Candidate list | 37 entries. All 19 changed chain files are present, and every listed source is a changed or added package file. No entry is missing, so there are no phantom `dist/` paths |

### R2. Closure of the rc1 findings

| Finding | Status | Evidence (rc2) |
|---|---|---|
| F1 P2 console boundary | **CLOSED** | `evaluation.ts`: the accepted `operatorMiddleware` runs first for every non-console path; console paths take header rule → gate → assets. Probes on the built in-process bridge S: `/clients` and the guard 400/Nest 404 carry `no-store`, CSP and `X-Frame-Options`; a rebinding Host gets 421 on `/clients`, `/ask/capabilities`, the Ask POST, PAIR and an absolute-form target. A rebinding Ask leaves every gate counter unchanged, while a correct-Host unpaired Ask is still counted. The N1 matrix is unchanged: OPTIONS on recognized routes → 404, recognized → 400, unrecognized → 404. Tests: `reval-eval-console.pg` and `reval-eval-handoff.pg` (wrong Host → 421) |
| F2 P2 current-error rules | **CLOSED** (403 by the alternative allowed in rc1) | My rc1 probes re-run on rc2: after a current 409 `ASK_REMOTE_POLICY_CHANGED` the pair ends, block `POLICY_CHANGED`, the resubmit is refused (1 Ask POST only), and the block lifts only after a reconnect; after a current 403 the pair ends, block `SCOPE_REFUSED`, one picker refresh, and the block lifts on a deliberate reselection; a PAIR 401 disconnects. RESPONSE 401 → disconnect; RESPONSE 403/`SCOPE_MISMATCH` → 403 path. The fixed text and RUNBOOK state "reconnect to refresh" |
| F3 P3 edge cases | **CLOSED** | A refused click after a completion keeps `READY`/`AVAILABLE` and the send still goes out. RESPONSE `SCOPE_MISMATCH`, `POLICY_CHANGED`, `ADMISSION_NOT_ACTIVE`, `FIXTURE_MISMATCH` and `INTERNAL_FAILURE` end the pair, and the policy codes also block; `IPC_LOST` and `RAW_EXPIRED` keep it. A 503 `NOT_ADMITTED` refusal stays visible |
| F4 P3 test gaps | **CLOSED** | New tests: stale PAIR/RESPONSE completions, already-resolved stale values (abort disabled), expiry timer, invalid 200 + receipt, build-manifest coverage, layout 320/768/1440, `{question, hasFocus}` on the wire for every case. 19 unit mutations: 16 detected, including all non-equivalent rc1 survivors except the stale-PAIR one. Of the 3 survivors, two are redundant guards: the PAIR completion's generation check (`adoptSession` also refuses a stale credential epoch) and `tupleReady`'s block test (the pair is already null). The third is the phantom-path regex, which is cosmetic and untested |
| F5 P3 accuracy / carried items | **CLOSED, apart from N1** | Brief wording fixed; the receipt claims nothing that changed afterwards. Build inventory and swept-vs-expired are re-carried to RS-D. NB7 reports PRE→ARM (`preToArmMs`; mine: min 71 / p50 85 / max 122 ms vs the 2 s bound). Candidate derivation is limited to `apps/api|packages` |

### R3. New items (all optional)

- **N1 — P3 — The rc2 report still carries rc1 statements in §1–§2.**
  - `rs-c/IMPLEMENTATION_REPORT_C.md:57-58` "Console boundary only on `/operator` in bridge mode … the handoff route's own Host check still
    answers 400". This is now false: 421 comes first.
  - `:30` "with the accepted console boundary on those paths".
  - `:55` pair loss only on `PAIR_REVOKED/PAIR_EXPIRED/UNAUTHORIZED`.
  - `:21` "Manifest and checks … `RSCC_RC1_{MANIFEST,CHECKS}`".

  These contradict §0, brief §5 and the code. Update them or mark them superseded.
- **N2 — P3 — The evaluation-header refusal on `/operator` paths is written before the console middleware.**
  - Probe: `GET /operator/` with the header → 400 with `no-store` but without CSP, nosniff or `X-Frame-Options`. With a rebinding Host
    it is still 400, not 421.
  - This is disclosed as "Bridge-only Host order". Nothing is dispatched. Optionally, set the console headers on that refusal too.
- **N3 — note.** After a pair-ending RESPONSE refusal the pane keeps the answer visible with `send:'FAILED'`. 04 lists pair revocation
  as an external invalidation that clears the answer. No handoff remains, so this is display only.
- **N4 — note.** A RESPONSE 401 also means "session token not current" (`packages/reval/eval-handoff-route.ts:101`). A pair already
  ended by the server therefore now disconnects the console: stricter than needed, but fail-closed.
- **N5 — note.** Receipt v3 gained a required case key (`preToArmMs`) without a schema-name change, so RS-C-B-era v3 receipts no
  longer validate. No admitted receipt exists; version the schema in RS-D.

### R4. Commands (rc2; temporary copies under `/private/tmp/rscc-review-opus`, deleted afterwards)

| Command | Result |
|---|---|
| Identity script, receipt log hashes, file mtimes vs check window | as in R1 |
| `npm run api:build` (copy) + `diff -rq dist` | identical; manifests as in R1 |
| `cli.ts artifact-check` (checkout, copy) | `ok:true`, candidate `906a5db0…` |
| `tsc --noEmit` (root, operator, measured) | pass |
| Focused unit (`operator-eval-*`, `reval-measured-build`, `reval-eval-runtime`, `reval-instrument-*`, `reval-rc5-guard`) | 40: 39 pass, 1 skipped |
| `node --test tests/*.test.ts` | 587: 578 pass, 8 fail, 1 skipped. The 8 are the RC5 identity-only set |
| `ATLAS_REVAL_NATIVE_PG_FIXTURE=… npm run test:pg` | 775: 774 pass. The 1 failure is `reval-launch-controls.pg` "R1 initial physical binding stall", an RS-A file RS-C-C does not touch: an O-side output-line race under load, 3/3 focused (5/5 each). The receipt's two failures (`action-late` C2/C6, `m365-privacy-retention`) pass in my run. NB7 8/6/1/1 |
| `ATLAS_REVAL_E2E_200=1` Playwright `eval-200` + `eval-pane` + `eval-artifact` | **4 passed (19.7 min): 200 COMMITTED, semantic MATCH, truth true, FX10 MISSING 15, 1177 s**, with the per-case `{question, hasFocus}` wire check and the layout check |
| `npm run test:ui` (without the 200 flag) | 89 passed, 1 skipped |
| PG probes (bridge boundary, N1 edges, refusal headers); unit probes (409/403/PAIR 401, refusal, RESPONSE codes, 409 + receipt); 19 unit mutations | as in R2/R3 |
| Census, Docker and native, before and after | See below. Native 0 DBs / 1 role. No leftover processes |

On the Docker census:
- At the start of rc2 the cluster had 15 `atlas*` databases and 157 roles; one database, `atlas_it_5fc1bd0e`, was left by the
  implementer's rc2 m365 failure.
- After my rc2 PG run, the 13 leftover `atlas_it_*` databases were no longer present (2 databases, 157 roles). I issued no DROP, and
  the test harness drops only the databases it created, by name or by its own owner role. They were removed outside this review.
- My runs left nothing.

### R5. Residuals (unchanged unless noted)

- The §5 residuals above still apply, including the OPEN frozen-order decision and the RS-D items.
- **Seal.** For rc2 the `candidateSha256` is `906a5db03e9e0f55c1c583f9a4fd4293c552abc09a84bf918696975bbeb58238`.
- **Flaky tests.** Timing-sensitive tests in other areas flake under load: `action-late` C2/C6, the `m365-privacy-retention` seed and
  the RS-A `reval-launch-controls` R1. Each passes when run focused. This is test-hygiene work for a later checkpoint.
- No paid or provider call, activation, key, account or deployment.
