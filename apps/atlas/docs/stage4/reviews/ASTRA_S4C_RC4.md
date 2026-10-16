# S4-C S4C-rc4 independent actual-code acceptance

**Verdict: CHANGES_REQUIRED.** The RC3 setup-cancellation counterexample and the specific stricter-timer idle-timeout counterexample are repaired. Two bounded failure-classification findings remain: early generic terminal evidence is discarded, and known non-timeout SQLSTATEs can be overwritten near the original deadline. Neither new probe demonstrated late application writes. LIVE remains **DEFERRED_BY_OWNER**.

Review date: 2026-10-10. Fresh independent native reviewer assignment: **gpt-6-astra / effective xhigh**, task `/root/astra_s4c_rc4`, fresh context. The explicit native assignment is the available external identity evidence; this report's self-description is not response-model telemetry. Independent provider response-model telemetry and attributable subscription quota are not exposed. No reviewer fallback, API billing route or usage credits were enabled. No other current-artifact verdict was consulted. Earlier reviews were read only for named closure requirements.

No repository edits, builds, generators, formatters, vendor/account/deployment or production operations were performed. All database work used the approved silent wrapper, disposable PostgreSQL 17 databases and unique roles. Test-only settings, trigger objects and locks were confined to those disposable databases, with teardown. Reports and reviewer scripts/logs are only in the assigned `/tmp/atlas-stage4` locations. Credentials, URLs, cancellation keys and raw database errors were not printed.

## Exact identity and preservation

- HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `planning/stage2-m365`, plus the exact frozen dirty inventory; this is not acceptance of HEAD alone.
- Manifest `verification/stage4/S4C_RC4_MANIFEST.json`, SHA-256 `eaab52cc390a5c79ec80aec33183bab2a338220df2fc6b13ddf5f205a6f7945d`.
- Package hash `4281789ff69b853a566b00816be8e5aa27ee380a9fcb085e000468b4ada6bd45`.
- Working inventory hash `85e06c1e83fdd6e0467ad027e67b6e753de7e14468a2d0e57894656e7ed0a22b`.
- Source archive `/tmp/atlas-stage4/S4C_RC4_SOURCE.zip`, SHA-256 `9bcb40ece898c7ff829f8982277143658cec65f0f4ce1b0a4f540fb3317425ce`; repository `verification/stage4/S4C_RC4_PACKAGE.zip` is byte-identical.
- Accepted S4-B dependency seal SHA-256 `bf0c92fa0ad30a28b4e522b4f9fd6ee4472330c8be9db48f0b55d8dd3792b697`; design seal SHA-256 `b37061ad1d673aa3ca05cefd049faeafdc98cd8d88d319921d5a8e44375305ad`.
- Eight-file architecture package `d848b026efcc2af30c7900ef6f5325e31c04c11825d4ec089dcf6baf984873ec` verified byte-exact.

Before/after checks verified all **879 inventory files**, all **833 source/archive entries**, both aggregate hashes, archive bytes, the exact RC3 delta, S4C baseline delta, accepted S4-B manifest/archive/review hashes, and dependency preservation. The only working-tree paths outside the inventory are this artifact's manifest and archive self-exclusions. Preserved scope includes the 11 Stage2 and eight Stage3 normative files, eight Stage4 normative files, 24 accepted migration artifacts and 362 prior checkpoint/fixture artifacts. No implementation, schema, role, authority, dependency-version/integrity, public API or CLI scope changed during review.

## Required findings

### F1 — P2: retain the time of an early generic terminal event

**Location:** `packages/poweroffice/runner-transaction.ts:165-167`, `:221-224`; classification at `:73-75`.

The session error listener retains a SQLSTATE only. When the driver emits a generic terminal error before the effective transaction deadline, it records neither that failure nor its time. If the callback next attempts a query after the deadline, `failedAt` measures that later query rejection and `serverDue` becomes true. The runner therefore calls an already-observed, early transport failure a timeout. This is avoidable using information the process already received; it is not an indistinguishable disconnect first observed at the timeout instant.

Independent real-PG helper probe `/tmp/atlas-stage4/astra-s4c-rc4/early-transport-probe.mjs`:

1. Set `transaction_timeout='1s'` only for the disposable runner in its disposable database.
2. Call the actual `runBoundedTransaction` with a fresh original budget; execute a bounded `SELECT 1`.
3. Through a test-only client capture, destroy its actual socket while idle. The unchanged production listener and an observer receive a **generic error at 8 ms**, with no SQLSTATE.
4. At 100 ms, independently query `pg_stat_activity`: **zero runner backends**, before the one-second timer could fire.
5. Let the callback remain idle, then request another bounded statement after 1.5 seconds.

Observed **POWEROFFICE_CLEANUP_TIMEOUT at 1,519 ms**; required **POWEROFFICE_CLEANUP_FAILED**. The callback sleep and socket fault are explicit helper-level test seams, not a claim that the public maintenance body deliberately sleeps or exposes its client. Scheduling gaps plus actual transport loss can expose the same retained-state defect. Backend termination and rollback are correct; the fixed result is wrong. Evidence: `early-transport.log`.

**Required repair/closure:** retain the first terminal observation, including when a generic event was observed, independently of a later callback/query failure time. Infer timeout from the effective timer/watchdog only when earlier known terminal evidence does not establish a non-timeout loss. Do not parse messages. Add a deterministic PG regression for this early generic loss with the observer proving backend disappearance before the effective deadline; retain the genuine one-second idle timeout as TIMEOUT and the structured early administrative termination as FAILED. Keep the existing body/commit cancellation behavior and original timers unchanged.

### F2 — P2: known non-timeout SQLSTATEs lose precedence in the original deadline window

**Location:** `packages/poweroffice/runner-transaction.ts:73-80`, especially `:78`; claimed preservation in `docs/stage4/S4C_RC4_IMPLEMENTATION_REPORT.md:123-126`.

The new `serverDue`/`expired` inference correctly checks that no structured state exists, but the later unconditional `budget.left() <= 250` fallback does not. Consequently a positively known administrative termination, privilege error or scope/binding refusal is relabelled as timeout once classification occurs in that window. A known cause can be delivered/processed after a scheduling delay; checking the clock later does not replace its SQLSTATE. The report's statement that a known structured non-timeout terminal cause is never relabelled is therefore false.

Independent pure-function observations in `/tmp/atlas-stage4/astra-s4c-rc4/early-terminal-probe.mjs` call the actual `runnerFailure` with structured states **57P01, 42501 and PO010**, `left()=0` and expired/serverDue context. All three return **POWEROFFICE_CLEANUP_TIMEOUT**, instead of **POWEROFFICE_CLEANUP_FAILED**. These are classifier-level observations, not claims of three end-to-end SQL runs. The same probe's real-PG control terminates a backend administratively at 8 ms, resumes at 1.5 seconds under the stricter timer and correctly returns FAILED: structured early evidence is useful until the later original-window fallback overrides it. Evidence: `early-terminal.log`.

**Required repair/closure:** preserve positively known non-timeout SQLSTATE/fixed-code precedence throughout classification, including after rollback and across the original deadline window. Restrict elapsed-time inference to genuinely unclassified losses; retain timeout SQLSTATEs/own genuine timeout evidence, conflict mapping and initialization/readiness distinctions. Add focused cases at 251/250/0 ms remaining for query SQLSTATEs and session-terminal SQLSTATEs, including 57P01/42501/PO010, 40P01/40001, timeout states and code-less losses. Revise the overly broad old test title/assertion contract (“any failure”) and align the report with the final behavior. No timer, cancellation protocol, role/grant or public contract expansion is requested.

## Cancellation closure and phase assessment

- **Acquisition/login:** independent repository tests preserve original/default connect bounds, wrong-password readiness, CLI timeout exit 1 and no late application cleanup/audit. A separate reviewer probe used a three-second DB-local login trigger and one-second connect timeout: TIMEOUT at **1,011 ms**, body never entered; the login backend was still in `PgSleep`, and was gone on the later observation. This confirms the reported PostgreSQL pre-BackendKeyData boundary. I consider it a nonblocking boundary of the application transaction/acquisition contract: server-admin login code runs before the runner has a cancellable application session, and the runner cannot issue later SQL on the closed connection. It must remain explicit; acceptance would not promise termination of arbitrary server login code. No additional server privilege/configuration is required by this review.
- **Initial setup and timeout installation:** relation-free `current_setting` precedes installation; the catalog readback now follows session statement/lock/transaction timeout installation. The actual admitted cleanup under the held `pg_settings` lock returned TIMEOUT at **1,010 ms**; the lock remained held until 10.5 seconds, with no backend and no domain/audit change, then positive cleanup succeeded. RC3-F1's counterexample is closed.
- **Watchdog:** independently run helper test disables all three server timers solely in the test body. The protocol cancel stops the 30-second sleep at **10,018 ms**, with no runner backend. Inspection confirms a 16-byte PostgreSQL CancelRequest using this client's PID/cancellation key, to this client's same host/port (Unix socket path supported), with a short socket and no retry. Keys/URLs are not logged or exposed. The new socket grants no database or role authority.
- **BEGIN/body/idle:** same-connection session timer installation before BEGIN, stricter inheritance, the 250 ms anchor check and one-second lock cap remain. The exact RC3-F2 genuine stricter one-second timer plus 1.5-second idle case now returns TIMEOUT. F1 above is the complementary non-timeout case still required.
- **COMMIT:** default and role/database/startup inherited 4+4+4-second login/routine/deferred-COMMIT tests time out with complete pointer/snapshot/attempt/audit rollback, delayed re-observation and no working backend; a within-budget commit succeeds. The earlier late-COMMIT counterexamples stay closed.
- **ROLLBACK/close:** the original guard remains through rollback and supplies the two-second socket backstop to operations started after firing; tests leave no application backend/effects. Cancellation delivery failure may require the socket backstop; inside a transaction the server's own timer remains authoritative. Absolute interruption of server/network/kernel work is not claimed. PostgreSQL's atomic commit point and lost COMMIT acknowledgement remain unknown-outcome qualifications with no automatic retry, not a guarantee that all failed acknowledgements mean rollback.

Inspection and independent nearby tests found no additional required issue in C1/C2/C4: dedicated bearer/current all-of authority and last-lock recheck; exact DTOs, DB-clock precedence/expiry and atomic read audit; HTTP synthetic/no-store and UNAVAILABLE503; Gateway exclusion; strict CLI flags/env token; single-use cleanup admission, pairing/confinement, ACTIVE refusal, no-State no-op, disabled purge, same-client sibling isolation, sequence/history preservation, 1000-row bound; audit rollback and both constructed Connection-update deadlock victims. API/CLI code remains unchanged from RC3.

The JavaScript network trap allows only the paired database host/port for the Node `pg` runner and matching host lookup; cancellation uses that same endpoint. Other targets remain trapped with a positive self-control. Prisma native-engine sockets are outside those JavaScript hooks, so this is not an operating-system egress guarantee. MOCK evidence establishes no vendor/accounting/live completeness or production readiness.

## Independent commands and evidence

Commands used `/tmp/atlas-stage3/claude-tools/pgenv.sh node --experimental-strip-types --test` with absolute paths under `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1/`:

- `tests/poweroffice-{runner-phases,runner,read}.test.ts` plus `tests/pg/poweroffice-{cleanup-phases,cleanup-deadline,cleanup-inherited,api,cli}.pg.test.ts`: **34/34**, zero failed/cancelled/skipped, 75.507 seconds. Log `/tmp/atlas-stage4/astra-s4c-rc4/targeted.log`.
- `tests/pg/poweroffice-{maintenance,cleanup-budget,read,read-auth,fence}.pg.test.ts`: **30/30**, zero failed/cancelled/skipped, 31.736 seconds. Log `/tmp/atlas-stage4/astra-s4c-rc4/nearby.log`.

Total **64/64 repository tests = 12 unit + 52 PG17**. The API tests use the existing built artifact; no reviewer build occurred. Three additional reviewer observation scripts, invoked through the same wrapper without `--test`, are `early-transport-probe.mjs`, `early-terminal-probe.mjs`, and `login-boundary-probe.mjs`, with matching logs in that directory. Counterexample observations are separate from the 64 passing repository tests. `git diff --check` passed. `verify.py`, `inventory-before.log` and `inventory-after.log` hold the identity verification; the last run was after all database work.

The implementer's eleven required checks were independently inspected as evidence, not relabelled as reviewer execution: all exits zero, **220/220 unit/PGlite and 562/562 PG**, schema validation/generation, typecheck, API build/smoke, PG17, drift and whitespace. The failed first final run's test-only type error remains recorded. Receipt `S4C_RC4_OPUS_EXECUTION.json` records the original session `02752ee0-ea51-4249-b089-d6aba4205d5d`, requested/observed `claude-opus-5-5`, high, native Anthropic subscription, no credits/API fallback. No full unchanged suite was redundantly repeated by this reviewer.

## Stopping point

Return F1/F2 to the original cohesive implementer. This report does not self-seal or authorize dependent work, deployment or LIVE. A bounded classification-only repair that preserves timers, cancellation, authority and existing contracts can return to this same independent session at its retained actual **xhigh**, with exact new artifact identity, delta and affected-check evidence. New cancellation/invariant scope requires a fresh explicit Astra/xhigh review. Neither implementation evidence nor this partial closure substitutes for acceptance of the repaired exact artifact.
