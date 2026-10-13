# S4-C RC5 implementation report — runner failure classification (Astra S4C-rc4 F1/F2)

Status: **IMPLEMENTED — PENDING independent GPT-6 Astra/xhigh acceptance** of this exact artifact. S4C-rc1…rc4 are
CHANGES_REQUIRED and were never accepted; LIVE remains **DEFERRED_BY_OWNER**. Not self-accepted; status, manifests, seals
and earlier reports/reviews/evidence unchanged. Same cohesive native Claude Code session
`02752ee0-ea51-4249-b089-d6aba4205d5d` (`claude-opus-5-5`, high, no subagents); preflight `S4C_RC5_REPAIR_PREFLIGHT.json`;
baseline `S4C_RC5_REPAIR_BASELINE.json` (883 files hash-identical before the first edit); review read:
`docs/stage4/reviews/ASTRA_S4C_RC4.md` SHA-256 `fa564a65…e555e1`. Sections 1–2 were written before any code edit (row 3 of
the table was then moved ahead of the SQLSTATE rows; see §5).

## 1. Correction of the RC4 claims

RC4 (`S4C_RC4_IMPLEMENTATION_REPORT.md` §2, §8; unchanged as history) claimed that a known structured non-timeout terminal
cause is never relabelled and that a generic loss before the effective deadline stays CLEANUP_FAILED. Both were false:
(F1) the session listener kept only a SQLSTATE, so a generic loss observed early (8 ms) was classified by the LATER
callback-query failure time (1 519 ms, after the effective timer) → TIMEOUT; (F2) the unconditional
`budget.left() <= 250` fallback ran after the structured checks, so a positively known 57P01/42501/PO010 classified inside
the original deadline window became TIMEOUT.

## 2. Classification decision table (scope: `runnerFailure` / `connectFailure` only; timers and cancellation unchanged)

Evidence the runner itself records (no message text is ever read):
- **T** = the FIRST session terminal event (`client.on('error')`): its client time, the budget left at that time, and its
  SQLSTATE if structured (often absent: pg reports idle termination as a generic `Error`). Later events never replace it.
- **F** = the failing operation's error as caught, with its catch time and budget left, taken BEFORE any ROLLBACK; ROLLBACK
  and close errors are never evidence.
- **D** = the effective server deadline: BEGIN send time + the transaction timer value armed at BEGIN (possibly a stricter
  inherited value); the earliest instant that timer can have fired.
- **W** = the watchdog's fire time (original deadline), if it fired.

FIRST-cause rule: the cause is T if T was observed before F (on equal times a structured T is preferred over a codeless F);
otherwise F. Only the first cause is classified; a later secondary error (a query on an already-dead client, ROLLBACK) can
never override it. The first cause is classified by the first matching row:

| # | First cause | Result |
|---|---|---|
| 1 | own budget marker (client check found the original budget spent) | CLEANUP_TIMEOUT |
| 2 | own fixed AtlasError RUNTIME_NOT_READY / SYNC_BUSY / CLEANUP_FAILED | that code |
| 3 | explicit Prisma fixed codes: P2024 / P2028; P2034; initialization errorCode P2024/P1002/P1001 / other | TIMEOUT; DB_CONFLICT; TIMEOUT / RUNTIME_NOT_READY (compatibility rows, unchanged; P1xxx/P2xxx never collide with PostgreSQL's P0xxx class) |
| 4 | SQLSTATE 57014 / 55P03 / 25P03 / 25P04 | CLEANUP_TIMEOUT |
| 5 | SQLSTATE 40P01 / 40001 | DB_CONFLICT |
| 6 | any OTHER known SQLSTATE (e.g. 57P01, 42501, PO010, 58000) | CLEANUP_FAILED — at any remaining budget, never relabelled by D/W/window |
| 7 | codeless, observed at/after W | CLEANUP_TIMEOUT (our watchdog cancelled/closed it) |
| 8 | codeless, observed at/after D | CLEANUP_TIMEOUT (the armed server timer was due) |
| 9 | codeless, observed with ≤ 250 ms of the original budget left | CLEANUP_TIMEOUT (original deadline window; codeless only) |
| 10 | codeless otherwise | CLEANUP_FAILED |

Connect phase (`connectFailure`, no transaction yet): structured 57014/55P03/25P03/25P04 → TIMEOUT; any other structured
state (28P01, 28000, 3D000 …) → RUNTIME_NOT_READY at any remaining budget; codeless after our own connect timer/watchdog or
inside the window → TIMEOUT; codeless otherwise → RUNTIME_NOT_READY (refused/unknown target).

Boundaries to cover: remaining 251 / 250 / 0 ms for query states and for session-terminal states (57P01, 42501, PO010 →
FAILED; 40P01, 40001 → DB_CONFLICT; 57014, 55P03, 25P03, 25P04 → TIMEOUT; codeless → FAILED / TIMEOUT / TIMEOUT); early
codeless T followed by a late codeless F after D → FAILED (F1); early structured 57P01 T followed by a late F → FAILED;
genuine codeless T at/after D → TIMEOUT; a structured T after F (e.g. during ROLLBACK) never overrides F; own markers and
fixed codes keep precedence; initialization/readiness rows unchanged.

## 3. Changes (classification and terminal evidence only)

- `packages/poweroffice/runner-transaction.ts`: the session `error` listener records the FIRST terminal event as
  `{at, left, state?}` (time and budget left even without SQLSTATE; never replaced); the watchdog additionally reports its
  fire time (`firedAt`; timers and cancellation themselves unchanged); the catch fixes `{terminal, failedAt, failedLeft,
  serverDueAt, firedAt}` BEFORE the ROLLBACK attempt; `runnerFailure(error, budget, context)` selects the first cause and
  `classifyCause` applies the §2 table — known SQLSTATEs (rows 4–6) before any clock rule, clock rules (7–9) only for codeless
  causes at their observation time; `connectFailure` (now exported for its unit test) lets a known SQLSTATE decide before the
  connect timer/window. Unchanged: watchdog/CancelRequest/backstop, pre-BEGIN session timers, effective BEGIN timer, 250 ms
  anchor, 1 s lock, stricter-inherited rule, maintenance body, pairing/confinement, admission, no retry, dependencies.
- Tests: NEW `tests/pg/poweroffice-cleanup-classification.pg.test.ts` (3); `tests/poweroffice-runner-phases.test.ts`
  rewritten as the RC5 boundary matrix (6; its RC4 context fields no longer exist); the RC2 test titled "…any failure… is a
  timeout" in `tests/poweroffice-runner.test.ts` retitled to its actual contract ("a CODELESS failure … in the window"),
  assertions unchanged.
- Routing: `packages/poweroffice/AGENTS.md`, `tests/pg/AGENTS.md`, `docs/AI_CONTEXT_MAP.md`.

## 4. Closure evidence (actual PostgreSQL 17.11, disposable DBs/roles, silent wrapper, absolute paths)

- Reviewer probes, unchanged (`/tmp/atlas-stage4/s4c-rc5-scratch/reviewer-probes-run1.log`): `early-transport-probe.mjs` →
  generic event at 8 ms, returned 1 519 ms, **POWEROFFICE_CLEANUP_FAILED** (was TIMEOUT); `early-terminal-probe.mjs` → real
  early administrative termination FAILED (unchanged), and `runnerFailure` with 57P01 / 42501 / PO010 at `left()=0` →
  **FAILED** each (was TIMEOUT; the probe's old `expired`/`serverDue` context fields are ignored by the new API).
- `poweroffice-cleanup-classification.pg.test.ts` 3/3 (`classification-run1.log`): F1 — actual socket destroyed while idle
  under an inherited 1 s timer, event observed at 9 ms, observer saw 0 runner backends at ~100 ms (before the timer), callback
  resumed and failed at 1 517 ms → CLEANUP_FAILED; controls — genuine 1 s idle timer → TIMEOUT, early `pg_terminate_backend`
  idling past it → FAILED, 0 backends; F2 — server-raised 22012, 42501, PO010 at 139–144 ms of the original budget left →
  FAILED, 40P01 → DB_CONFLICT, 55P03 → TIMEOUT (the test body disables its own transaction timer so the session reaches the
  window).
- Unit 15/15 (`tests/poweroffice-{read,runner,runner-phases}.test.ts`): remaining 251/250/0 ms for query states and for
  session-terminal states (57P01/42501/PO010/58000/23505 → FAILED; 40P01/40001 → DB_CONFLICT; 57014/55P03/25P03/25P04 →
  TIMEOUT; codeless → FAILED/TIMEOUT/TIMEOUT); early codeless event vs later failure after the timer → FAILED; event after the
  timer → TIMEOUT; later session event (e.g. during ROLLBACK) never overrides; equal-time structured event preferred; own
  fixed codes kept; connect-phase known states → RUNTIME_NOT_READY at any budget.
- Negative control against the frozen RC4 source (`/tmp/atlas-stage4/S4C_RC4_SOURCE.zip`, absolute paths): PG file 2/3 fail
  exactly at F1 (TIMEOUT instead of FAILED, event at 9 ms, 0 backends at ~100 ms) and F2 (22012 → TIMEOUT); the F1 controls
  pass on both (`classification-negative-control-rc4.log`). The unit matrix cannot import `connectFailure` from RC4; without
  the connect case it fails 4/5 there (partly also because RC4's context fields differ), the parser case passes
  (`unit-negative-control-rc4.log`).
- Neighbouring PG 52/52 on RC5 (`nearby-rc5-run1.log`): cleanup phases (setup lock, watchdog with timers off, idle, admin,
  wrong password), deadline (default 4+4+4, COMMIT-only, within-budget, 15 s/7 s login, CLI exit 1), inherited
  (role/database/startup, stricter/looser), budget (1 s lock, audit failure, Connection UPDATE orders, both deadlock victims),
  maintenance (pairing, single use, denials, misconfiguration), fence, CLI journey/privacy/trap, API, reads.

## 5. Checks, failed attempts

Final required run `/tmp/atlas-stage4/s4c-tools/checks.sh rc5-final`, logs `/tmp/atlas-stage4/s4c-checks/rc5-final/`
(11:32:19Z–11:35:10Z), all 11 exit 0: npm test **223/223** (220 + 3), schema:validate, db:generate, typecheck, api:build,
api:smoke, test:pg **565/565** (562 + 3; 149 s), db:check:pg17, db:check:drift, git diff --check, untracked-whitespace. No
failed required run. Earlier rc1–rc4 logs (incl. `rc4-final-failed1`) retained. Report completed after the run.

Attempt 1 (unit run, before any PG test): placing the generic SQLSTATE rows first classified a Prisma-shaped object
`{code:'P2024'}` (no clientVersion) as an unknown SQLSTATE → FAILED, breaking the RC2 initialization contract. Fixed by moving
the explicit Prisma fixed-code row ahead of the SQLSTATE rows (P1xxx/P2xxx never collide with PostgreSQL's P0xxx); the table
in §2 reflects the final order. No second repair attempt was needed.

## 6. Residual risks and qualifications

- A codeless loss first observed at/after the watchdog fire, the effective deadline armed at BEGIN, or inside the original
  250 ms window is still classified as timeout; an unrelated coincident disconnect at that moment cannot be distinguished
  without message parsing. Before those instants it is CLEANUP_FAILED; a structured cause always keeps its class.
- "First" is decided on the client clock at observation; a structured session event arriving later than an earlier codeless
  caught failure is treated as secondary (equal times prefer the structured event).
- Unchanged from RC4: login code before PostgreSQL issues the cancel key is not client-cancellable; CancelRequest in clear
  text with a 2 s backstop; atomic commit point and lost COMMIT acknowledgement; PostgreSQL 17 required; DB-local test
  objects/settings reset or dropped with disposable databases. Earlier constructed-deadlock, fence-wait, per-read audit and
  1000-attempt qualifications unchanged.

