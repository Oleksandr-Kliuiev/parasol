# ASK-REMOTE R-A financial/domain modules — context routing

Contract: docs/stage5/ask/remote/AGENTS.md, README.md, then 04_AUTHORITY_AND_BILLING.md; brief
S5ASKREMOTE_RA_IMPLEMENTATION_BRIEF.md; current report S5ASKREMOTE_RA_RC2_REPAIR_REPORT.md (RC1 report is historical,
partly superseded). R-A modules: pure integer transitions and finite DB helper statements. R-B (below) composes them; still
no browser/UI wiring (R-C), active seed, admission, real key, startup provider call or paid probe.

Modules:
- budget.ts: fixed profile/reserve 300000/rates 275,825 (micro-USD per 1000 tokens), cap limits (lower only), BigInt
  policyVersion parse/+1/max-bigint tombstone, UTC period keys, reserve (MONTH+DAY ≤ cap), exactly-once settle
  (USAGE_VERIFIED ceil cost, caller-asserted NO_DISPATCH 0 only when creation ≤ now ≤ creation+10 s, else whole reserve
  UNKNOWN), admission decision order; every instant validated (safe-integer Date range; NaN/±Infinity/reversed refuse).
  The 10 s window bounds late zero refunds only: SQL and these helpers TRUST the caller's NO_DISPATCH outcome and prove no
  process continuity or absent dispatch. R-B must own a private, non-reconstructible in-process dispatch/refund proof.
- ledger-sql.ts: RESERVE/SETTLE/PAUSE statements for the confined routines, validated parameters, SQLSTATE AR001–AR010.

Durable truth is SQL: prisma/askremote.prisma, migrations 202610111000 (ask:remote vocabulary), 202610111010 (tables,
CHECKs, guard, deferred ledger invariant, FORCE RLS), 202610111020 (routines); remote definer in prisma/roles.sql §4c/§5;
readiness packages/graph/ask-remote-role.ts + ask-remote-surface.ts. Tests: tests/ask-remote-budget.test.ts, tests/pg/ask-remote-*.pg.test.ts.

## R-B: server V2 journey and private provider adapter (offline seams only)

Contract: 02 (V2 DTOs/codes), 03 (wire profile, envelope, selection), 04 (egress, settlement, circuit); brief
S5ASKREMOTE_RB_IMPLEMENTATION_BRIEF.md; report S5ASKREMOTE_RB_IMPLEMENTATION_REPORT.md. Modules (one concern each):
- contracts.ts: remote error codes/statuses (the accepted V1 lists in ../contracts.ts stay byte-identical), V2 capability/
  answer/provenance, floors (4500/500 ms), remote audit record (existing keys, provider openai, ask-remote-intent-v1).
- input.ts: exact AskRequestV2 + acknowledgement. profile.ts: exact approved prompt/schema bytes and hashes, fixed endpoint.
- payload.ts: immutable question-only payload {question, hasFocus} serialized ONCE before egress (≤16 KiB), opaque handle.
- json.ts: strict JSON (duplicate keys at any depth reject). envelope.ts: exact response/usage/intent validation → verdict.
- transport.ts: the fixed direct HTTPS transport (EU 443, dedicated agent, no proxy/redirect/retry, 64 KiB incremental cap);
  `requestFn` is the in-process test seam. secret.ts: dedicated env://ATLAS_ASK_REMOTE_* resolver + productionSeams().
- dispatch.ts: the PRIVATE in-process dispatch/refund proof — capability minted only by a fulfilled egress commit, task-bound,
  one use, NO_DISPATCH only while still MINTED (revokes it), settlement inputs from private state once; the ONE provider phase.
  RC2 R1: the orchestration binds the task to its ORIGINAL deadline once (bindTaskDeadline); mint captures it and the last
  gate before consumption (after key resolution/byte copy) re-checks terminal and the ≥4500 ms floor (NOT_SENT FLOOR → 504).
  RC2 R2 (transport.ts): a non-200 status is decided at the response headers, the body read is stopped, physical ownership
  lasts until request AND response close.
- db.ts: remote DB port over db-phase.ts (same bounded phases/fenced authority as MOCK): capability, phase1 (all-of
  context:read+ask:remote, consent tuple first), egress (DB-clock floor sample → atlas_ask_remote_reserve_floor → post-INSERT
  token/policy/floor), settlement and pause on their own clocks, phase2 + final audit.
- circuit.ts: per-process configuration-fault circuit. answer.ts: shared selector (../selector.ts) + unchanged compiler → V2.
- service.ts: thin orchestration (order, settlement wait ≤ remaining − 500 ms, pause after phase2, owner holds everything).
SQL: migration 202610121000 (atlas_ask_remote_reserve_floor wraps the unchanged reserve; AR011 = floor; roles.sql runtime
EXECUTE; readiness spec ask-remote-role.ts). HTTP: apps/api/src/db/ask-remote.ts (ATLAS_ASK_MODE=remote, DB only).
Tests: tests/ask-remote-{wire,dispatch,local,flow,floor-gate,status-gate}.test.ts; tests/pg/ask-remote-{journey,upstream,egress,
floor,settle,process,rc2}.pg.test.ts; support tests/support/ask-remote-api.ts (scripted provider seam, direct production
orchestration with a test deadline) and ask-remote-http-fake.ts (in-process https.request stand-in for the direct transport).
