# ASK-A rc3 repair brief — remaining R2, same Opus/high session

Resume SAME native session60e70e73-4279-474b-a915-b95e4abfb6d9, explicit claude-opus-5-5/high. Sole checkout writer.
Exact prior artifact S5ASKA-rc2 package6bc4f1c656f7149e22422ba41d3a8cc495fc22ebb902f8104f8b8a1aad788115.
Fresh Astra/xhigh report docs/stage5/reviews/ASTRA_S5ASKA_RC2.md SHA2566fda86e70e6e5bded95f3c93022844272ee0f8422ae9788f84bdeb4bfe87b1e0:
R1/R3/R4 CLOSED; R2a/P1 and R2b/P2 OPEN. Keep accepted closures and surrounding invariants. Six RC3 norms immutable.
Exact write baseline verification/stage5/S5ASKA_REPAIR2_BASELINE.json. Original brief and rc2 repair brief still control.

## Required closure

R2a: currentToken performs three separately awaited SQL statements but Ask currently wraps it as one phase statement.
The actual delayed digest-setting return lets a NEW ApiToken SELECT physically start after run.end(), observed on real PG.
Ensure every actual helper statement consults terminal/original deadline/absolute phase BEFORE start and AFTER await; re-bound
statement timeout at actual statement boundaries, preserve currentToken SQL semantics/RLS/token visibility/DB clock. Cover
private authentication and ALL fenced/final token checks. Necessary rollback/cleanup drains under SAME owner; no timer release.
Keep accepted shared auth source immutable; use cohesive Ask-only integration. If impossible within approved source/contracts,
report concrete need BEFORE widening scope or relaxing the invariant. Add terminal AND original/phase deadline variants for
held digest-setting return: zero new token SELECTs, no subsequent actor/source/charge/audit/phase; owner held through actual
work/cleanup and released exactly once. Test nearby ordinary valid/revoked/rebound/expired auth and final rollback behavior.

R2b: fixture deny and publish check only before await options.demo(), then append new denial/completion audit after terminal.
Retrieve demo then check terminal/original deadline BEFORE append; inspect neighboring admission await before charging/source.
Add deferred-demo denial/completion/admission regressions for terminal/deadline, no new audit/charge/source, preserved positive
fixture audits and exact owner settlement. Reviewer used injected deferred demo, not ordinary HTTP scheduling; qualify honestly.
Do not suppress the evidence merely because normal demo usually settles quickly.

Independent probes: /Users/oleksandr/.codex/atlas-evidence/stage5/ask/aska/review-rc2/source/review-token-boundary.test.ts and
review-fixture-boundary.test.ts, plus review-hostile.test.ts. Read/copy/adapt narrowly; originals immutable. Current all14 final
checks317unit/PGlite,610PG17,50browser; independently317unit,37Askunit,41AskPG,5originalhostiles pass. Rc2 report's36Askunit is
stale; do NOT edit old report, report accurate current counts in NEW report. R2 regressions fail1PG+2fixture assertions.

## Scope, proof and stopping boundary

Allowed: focused Ask modules/packages, Ask HTTP/db wrappers, narrow existing approved composition IF required, focused Ask
unit/PG tests/support and routing docs. No shared auth/core/domain/schema/roles/dependencies/lockfiles/operator/browser/fixtures,
no six-norm edits, no prior reports/reviews/evidence/baselines/seals/status/workflow/root AGENTS modifications. Keep originals
and rc1/rc2 logs untouched. Root READ-ONLY until writer exit/stopped. Near500/hard700 line context budget applies.
Use NEW /tmp/atlas-stage5/s5aska-repair2-work for ALL logs/scripts/controls/prod copies; preserve failed attempts uniquely.
PG only silent /tmp/atlas-stage3/claude-tools/pgenv.sh; NEVER read/print wrapper/env/URLs/credentials. Bounded barriers and finally
cleanup; no indefinite hangs. After two ineffective attempts diagnose/re-plan rather than blind retries.

Run focused checks; ALL14 final required checks with exact logs/counts; new meaningful negative controls for internal helper
terminal/deadline and fixture post-await guards, exact source restoration/build proof; fresh production copy clean npmci,
generate/build/prune, foreign-cwd OFF/MOCK capability/question/Gateway/Host/CSP/no-store/assets proof. Preserve R1 real phase
physical-owner/cleanup tests and R3/R4 positives/negatives. Engine/pool cleanup beyond measured proof remains qualified;
no weakening held-owner uncertainty contract. Never claim promise settlement alone proves arbitrary physical cleanup.

Write NEW docs/stage5/ask/S5ASKA_RC3_REPAIR_REPORT.md with R2a/b closure evidence, changes, accurate counts, failures, negative
controls, production/physical proof and limitations, baseline/dependency/norm/operator preservation. Acceptance PENDING fresh
Astra/xhigh. Stop at ASK-A and return ownership, stop all background jobs/servers/disposable DBs. No ASK-B/remote/commit/PR/deploy.
Native included subscription only, explicit model/effort, no API/credits/fallback.
