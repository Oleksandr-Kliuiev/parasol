# Ask Atlas OFF/MOCK backend (ASK-A) — context routing

Contract: docs/stage5/ask/AGENTS.md, README.md, then the relevant 02 (HTTP/bank/planner/compiler) or 03 (authority, audit,
budgets) section; brief S5ASKA_IMPLEMENTATION_BRIEF.md; report S5ASKA_IMPLEMENTATION_REPORT.md. Local deterministic MOCK
only: no provider, SDK, egress, key, tool/Gateway, DecisionRun, M365/finance or sync access may be added here.

Modules by concern:
- contracts.ts: fixed AskErrorV1 codes/statuses, limits, DTO types, audit vocabulary. config.ts: ATLAS_ASK_MODE off|mock|remote
  (remote = ASK-REMOTE R-B, DB only, packages/ask/remote; MOCK/OFF behavior unchanged).
- input.ts: route classification (superset of Express aliases), content type, exact AskRequestV1 semantics.
- budget.ts: ≤4 owners, ≤1 per actor, ≤64 entries, 10/60 s rolling, exactly-once release after held work settles; deadline.
- credential.ts: private digest-only credential (DB bearer digest; fixture whole-header digest + accepted equality rule).
- service.ts: AskRun (terminal state, deadline checks), port interface, capability/question flows, planner timeout.
- phase.ts (rc2): one absolute end per private DB phase; the only statement runner (run/phase checks around every await,
  statement_timeout = time left in the phase). authority.ts adds the caller-visible phase timer; the owner still waits for drain.
  rc3: the runner hands each step a guarded transaction view, so EVERY actual statement — also the internal awaits of the
  reused, unmodified shared currentToken/setLocal — is checked and re-bounded. fixture.ts re-checks after its demo await.
- authority.ts: DB port — bounded transactions, private authentication, phase1/phase2 fence FOR SHARE, denial and final
  audit with post-INSERT expiry/deadline checks. R-B extracted its bounded phase (phaseTx/boundedTx), private authentication
  helpers and fenced authority (all-of permission list; MOCK passes context:read only) UNCHANGED into db-phase.ts. read.ts: focused admitted-transaction source reader (explicit SQL).
- source.ts: strict whole-original validators shared by DB and fixture. fixture.ts: synthetic fixture port.
- projection.ts: evidence bank, coverage, server-only focus refs, enum descriptors. planner.ts: planner contract, MOCK
  phrases, whole-plan validation; its deterministic reference selection lives in selector.ts (shared with ASK-REMOTE, no
  behavior change). compiler.ts: exact intent/ref/claim matrix, urgent refs, AskAnswerV1. audit.ts: metadata.
HTTP: apps/api/src/ask-http.ts (ingress, parsers, writer), ask-fixture.ts, db/ask.ts; composition in main.ts/atlas.module.ts/
db/app.module.ts. Tests: tests/ask-*.test.ts (pure/in-process), tests/pg/ask-*.pg.test.ts (rc2 physical phase/disconnect: ask-physical; rc3 helper awaits: ask-helper-boundary, ask-fixture-boundary), support tests/support/ask-{pg,source}.ts.
ASK-REMOTE (separate boundary): packages/ask/remote/AGENTS.md — R-A pure budget/policy transitions and ledger statements;
R-B remote V2 server journey, private adapter and offline seams (no browser activation, no paid call, no active admission).
