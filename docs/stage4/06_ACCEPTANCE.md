# Stage 4 acceptance criteria

## Architecture and implementation matrix

| Gate | Required evidence |
|---|---|
| D1 | Fresh Astra/xhigh and native actual Fable5.1/high approve SAME current package; no inherited/self-identification model proof; frozen baseline/norms/migrations preserved; billing verified subscription only |
| A1 | Strict DTO limits, extra fields, invalid Unicode/date/UUID/money/currency/sign/scale/overflow/duplicates/count; BigInt exact sums; empty versus missing; separate currencies and invoice/credit magnitudes; Oslo calendar/DST/midnight cases |
| A2 | Scoped compound FKs, FORCE RLS including non-superuser owner observations; strict NOT NULL/CHECK truth semantics; one ACTIVE; pointer validity; immutable identities/aggregate history; lifecycle/sequence constraints |
| A3 | Exact runtime grants and maintenance owner/runner policies/routines; tamper readiness fail closed; no PUBLIC definer execution; Stage3 fence-definer routine allowlist unchanged; ApiToken policy/grants unchanged |
| A4 | Shared current-token extraction preserves action auth/expiry/replay/denial/conflict semantics; context:read alone, wrong client/workspace, inactive actor, split permissions, admin shortcut, forged Actor/token/claim refused with zero calls/data |
| B1 | Real built-in MOCK defaultDISABLED, exactMOCK, FIXTURE provenance/pins, no script/URL/file/credentials callbacks; invalid mode/binding refused before port; no PowerOffice generic credential resolution; synthetic markers all paths |
| B2 | One ACTIVE durable claim; parallel syncBUSY incl.expired;1000attempt cap; deadline read60s/persist20s from original clock; token expiry under last lock; before every page fresh authority, revoked midpass no later call/publication |
| B3 | Complete bounded pages only: changed company/version/export/header, duplicateID, repeated/empty/noncontiguous page, count/malformed/overflow/timeout/source failure preserve prior snapshot; no staged/raw data or automatic page retry |
| B4 | Publication atomic snapshot/pointer/SUCCEEDED/audit; audit rollback; current authority/binding/deadline after ALL locks; no stale/abandoned/expired publication; identical commit replay no duplicate snapshot/audit; known rollback max3 SAMEfact, zero extra port calls |
| B5 | Crash after claim and before publication; explicit recover>=80s with no I/O; earlier recovery refuses; late result after recover inert; recover still works after disable/lifecycle drift without source/data publication; private failure can close only its own ACTIVE claim after revocation with no summary/new read; audit failure leaves recoverable claim |
| C1 | Dedicated API/status/summary/CLI all-of current auth; accepted existing tools/context/AI cannot read business data; strict DTO/flags/token input; no client-existence probe or private fields/raw errors; every envelope synthetic:true |
| C2 | DB-clock FRESH/STALE/MISSING/ERROR/EXPIRED/UNAVAILABLE, previous snapshot on failure, no old-binding data, read-time expiry even no purge, Cache-Control:no-store; read audit failure emits no financial payload |
| C3 | Cleanup preadmission fresh maintain rights; separate paired runnerDB/privileges; function current scope and binding; activeBUSY, expired snapshots cleared/deleted atomically with audit, disabled-source purge, bounded1000rows/10s and morePending; immutable/ACTIVE attempts retained, sequence notreset; audit/timeout rolls back |
| C4 | Actual CLI process journey: seedsynthetic → sync → summary → failureSTALE → recovery → expiry/purge; real API plus legacy Gateway exclusion/regression paths, synthetic network trap with positive self-control, privacy capture (audit/log/stdout/stderr/telemetry/Decisions), zero vendor HTTP/API calls |
| R1 | Stage1 context/Gateway/activation/bind/inbox/observations, Stage2 M365 sync/read/correlation/cleanup and Stage3 approval/reservation/execute/verify/recover remain accepted; healthy/corrupt-fence regressions; default new feature disabled |
| R2 | Upgrade from accepted20migration DB, existing rows/fences/FKs/roles survive; no changed old migration/history/fixture; provision role names safely, rerunnable grants, no auto-membership permission assignment; schema drift zero |

## Finding-specific required evidence

- A1/A2: immutable detached validated DTO/facts; exact TS/SQL aggregate shape/order/total bounds; allocated snapshot ownership,
  bidirectional ACTIVE discoverability, latest/completed metadata and sequence coherence; Oslo IANA tzdata DST/midnight.
- A3/R2: immediately after migrations BEFORE role provisioning no new PUBLIC routine violation; after provisioning exact
  lock-capable grants and only runner cleanup EXECUTE; original two fence policies/shared invoker list unchanged.
- B2/B4/C3: concurrent direct Connection UPDATE against admission/publication/cleanup, fixed outcomes/no partial effects,
  next command sees new lifecycle; real non-superuser confined runner succeeds with no42501. Test each explicit lock.
- B4: reused identity with changed complete fact refuses; identical lost-ack receipt cannot bypass fresh auth/binding/expiry.
- B5: DB clock<deadlineAt recovery refuses, >= succeeds; no ACTIVE after committed publication returns fixed no-op code,
  no audit/source effects. Private failure and expired recovery retain coherent lastCompleted state.
- C1: actual HTTP missing/malformed/expired bearer401 and every error synthetic:true; permission/split membership/inactive
  actor/revocation/last-lock expiry and audit failures yield exact workspace/client audit effects, no ledger/client prewrites.
  Actual /tools/execute and discovery expose no PowerOffice tool; legacy grammar/ledger/tool regressions unchanged.
- C2: one case per04 precedence row; success→failure→ACTIVE→success and success→ABANDONED→ACTIVE preserve warning until
  publication; purged→failure/ACTIVE stays EXPIRED/null; empty remains known zero. Reads change no domain rows and concurrent
  read/publication returns coherent old/new data, only an atomic success audit may insert.
- C3: empty/foreign owner GUCs isolate; mismatched parameters/scope/non-PowerOffice refuse; direct definer DELETE of
  unexpired/referenced Snapshot or ACTIVE/young/referenced Attempt refuses; >1s lock wait and original10s deadline rollback.
- C3/C4: PowerOffice audit keys limited to six02 keys, no counts/amounts/clock/source keys; global extra allowlisted keys
  do not widen this domain. Attempt.sequence operational ordinal permitted. Privacy capture covers actual API/CLI/Gateway.

## Required checkpoint commands

On final checkpoint source, run npm test, npm run schema:validate, npm run db:generate, npm run typecheck,
npm run api:build, npm run api:smoke, npm run test:pg, npm run db:check:pg17, npm run db:check:drift,
git diff --check plus untracked-whitespace scan. Use the private PG admin wrapper without printing credentials/URLs.

Run focused meaningful tests while implementing; retain failed attempts and negative controls honestly. Real concurrency,
locks/deadlocks/audit rollback and built-in cancellation need actual PostgreSQL evidence, not only mock throw tests.
Test trusted in-process fault seams separately from actual built-in behavior. Test deadlines with conservative real waits
and stored DB-clock comparisons; no caller clock override. Pure aggregation/calendar unit tests may supply deterministic dates.
A reviewer independently inspects code and targeted checks; never relabel implementer tests as independent. No blanket
full-suite repetition after unchanged accepted source/status-only integration. Stop at each checkpoint and record residual
limits; no claim that synthetic data verifies PowerOffice billing/accounting, live completeness or operational readiness.
