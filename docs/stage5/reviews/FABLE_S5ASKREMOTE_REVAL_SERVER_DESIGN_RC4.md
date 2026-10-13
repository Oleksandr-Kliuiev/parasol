# Fable 5.1 / xhigh — bounded repair re-review: S5ASKREMOTE-REVAL-SERVER-DESIGN-rc4

Reviewer: native `claude-fable-5-1` / `xhigh`, SAME independent session as my RC2 review (`34e9b516-d470-4837-9a77-5f570a3feec5`). Bounded re-review of my own RC2 verdict against the exact new identity. The RC3 request was interrupted before any verdict; no RC3 approval exists or is reused. Scope reviewed here: the WHOLE RC2→RC4 delta (RC3 changes plus the RC4 clarification), using the sealed RC2/RC3 ZIP bytes as the diff baseline. No other reviewer's verdict, historical review report or `DESIGN_STATUS.md` was read. Read-only; no repo write, DB, network, provider, activation or paid call. Only this file was written.

## Verdict

**APPROVE_ARCHITECTURE** for `S5ASKREMOTE-REVAL-SERVER-DESIGN-rc4`, packageHash `9fa16222d6c32c18d4d193b6666e078fd3624a4bdb2ccb8ab9fbd68113b08163`. Required (blocking) findings: **0**. The delta is a bounded repair: same architecture intent and trust boundaries, no DTO/command/envelope change, no lock-order, financial, authority, consent or privacy rule change, no corpus/execution-predicate/runtime change, no new proof claimed. It closes NB1, NB2, NB3, NB4, NB6 and NB8 of my RC2 review, leaves NB5 and NB7 as declared implementation-brief obligations, and repairs two RC2 defects (one internal contradiction, one unreachable browser state) that my RC2 review did not flag. Two new non-blocking wording items (NB9, NB10) are for the RS-C brief; neither alters an invariant.

Still architecture agreement only: not code/evidence acceptance; execution RC5 and its repairs are not accepted here; `verifiedPass`/`liveAcceptanceEligible` unchanged; no data, budget, account, key, paid inference, LIVE or deployment admission. Future source/build/migration/role/transport work needs owner scope and dual Sol/Opus acceptance with reseal.

## Artifact identity (verified by me)

| Item | Result |
|---|---|
| `verification/stage5/S5ASKREMOTE_REVAL_SERVER_DESIGN_RC4_MANIFEST.json` | `packageHash 9fa16222…b08163` reproduced (sha256 of compact JSON of path-sorted `{path,sha256}` entries); 38 entries; `DESIGN_STATUS.md` administratively excluded (not read) |
| Working tree at HEAD `916a4d6` | 38/38 hashes match; reval-server directory still untracked (draft) |
| Dependencies | 29/29 non-reval entries byte-identical to the RC2 manifest; `DEPENDENCY_REFERENCES.json` 29/29 match, artifact label `rc4` |
| ZIP `…RC4_PACKAGE.zip` | sha256 `367fc692…b5843` = `RC4_CHECKS.json.zipSha256`; 38 entries all equal manifest hashes |
| Static checks | 8 normative markdown files, max 335 lines (`04_TRANSIENT_HANDOFF.md`), all code fences balanced; `AGENTS.md` unchanged since RC2 |
| RC2→RC4 changed files | 01, 02, 03, 04, 05, 06, README, DEPENDENCY_REFERENCES (01/02/03/AGENTS are byte-identical between RC3 and RC4; RC4-only changes are in README, 04, 05, 06, dependency label) |

## Delta inventory and assessment

| File | Change | Assessment |
|---|---|---|
| 01 | Routine renamed `public.atlas_reval_snapshot()`, separate exact allowlist/count, remote nine untouched (01:19,27-30); owner-credential paragraph: evidence-reader login is C's only resident DB credential, table-owner access only via a short-lived explicitly owner-initiated executor for PAUSE_EXPORT/seed/registration, never in C heap/pool/channels (01:47-53) | Closes NB1 and NB2. Consistent with `prisma/roles.sql:130-133,391-436` (prefix count stays nine) and the fixture verifier remaining a separate process under the runtime role (03:122) |
| 02 | pause-export runs in the short-lived owner executor, never the resident controller connection (02:129-130) | Closes NB2 for the closure path; lock order and routine call unchanged |
| 03 | Step 5 order: enter question → select fixed focus → consent; explicit narrow supersession of RC6 plan lines 53–54 with orchestrator obligation, RC6 bytes untouched (03:101-106) | Closes NB3; order matches the new 04 transition table |
| 04 | Pairing entry only in the sealed dedicated console build, no `AskCapabilityV2` field, unregistered PAIR→404, no probe (04:26-30); RC6 236–238 tightening named with rehearsal evidence (04:83-90); pane order and edit→reselect (04:103-106 region); exact event-transition table and declared synthetic-only departure (04:120-150); step 4 post-auth workspace/client/actor equality → `ASK_SCOPE_DENIED403` before phase1/source/reserve, arm consumed, no foreign Binding (04:224-232); **RC4:** first-current-GO eligibility and I/C/S bookkeeping (04:59-63,76-78,92-120) | Closes NB8, NB4, NB6; repairs the two RC2 defects below |
| 05 | Acceptance rows updated (Roles/RLS, Browser focus, Browser generations, Registered ingress, GO integration, Local protocol) and new **First arm** row (05:167) | Matrix covers first-success, prior-consumed denial, duplicate under identical and fresh sequence/challenge, ACK loss, state retention across pair/fixture/day, restart/state loss, next-case eligibility |
| 06 | PAUSE_EXPORT row names the short-lived owner executor (06:57); Binding created only after authentication AND registration equality (06:90-92); ARM_CASE eligibility paragraph referencing the 04 sets, envelopes unchanged (06:66-68) | Consistent with 04; `CASE_CONSUMED` and `ARM_UNAVAILABLE` already in the closed `FailureCode` enum (06:268) |
| README | RC4 title; amendments 4, 6, 8 now name the RC6 supersessions, the pane-only draft-retention departure and the first-GO-arms-once rule | Consistent with 03/04 |

### RC2 defect 1 (internal contradiction) — repaired

RC2 `04:54-55` said the controller "cannot arm a consumed case" while `04:69-71` said the GO command "irrevocably consumes the case, then requests ARM_CASE". Under RC2 text no case could ever be armed. This withdrew RC3. RC4 resolves it coherently: only the case just consumed by its FIRST current GO may arm ONCE (04:60-62,76-78); I keeps consumed IDs plus a single `armIssued` marker bound to the next control sequence/challenge, C and S mark a case seen/current BEFORE any fallible check or forward, repeated cases under old or fresh frame identity return `CASE_CONSUMED`, a failed write still counts as issued, and no ACK/status query can re-arm (04:101-120). The sets never reset on success, pair replacement, fixture/policy or UTC-day change; state or continuity loss stops the run and an empty set in a new process is not permission to resume (04:107-112). The ARM_CASE DTO and 06 envelopes are unchanged; a GO marker is private measured I state, not a transferable permission, and C/S do not attest a human GO (04:94-99). This adds no authority: the arm remains measurement only and the paid path still needs the manual click plus every accepted authority fence. I checked every other consumption statement (01:65,168; 02:76,124; 06:56,63-68,152-153; README:58-61) and found no remaining conflict.

### RC2 defect 2 (unreachable readiness) — repaired

RC2 `04:109-113` made both question edits and choice changes clear the draft AND the manual choice, so typing then selecting erased the question and selecting then typing erased the choice; readiness was unreachable. The RC4 table (04:126-134) retains the newly typed draft on edit (clearing choice/consent), retains draft and new choice on deliberate selection (clearing consent and stale pending), clears both on external invalidation, captures the immutable tuple on submit before clearing the form without self-invalidating, and makes stale callbacks/UI events inert. The draft-retention on fixed-choice selection is declared as a pane-only departure from ordinary focus-change clearing (04:142-146; README amendment 6); ordinary console behaviour and all consent/generation guards are unchanged, and 05's Browser focus/generations rows now require actual typing→choice→checkbox readiness for NONE, FOUND and FX10 MISSING across all 200 case paths. My RC2 review accepted the RC2 wording without detecting this; recorded here for honesty.

## Closure of my RC2 non-blocking findings

| RC2 item | Status in RC4 |
|---|---|
| NB1 routine prefix collision | Closed (01:19,27-30; 05 Roles/RLS row) |
| NB2 table-owner login placement | Closed (01:47-53; 02:129-130; 06:57; 05 Roles/RLS and Local protocol rows) |
| NB3 RC6 clock sentence unnamed | Closed (03:101-106; README amendment 4) |
| NB4 consume-before-ARM vs RC6 preflight | Closed (04:83-90; README amendment 8; 05 GO integration row) |
| NB5 process topology / peer identity on darwin | Open by design: remains an RS-A brief obligation; UNVERIFIED semantics unchanged (01:76-78). Acceptable |
| NB6 post-auth registration equality | Closed (04:224-232; 06:90-92; 05 Registered ingress row) |
| NB7 2 s handoff deadline includes instrument fsync | Open by design: remains an RS-C evidence obligation. Acceptable |
| NB8 pairing-entry discovery | Closed (04:26-30; 05 Browser focus row) |
| Minor: fence reread refusal ambiguity (02:136-137) | Unchanged wording; still minor, carry to RS-A brief |

## New non-blocking items from the RC4 text (wording for the RS-C brief; no invariant change)

**NB9 — "stops that run" after an arm-phase failure should name the resulting run state.** `04:114-116` says ARM validation failure or lost ARM_ACK/READY_ACK after consumption "stops that run for required closure/accounting", while `04:107-108` lets the next unconsumed case become eligible after completion, terminal-observation collection and POST-census checks, and `04:87` speaks of lost denominator credit. Read together, the intent is: interval closure (fence-first pause) plus POST census, then explicit owner resume per existing rules, with TERMINAL only on state/continuity loss or an existing terminal rule. Make that explicit so the instrument does not treat a single IPC hiccup as TERMINAL_INCOMPLETE, and so no implementer reads it as permission to continue without closure.

**NB10 — Audit semantics of the new pre-phase1 403.** `04:224-227` returns `ASK_SCOPE_DENIED403` before phase1. Accepted Ask code writes exactly one workspace `ask.scope_denied` SecurityAuditEvent inside the fenced authority step (`packages/ask/db-phase.ts:104-125`). State whether the registration-equality denial goes through that accepted denial audit (recommended; existing vocabulary, no new keys) or is deliberately an unattributed guard count only. Either is safe; the brief should pick one so the Registered-ingress negatives assert it.

## Bounded-repair scope judgment

All changes are clarifications within the already intended invariants: closed DTOs, routes, CLI, permissions, lock orders, payload caps, one-use freshness, process binding, measurement-only arm, manual consent/submit, no auto retry/probing, unknown-never-zero, pause≠drain, no reconstruction of private proof, real clocks independent of the fixture reference, server/transport provenance. The new I/C/S case sets are private state behind existing authenticated channels and add no permission. No fresh review is required; this bounded re-review applies to the exact hash above only. Any further change to a DTO/command schema, gate ordering, lock order, financial/authority rule, or the fixture/clock exception needs a fresh review, not reuse of this approval.

## Telemetry and limits

Same session and launcher settings as RC2: native `claude.ai` Max auth, `apiProvider firstParty`, `extraUsageEnabled false`, `fastMode false`, requested `claude-fable-5-1` at `xhigh`, no provider override, no API/credits/fallback. I cannot prove the effective response model from inside the session; the orchestrator must match this verdict to the launcher's effective-model evidence. Attributable usage unknown. Checks run: SHA-256 of 38 files, ZIP and package-hash reproduction (Python `-I`, read-only), byte diffs of the sealed RC2 and RC3 ZIP contents against the RC4 tree, and static reading of the changed sections plus the accepted code paths cited above. No tests, PG, browser or build executed.
