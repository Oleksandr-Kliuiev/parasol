# Astra S2-B-rc2 — REQUEST_CHANGES

2026-10-08. Independent first checkpoint review, fresh native `gpt-6-astra`, effective `xhigh`.
Explicit spawn assignment verified by Codex; no model/effort change or fallback requested. Per-response upstream model
and billing fields are unavailable in native subagent tools. Reviewer made no implementation edits.

Artifact: `a16bbcc1668a3bbb0603f44e705c46ad7c99f94b8d51bbfa708284df08a33144`, 260 payload files.
Baseline HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `planning/stage2-m365`.
Scope: tasks 2.4–2.6 / S2-B; excludes S2-C, live Graph and production readiness.

## Identity and verification

Astra independently verified every current payload hash, aggregate and ZIP entry; all 11 normative RC5 files
(`1d3b1064c2633ed64ab2089a7ea62401e9415a72b16ba5a9dcd9a50c870a1efb`), accepted S2-A migrations and Stage 1 report.
Existing-file changes were compared with the accepted S2-A-rc5 ZIP. All ten RC2 check-log hashes matched archived logs:
schema validation/generation, typecheck, 128 unit/PGlite tests, API build/smoke, 227 PostgreSQL tests, PG17 checks,
zero drift and whitespace checks passed, with no failed/skipped tests. Final post-review rehash matched RC2.

Independent existing-test command:

```sh
node --env-file=.env --experimental-strip-types --test tests/m365-auth.test.ts tests/m365-http.test.ts tests/m365-adapter.test.ts tests/pg/m365-activation.pg.test.ts tests/pg/m365-directory.pg.test.ts tests/pg/m365-directory-retry.pg.test.ts tests/pg/m365-order.pg.test.ts tests/pg/m365-windows.pg.test.ts tests/pg/m365-window-recovery.pg.test.ts tests/pg/m365-window-publication.pg.test.ts tests/pg/m365-window-limits.pg.test.ts tests/pg/m365-retry-upgrade.pg.test.ts
```

71 passed, 0 failed/skipped, exit 0, 5.01 seconds; disposable synthetic databases and mock transports.
No newly constructed exploratory probes. Implementation response-model fields consistently reported native
`claude-opus-5-5` / high; provenance does not constitute acceptance or quota evidence.

## Obligatory findings

### P2 RC2-R1 — directory transient retry policy incomplete

`packages/m365/directory.ts:193`, admission at line 53. Directory 503/network/timeout records `retryAt = null`;
another call can immediately allocate another generation and contact Graph. There is neither exponential delay nor
a finite retry budget. Returning TRANSIENT delegates the approved §6 obligation to an unspecified caller.
The separate sign-in five-attempt rule does not dictate the directory count, but a finite policy is required.

Implement service/job backoff capped at 15 minutes, bounded attempts, explicit exhaustion/reset semantics, ordering
and last-good retention. Regressions must cover increasing delays/cap, premature-I/O refusal, exhaustion and permitted
restart/reset, including the persistence/restart semantics actually promised.

### P2 RC2-R2 — concurrent first claim bypasses Retry-After

`packages/m365/directory.ts:59,68`. SELECT FOR UPDATE locks nothing for a missing state. B can read absence and pause;
A creates state, commits and records a future 429 retryAt; B then executes unconditional INSERT ON CONFLICT UPDATE,
increments the sequence and performs I/O without rechecking the throttle. Connection SHARE permits this interleaving;
the retry trigger permits unchanged retryAt and assertDirectoryClaim does not check it.

Establish the row before the locked admission decision; read the clock/check throttle under its lock, or use equivalent
atomic admission. Controlled two-session regression must refuse B with M365_RETRY_NOT_DUE, with no new sequence,
generation, secret resolution or upstream call. Finding established by source inspection, not an exploratory probe.

### P2 RC2-R3 — repeat sign-in pass hides terminal failure

`packages/m365/windows.ts:118`, propagated by `ingest.ts:220`. COMPLETE and FAILED both return DONE/null; job projection
does not read its stored safe code. A repeat pass cannot distinguish permanent 403/retry exhaustion from success.
The recovery test at line 132 currently expects this incorrect behavior.

Preserve terminal outcome and stored code. Regressions must distinguish complete/permanent failure/exhaustion/RETRY/held
results, preserve codes/budgets and perform no unintended upstream requests.

### P2 RC2-R4 — authority withdrawal can omit denial audit

`packages/m365/directory.ts:233`, `ingest.ts:230`, `authority.ts:78`. Withdrawn authority correctly stops subsequent I/O
and publication, but failure recording rejects the same authority and the top-level services swallow that rejection.
No workspace security denial is appended. Pre-claim permission refusals also lie outside these handlers.

Handle scope/permission denial at public service boundaries; append safe workspace audit independently of the rejected
client transaction. Never write an inaccessible-client audit. Test withdrawal between pages/before publication for both
services plus pre-I/O refusals; assert zero subsequent I/O/publication, proper denial audit and no secrets/vendor IDs/DTOs.

## Other scope judgments

Transport/activation preserve fixed authorities, disjoint GET/auth POST, redirect refusal, same-token tenant checks,
scoped credential-version cache, bounded 401 recovery and private numeric activation expiry. Directory publication remains
atomic and retains last-good generation. Inspected sign-in code/tests support durable budgets, full-precision half-open
validation, exact leaf partitions, immutable versions, failed-split retention, crash boundaries and no narrowing of coverage.

No separate S2-B finding for OPEN request state: per-root jobs govern this scope and aggregate presentation is S2-C;
the immutable request-outcome trigger and permitted root requeue explain the choice. This does not excuse R3.
F5 correctly uses a lower leaf cap: 500 DTOs/page × 20 pages prevents reaching the hard row-overflow page beyond 10,000.
The additive retry migration/runtime self-check passed the existing upgrade test; accepted migrations stayed frozen.
No Stage 1 public-shape/Decisions privacy regression was identified in inspected delta/evidence.

**Four obligatory findings remain. S2-C must not advance.** None requires waiving an approved contract; proposals to remove
these obligations would require renewed architecture approval.
