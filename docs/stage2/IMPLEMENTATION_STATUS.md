# Stage 2 — implementation status

Updated 2026-10-09 (administrative status). **S2-A, S2-B and S2-C ACCEPTED.** Tasks 2.1–2.10 are implemented and independently accepted by
GPT-6 Astra with effective `xhigh` effort in their recorded/synthetic scope. [S2-A acceptance](reviews/ASTRA_S2A_RC5.md),
[S2-B acceptance](reviews/ASTRA_S2B_RC4.md), [S2-C acceptance](reviews/ASTRA_S2C_RC2.md). S2-LIVE remains separate.
Architecture RC5 was approved by Astra xhigh and provider-verified native Fable high on the same package;
[architecture evidence](REVIEW_STATUS.md). Architecture and implementation candidate numbers are separate.

| Task / gate | Status | Implementation / acceptance |
|---|---|---|
| 2.1 DTO and correlation contracts | ACCEPTED in S2-A | Sonnet 5.5 / medium |
| 2.2 Persistence and grants | ACCEPTED in S2-A | Opus 5.5 / high |
| 2.3 Permissions and compatibility | ACCEPTED in S2-A | Opus 5.5 / high |
| S2-A | ACCEPTED — S2-A-rc5 | GPT-6 Astra / xhigh |
| 2.4 Graph adapter | ACCEPTED in S2-B | Native Opus 5.5 / high |
| 2.5 Directory generation sync | ACCEPTED in S2-B | Native Opus 5.5 / high |
| 2.6 Sign-in windows | ACCEPTED in S2-B | Native Opus 5.5 / high |
| S2-B | ACCEPTED — S2-B-rc4 | Fresh Astra / xhigh code acceptance on RC3; bounded status-only closure on RC4 |
| 2.7 Deterministic correlation | ACCEPTED in S2-C | Native Opus 5.5 / high |
| 2.8 Read API, tools and CLI | ACCEPTED in S2-C | Native Opus 5.5 / high |
| 2.9 Retention maintenance | ACCEPTED in S2-C | Native Opus 5.5 / high |
| 2.10 Synthetic acceptance and evidence | ACCEPTED in S2-C | Native Opus 5.5 / high; independent Astra acceptance |
| S2-C | ACCEPTED — S2-C-rc2 | Fresh GPT-6 Astra / xhigh; R1/R2 closed, no required findings remain |
| S2-LIVE | DEFERRED_BY_OWNER; L1–L4 NOT_EXERCISED | Recorder RC2 accepted; disposable DB prepared; owner/operator/bind/LIVE remain unexecuted. Stage 3 S3-A/B/C accepted in MOCK scope; LIVE remains deferred. |

## Accepted artifact and verification

**S2-A-rc5** — `0a038288cd529ac1692b67bb8ed06343d3d381d04539aa8ed308aa45c144f2d1`, 213 payload files.
[Manifest](../../verification/stage2/S2A_RC5_MANIFEST.json),
[snapshot](../../verification/stage2/S2A_RC5_PACKAGE.zip),
[check receipts](../../verification/stage2/S2A_RC5_CHECKS.json).
Baseline HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `planning/stage2-m365`; existing dirty work preserved.
Codex reverified every S2-A payload hash and ZIP entry immediately after acceptance and again before S2-B handoff.
The current checkout includes accepted S2-B; S2-A remains the historical accepted baseline.
RC5 normative files, frozen Stage 1 migrations and the Stage 1 review report retain their recorded hashes.

All 11 orchestrator commands passed after writer handoff: schema validate/generate, typecheck,
**108 unit/PGlite tests**, API build/smoke, **176 PostgreSQL tests twice**, PG17 check, zero schema drift and diff check.
Environment: Node25.8.1, Prisma6.19.0, PostgreSQL17.11; disposable databases and synthetic data.
[Archived logs](../../verification/stage2/S2A_CHECK_LOGS.zip) preserve all 55 RC1–RC5 command logs and hashes.
The final reviewer independently passed 35 selected tests, following its fresh RC4 inspection and 101 selected tests.

## Review history and closure

- [RC1](reviews/ASTRA_S2A_RC1.md): runtime membership, publication races, post-lock clock, SQL DTO truth semantics.
- [RC2](reviews/ASTRA_S2A_RC2.md): pointer-time fencing and COMMIT atomicity.
- [RC3](reviews/ASTRA_S2A_RC3.md): prerequisite validation; review incomplete after an environment cybersecurity-risk interruption.
- [RC4](reviews/ASTRA_S2A_RC4.md): fresh ordinary code inspection and standard tests completed; one DTO byte-cap inconsistency.
- [RC5](reviews/ASTRA_S2A_RC5.md): same reviewer closed that bounded finding and accepted this exact S2-A scope;
  effective `xhigh` retained. No exploratory probes resumed. No obligatory findings remain in the accepted scope.

Claude Code used native Anthropic routing with explicit models/efforts and actual response-model evidence.
[Execution records](../../verification/stage2/S2A_EXECUTION.json) include elapsed time, repair runs and raw usage counters.
Attributable Max5x quota is unavailable; cache counters and cumulative API dollar estimates are not quota savings.
Different Sonnet/Opus task scopes do not establish a model quality ranking. For S2-B database briefs, include explicit
state-transition and transaction-boundary cases before implementation; retain the approved model assignments.

## S2-B accepted artifact and verification

**S2-B-rc4** — `d122f0ea4031ce3421c114c286d409b974d83449d8db6f3930b53884486eb841`, 269 payload files.
[Manifest](../../verification/stage2/S2B_RC4_MANIFEST.json), [snapshot](../../verification/stage2/S2B_RC4_PACKAGE.zip),
[check receipts](../../verification/stage2/S2B_RC4_CHECKS.json), [final Astra closure](reviews/ASTRA_S2B_RC4.md).
Actual code accepted on [RC3](reviews/ASTRA_S2B_RC3.md); RC4 changes only workflow status text. All code/test/SQL/requirements
hashes and check logs are identical. Codex and Astra verified every final checkout/ZIP hash; no required findings remain.

Implemented Graph adapter/activation and credential isolation, atomic directory generations, durable directory retry budget/
backoff/reset, sign-in root claims/splitting/publication/recovery, preserved failure outcomes and workspace denial audit.
All ten required commands passed: **132 unit/PGlite and 240 PostgreSQL tests**, zero failures/skips; schema/generate/types,
build/smoke, PG17, zero drift, whitespace. Command exits verified from actual native tool results and archived log hashes.
Astra independently ran **129 existing tests** with zero failures/skips, including publication races and cleanup confinement.
[Logs](../../verification/stage2/S2B_CHECK_LOGS.zip), [implementation evidence](../../verification/stage2/S2B_RC3_IMPLEMENTER.md).

[RC2 findings](reviews/ASTRA_S2B_RC2.md) R1–R4 are closed. The exact [corrective policy](reviews/S2B_RETRY_REPAIR_PLAN_RC2.md)
(`95035762eb167b02b7332108d9b90c48499735e7b84a0f97cec29f43c69d3799`) was approved by fresh
[Astra xhigh](reviews/ASTRA_S2B_POLICY_RC2.md) and native [Fable high](reviews/FABLE_S2B_POLICY_RC2.md) before implementation.
Accepted migrations and all normative RC5 files remain unchanged. S2-C is accepted below; no live work started.
[Execution record](../../verification/stage2/S2B_EXECUTION.json): four native Opus/high invocations in one cohesive session,
three repair rounds, 3789.1s implementation wall time; provider response-model evidence retained, attributable quota unknown.

## S2-C accepted artifact and verification

**S2-C-rc2** — `e43cc1858e7271577714e2b46e5c8d10956dd4e625cad779964a3a3ac6cbe3c0`, 307 payload files.
[Manifest](../../verification/stage2/S2C_RC2_MANIFEST.json), [snapshot](../../verification/stage2/S2C_RC2_PACKAGE.zip),
[check receipts](../../verification/stage2/S2C_RC2_CHECKS.json), [fresh Astra xhigh acceptance](reviews/ASTRA_S2C_RC2.md).
Codex reverified every current payload and ZIP entry after acceptance; pre-check, post-check and accepted hashes match.
Relative to accepted S2-B: 17 modified and 38 new files, none removed. Frozen migrations, normative files and Stage 1 report unchanged.

Implemented deterministic Huntress-to-M365 device and assigned-person correlation with per-relation proof, retained conflict
provenance, coverage/freshness separation, precise authenticated pagination, the correlation endpoint and two read tools,
one composed registry in DB/fixture modes, operator recovery/read commands and scoped retention maintenance.
All ten final commands passed: **145 unit/PGlite and 308 PostgreSQL tests**, zero failures/skips/cancellations; schema/generate,
typecheck, API build/smoke, PG17 SQL checks, zero drift and diff check. [Archived logs](../../verification/stage2/S2C_RC2_SAFE_LOGS.zip)
include the earlier failed tamper-test run and RC1 reproductions. Final checks followed the deterministic tamper-test correction.
Astra independently ran **38 tests**, all passed; [independent evidence](../../verification/stage2/S2C_RC2_ASTRA_EVIDENCE.zip).

[RC1 findings](reviews/ASTRA_S2C_RC1.md) R1/R2 are closed: future sub-millisecond eligibility transitions are assessed before
rounding expiry, and historical conflict validity accounts for the last still-valid published membership. Losing an earlier
membership does not interrupt paging. A cursor may conservatively be expired at issuance near a transition.
[Execution record](../../verification/stage2/S2C_EXECUTION.json): one native Opus5.5/high session, two invocations, one repair round,
4582.5s implementation wall time; observed response model only `claude-opus-5-5`, no fallback. Attributable subscription quota unavailable.

Residual limits: cleanup authority can be revoked after admission while the separate runner transaction still completes;
cleanup is time-bounded (maximum 600000 ms), without batching. The 19,000-row/~480 ms-page benchmark belongs to RC1;
RC2 aggregate-query latency was not remeasured and larger-scale performance is unvalidated. The pre-existing S2-B single-leaf
staging timeout around 9,500 memberships remains a visible FAILED outcome. Process/DB clock skew can affect sync/read freshness.
These limits do not establish live or production readiness. **S2-LIVE deferred at the owner’s request; actual live gates remain open**.
No deployment or account/vendor write occurred.

## Current direction — live deferred, Stage 3 MOCK accepted

The owner asked to defer real live execution and continue independent engineering. S2-A/B/C acceptance remains in its recorded/synthetic scope.
L1–L4 are NOT_EXERCISED; no vendor write or production readiness is claimed. The prepared disposable DB remains available, with no operator, binding or source evidence.
The pending pilot setup proposal is deferred and has not been authorized or executed; its target and expiry must be revalidated when the owner resumes the pilot.
Credential/setup questions do not block the separate Stage 3 design work.

Current: [Stage 3 implementation status](../stage3/IMPLEMENTATION_STATUS.md). MOCK architecture RC4 is dual-approved; S3-A code RC3 is independently accepted by fresh Astra/xhigh. Native Opus5.5/high implemented it in one cohesive session. S3-B code RC2 is independently accepted by explicit Astra/xhigh, closing both RC1 findings; S3-C code RC2 is independently accepted by Astra/effective xhigh, closing R1–R3; Stage 3 MOCK engineering is complete; LIVE remains deferred. [S3-C acceptance](../stage3/reviews/ASTRA_S3C_RC2.md). Historical architecture/code findings and fixes are preserved; [S3-A acceptance](../stage3/reviews/ASTRA_S3A_RC3.md).
The roadmap names Foundation as its direct dependency. Its local engineering can use synthetic data/mock transport while Stage 1/2 live gates remain open. Real ticket creation has its own live admission.

## S2-LIVE preparation

[Operational brief RC5](reviews/S2LIVE_OPERATIONAL_BRIEF_RC5.md) is frozen for fresh independent Astra xhigh and native
Fable high plan reviews. [Plan manifest](../../verification/stage2/S2LIVE_PLAN_RC5_MANIFEST.json):
`7cfdc792c9702f6d283f2e8452823cd2c38d95d8eb1aeab4241b8a4c3ac5f2e3`; RC5 dual-approved: [Astra xhigh](reviews/ASTRA_S2LIVE_PLAN_RC5.md),
[native Fable high](reviews/FABLE_S2LIVE_PLAN_RC5.md); [approved identity](../../verification/stage2/S2LIVE_APPROVED_PLAN.json).
[Astra RC4](reviews/ASTRA_S2LIVE_PLAN_RC4.md) required excluding Connection from bootstrap; accepted bind creates it itself.
RC5 specifies empty Connection after setup, then owner disconnect/confinement/authentication and separately authorized bind.
[Astra approved RC3](reviews/ASTRA_S2LIVE_PLAN_RC3.md); [Fable RC3](reviews/FABLE_S2LIVE_PLAN_RC3.md) required an explicit
pilot operator provisioning path including `m365:read`. RC4 defines conditional target-specific owner-side setup; it
requires a separate explicit owner instruction and admits no seed/fixture namespace or evidence into any live claim.
[Astra RC1](reviews/ASTRA_S2LIVE_PLAN_RC1.md) required closing the Stage 1 automatic-redirect recording gap. RC2 specifies
a pilot-only redirect restriction and native-fetch zero-follow-up tests; [Astra approved RC2](reviews/ASTRA_S2LIVE_PLAN_RC2.md).
[Independent Fable RC1](reviews/FABLE_S2LIVE_PLAN_RC1.md) required executable L3 prerequisites, genuine Observation origin
and a consistent recording composition. RC3 explicitly blocks L3 until real canonical/candidate/Observation prerequisites
and an accepted operator path exist; any future onboarding extension is a separate reviewed amendment. It defines a separate
recorded driver with fail-closed dispatch guards and no Decisions instantiation/invocation. Production core is unchanged.
Plan review is not actual live acceptance. [Local preflight](../../verification/stage2/S2LIVE_PREFLIGHT_RC1.json)
failed runtime admission with `RLS_NOT_ENABLED`: all 10 M365 tables are missing from the configured database; present
protected tables have RLS. No application rows were read, no Graph/vendor/provider calls or DB writes occurred.
The accepted S2-C source and 11 normative hashes match; its context-map routing row is extended for the pilot recorder. At the initial preflight, the shared cursor reference and target client/tenant were absent.
The owner subsequently supplied the tenant domain and selected a disposable DB (preparation below). Private credential/cursor references, final client/operator admission, consent/license, Atera/Huntress live evidence and human mapping confirmation remain pending.
An arbitrary env credential name may exist; runtime refusal prevented connection/config inspection, so credential absence
is not asserted. Preparing a designated pilot database requires a concrete target/setup decision; the persistent configured
DB is not automatically migrated. L1–L4 remain NOT_EXERCISED. The bounded [recorder handoff](reviews/S2LIVE_RECORDER_IMPLEMENTATION_BRIEF.md) is implemented; native Claude Code Opus5.5/high returned write ownership to Codex.
No provisioning/onboarding helper is in that scope; reviewers remain read only.

### Recorder checkpoint — RC2 accepted

[S2LIVE-RECORDER-rc2 manifest](../../verification/stage2/S2LIVE_RECORDER_RC2_MANIFEST.json):
`a02667ee81ef7f3ad809a7952d562a688d9caee408484a905c4e3b28212203e3`, 324 payload files.
All accepted S2-C files other than the allowed context-map row, all 11 normative files and frozen migrations retain their hashes.
The driver records metadata before each dispatch, refuses automatic redirects and unrecorded fetches, projects public results through field allowlists and refuses Decisions callbacks.
Codex required a fix for the additional permission refusal without workspace security audit; RC2 adds the accepted audit sink, exactly-once denial tests and audit-failure refusal.
[RC2 checks](../../verification/stage2/S2LIVE_RECORDER_RC2_CHECKS.json): 168 unit/PGlite and 317 disposable PostgreSQL tests, all 10 checkpoint checks exit 0; focused checks 23 unit and 9 PG.
[Verified log hashes](../../verification/stage2/S2LIVE_RECORDER_RC2_LOG_VERIFICATION.json) preserve final evidence and the intentional failing regression mutation.
[Fresh native GPT-6 Astra / xhigh acceptance](reviews/ASTRA_S2LIVE_RECORDER_RC2.md) covers this exact artifact with no required changes.
Astra independently matched 324 current files and ZIP entries, reran 23 focused unit/process and 9 disposable PG tests, typecheck and whitespace checks, and verified all 13 archived logs.
[Accepted recorder identity](../../verification/stage2/S2LIVE_RECORDER_APPROVED.json) pins source, archive and evidence. Implementer reports are not acceptance.
Recorder preparation does not establish L1–L4 results or authorize pilot provisioning, binding, onboarding or actual live access.

### Designated pilot DB preparation

Owner selected a separate disposable DB and supplied the test tenant domain. Private target/tenant IDs and connection URLs remain outside the repository.
[Database preparation receipt](../../verification/stage2/S2LIVE_PILOT_DATABASE_PREPARATION_RC1.json): local PostgreSQL 17, 18 reviewed migrations applied, separate runtime/definer/runner roles, runtime confinement passed after owner disconnect.
Twelve application tables checked empty; no seed, Workspace/Client/Actor/ApiToken, Connection, canonical/source/event/Observation rows were created.
One unauthenticated public OIDC discovery returned HTTP 200 and resolved the tenant ID; this establishes neither Graph capability nor consent/license readiness. No Graph/vendor/provider calls occurred.
A concrete private owner-side setup proposal names the target, dedicated workspace/client/operator, exact five grants and a proposed 24-hour token expiry. It is not executed: the RC5 target-specific owner-operation exception requires an explicit owner instruction.
Private M365/cursor references and consent/license/vendor readiness remain pending. L1–L4 remain NOT_EXERCISED; L3 remains BLOCKED_EXTERNAL.


## Scope and limits

S2-B started at the owner’s request on 2026-10-08. Codex verified all 213 S2-A-rc5 payload hashes and the
11 normative architecture hashes before handoff; no mismatches. Baseline HEAD and branch above remain unchanged.
The bounded S2-B brief transfers implementation write ownership to one native Claude Code Opus 5.5 / high session;
Codex regains write ownership only after that process finishes. S2-A acceptance remains unchanged.
Graph adapter, directory generations and sign-in windows (tasks 2.4–2.6) are accepted in S2-B.
S2-C preparation started at the owner's request on 2026-10-08. All 269 accepted S2-B-rc4 payload hashes and all 11
normative RC5 hashes matched before preparation. Initial independent Astra xhigh and native Fable high reviews cover
the same [S2-C brief RC3](reviews/S2C_IMPLEMENTATION_BRIEF_RC3.md), hash
`de3eea93865ef907872a4cf170a87993f629f4ff2ea006bf7fe4293073ad7f57`.
RC1 required target-binding, assignment-fingerprint, operator-state/recovery, precise-time/cursor-size and cleanup-timeout
clarifications; these are incorporated. RC3 also freezes mock subprocess mechanics, selection predicate and additive
reason codes/read envelopes. Both fresh reviewers accepted RC3: [Astra xhigh](reviews/ASTRA_S2C_PLAN_RC3.md) and
[native Fable high](reviews/FABLE_S2C_PLAN_RC3.md); [approved identity](../../verification/stage2/S2C_APPROVED_PLAN.json).
Codex reverified all baseline and normative hashes before handoff. One new native Claude Code Opus5.5/high session
implemented tasks 2.7–2.10 and the related fixes. Both CLI invocations finished; Codex regained write ownership. Fresh Astra
xhigh accepted the actual RC2 code and evidence. No live/account/deployment work is authorized by this checkpoint.
Live verification remains a separate gate.
Publishers must preserve Connection → root → generation/attempt → leaf ordering, atomic completion/pointer publication,
and visible parent-first creation in separate statements. Last-good snapshots remain retained after newer failures.
Accepted Stage 2 migrations are now frozen; further schema corrections require new migrations and affected review.
No deployment or live tenant access occurred. Correlation, read surfaces and retention service are accepted in S2-C; live acceptance is a later gate;
Stage 1 limitations remain in [CHECKPOINT_REPORT](../../CHECKPOINT_REPORT.md).

S3-B acceptance: [Astra RC2](../stage3/reviews/ASTRA_S3B_RC2.md), seal `verification/stage3/S3B_APPROVED.json`. MOCK-only; pilot and live prerequisites remain separate.
