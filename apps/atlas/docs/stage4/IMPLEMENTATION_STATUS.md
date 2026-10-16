# Stage 4 implementation status

Latest checkpoint: **S4-C ACCEPTED on S4C-rc5** by explicitly assigned GPT-6 Astra/xhigh actual-code review.
[Acceptance](reviews/ASTRA_S4C_RC5.md) · [architecture](REVIEW_STATUS.md) · [workflow](../DEVELOPMENT_WORKFLOW.md).

| Checkpoint | State / exact seal |
|---|---|
| S4-A foundation/isolation/exact roles | ACCEPTED — S4A-rc5; `verification/stage4/S4A_APPROVED.json` |
| S4-B built-in synthetic sync/publication/recovery | ACCEPTED — S4B-rc2; `verification/stage4/S4B_APPROVED.json` |
| S4-C dedicated reads/API/CLI and maintenance | ACCEPTED — S4C-rc5; `verification/stage4/S4C_APPROVED.json` |
| S4-LIVE vendor contract/read admission | NOT_STARTED — DEFERRED_BY_OWNER |

Current package `fa688a1a1f7161fc013e2c7ff63cba1b603c92c35d5cd68d02d446a600c99ae9`; manifest `verification/stage4/S4C_RC5_MANIFEST.json`.
Unchanged dual-approved eight-file architecture package `d848b026efcc2af30c7900ef6f5325e31c04c11825d4ec089dcf6baf984873ec`.
Exact reviewed inventory, dirty-file hashes, archive, native assignments/receipts, checks and administrative deltas are bound
by the S4-C seal. Accepted Stage1/2/3 norms, installed migration artifacts and all earlier seals/history remain preserved.

S4-C provides fresh bearer/all-of status and summary reads, atomic audit-before-return, DB-clock expiry/precedence,
strict synthetic/no-store HTTP routes and five operator CLI commands, with Gateway/business-context exclusion.
Maintenance uses fresh single-use maintain admission, paired execute-only runner, one original10s budget including
connection/setup/COMMIT,1s lock timeout and explicit bounded purge. An original-budget watchdog sends backend-specific CancelRequest for in-flight setup/body/rollback work; effective earlier
server deadlines and structured terminal causes preserve idle-timeout classification. Runner settings are established/verified BEFORE BEGIN
on one dedicated pg connection, including inherited role/database/startup timeouts. Pinned pg8.23.1 is a runtime dependency.

Final source checks: **223/223 unit/PGlite + 565/565 actual PostgreSQL17**, all11 required checks passed.
Post-classification packaging checks: offline production install/import, full dependency trees, typecheck,217/217 unit,
6/6 PG maintenance, whitespace passed; dependency versions/integrities and runtime source were unchanged.
[Current implementation/repair report](S4C_RC5_IMPLEMENTATION_REPORT.md) · `verification/stage4/S4C_RC5_IMPLEMENTATION_EVIDENCE.json`.
Independent reviewer commands/results and exact qualifications are in the acceptance report; implementer tests are separate.

Original [RC1 review](reviews/ASTRA_S4C_RC1.md), [RC2 review](reviews/ASTRA_S4C_RC2.md) and
[RC3 review](reviews/ASTRA_S4C_RC3.md), [RC4 review](reviews/ASTRA_S4C_RC4.md) stay CHANGES_REQUIRED in history.
The final acceptance closes late-COMMIT beyond10s (including inherited nonzero transaction_timeout) and acquisition-timeout
classification, setup-query cancellation, stricter idle-timeout classification, first-terminal observation timing and known cause precedence. Original probes, negative controls, failed runs and repairs remain available in durable evidence.
One cohesive native actual Opus5.5/high session implemented and repaired S4-C; native Anthropic subscription, no credits,
API route or fallback enabled. Attributable subscription quota is unknown.

Residuals: before PostgreSQL issues a cancel key, server login code cannot be cancelled by this runner; the client closes
its socket at its bound and no runner statement can execute. This is not application SQL or cleanup work. CancelRequest
delivery failure falls back to socket close; the server transaction timer remains authoritative once armed. PG17 required; up to250ms conservative deadline reserve; atomic PostgreSQL commit interrupt window and lost
COMMIT acknowledgement may leave an unknown outcome, with no automatic retry. Reads/admission can wait on the fence;
every successful read audits; cleanup may hold the fence up to10s;1000 retained attempts can block sync until eligible
cleanup. Deadlock-victim tests construct a State/fence cycle; natural Connection UPDATE orders are covered separately.
Prior S4-A ACL/fixture qualifications and S4-B FK tuple-lock qualifications remain in their exact accepted reports/seals.

Stage4 MOCK A–C is complete. No further work, deployment, schedule or LIVE access follows from this acceptance.
No vendor auth/API/account, persistent pilot setup, binding, financial write or production readiness is established.
LIVE remains DEFERRED_BY_OWNER and requires its separate amendment, reviews and explicit admission.
