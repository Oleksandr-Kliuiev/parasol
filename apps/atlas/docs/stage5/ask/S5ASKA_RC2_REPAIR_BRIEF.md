# ASK-A rc2 repair brief — same Opus/high session

Resume session60e70e73-4279-474b-a915-b95e4abfb6d9, explicit claude-opus-5-5/high. Root transferred sole write ownership.
Repair ASK-A only against the SAME approved six-file RC3 architecture; no new scope or authorized exceptions.
Initial actual-code package S5ASKA-rc1 58d63eafa205a6dad0202b43df1ba49851e04b10c8bf1fbb1a2d306fa1827353 is CHANGES_REQUIRED.
Read docs/stage5/reviews/ASTRA_S5ASKA_RC1.md (SHA256 f9c348951f71e2cacb60948462b56cdf3d6096ee560ddc3b6220d904a172e03f).
Initial implementation brief still controls. Use verification/stage5/S5ASKA_REPAIR1_BASELINE.json as exact write baseline.
Old source archive, reports, review, receipts, logs, evidence and accepted dependencies remain immutable.

## Required closure

R1: An absolute min(2s, original remaining) deadline must bound EACH private DB phase, including caller-visible failure.
Sequential waits must not reset the budget per statement. Preserve same owner until actual outstanding work and cleanup
settle; a timeout race never releases capacity. Preserve original8s and fixed stage-specific failure mapping. Stop further
work after the phase terminates. Add real-PG sequential-lock regressions for authentication and applicable fenced phases,
observe queries/locks/owner counts at public phase timeout and actual drain/recovery. Do not weaken uncertainty holds.

R2: Check terminal/deadline state at actual async boundaries inside private auth, admission, source helpers and finalization.
After a disconnect/deadline/phase failure, do not start another graph/resource/read/charge/audit/phase; rollback and necessary
cleanup must still drain. Add HTTP+PG Observation-block/disconnect/release with separately blocked Entity and assert no new
Entity/resource query starts, no later charge/audit/phase, same owner held until actual settlement and released exactly once.

R3: Validate/account every original selected snapshot before PENDING/UNAVAILABLE -> MISSING projection. Malformed original
items ->503 ASK_SOURCE_INVALID; original4MiB/caps overflow ->413 ASK_TOO_LARGE; no planner/completion audit. Preserve existing
valid missing/null snapshots and closed source eligibility, exact output/coverage and no bank leakage. Test both PENDING and
UNAVAILABLE with original malformed/oversized source, plus current valid positive cases. Optional minimization note is not an
approved amendment. No schema/shared-source/provider changes.

R4: Undecodable one-segment client paths remain inside Ask's owner/parser/auth/semantic/scope boundary. Valid raw/body syntax
plus no/invalid credential ->401; valid credential+valid body ->403 and one safe workspace ask.scope_denied. Never fall through
to Express parameter errors/generic parsers; preserve early raw syntax/type/size precedence, exact fixed DTO/header/noecho and
HEAD/OPTIONS synchronous404. Add fixture+DB credential-valid/invalid and semantic precedence/denial-count cases for malformed
percent sequences. Never grant authority from a rewritten path/body. Use cohesive Ask-only integration.

Independent probes are available read-only at /tmp/atlas-stage5/astra-s5aska-rc1/source/review-hostile.test.ts; adapt useful
assertions into focused repository tests, preserve originals. All33 Ask unit+33PG tests passed; five extra hostile assertions
failed. Reviewer reproduced214 built files and33 operator files. It observed successful measured drain and did not establish
premature release; synthetic P2028 evidence is limited. Preserve explicit oversized-output audit qualification from rc1;
it was not a fifth required finding or a contract amendment.

## Scope and verification

Allowed edits: Ask source/modules under packages/ask, apps/api/src/ask*, apps/api/src/db/ask*; narrow main.ts/atlas.module.ts/
db/app.module.ts integration if required; existing/new focused Ask tests/support and related context-map/runbook/test routing.
Keep all six norms, prior reports including S5ASKA_IMPLEMENTATION_REPORT.md, manifests/seals/review/evidence/baselines,
coordinator status/workflow/AGENTS and rc1 external evidence immutable. No operator/browser/schema/roles/deps/lockfile/core auth
or domain/shared fixture changes. Report exact need before any extra shared-source/dependency/architecture change. Root remains
read-only while you write. No ASK-B, remote, commit, PR, deploy or self-acceptance. Keep modules near500/hard700.

Use NEW /tmp/atlas-stage5/s5aska-repair1-work/ for ALL checks/scripts/probes/negative controls/production copies and failures;
never overwrite /tmp/atlas-stage5/s5aska-impl or Astra review evidence. Preserve each failed attempt. Avoid indefinite barriers:
race gates with request completion and bounded timeout, always release in finally, stop orphan jobs/disposable DBs. After two
ineffective repairs diagnose/re-plan; immediately report an unenforceable invariant rather than relaxing it.

Run focused checks while repairing; final ALL14 required checks once ready, with full logs and exact counts, plus fresh clean
production copy npmci/generate/build/prune and OFF/MOCK foreign-cwd smoke (question/cap200, Gateway201, Host/CSP, all32assets+
manifest unchanged). Use silent /tmp/atlas-stage3/claude-tools/pgenv.sh, never read/print wrapper/env/URLs/credentials. Negative
controls must detect removed NEW phase deadline, per-await terminal, unavailable snapshot validation/cap and malformed-path
ordering/denial guards; restore exact bytes and rebuild. Preserve meaningful assertion failures rather than timeout-only proof.

Write NEW docs/stage5/ask/S5ASKA_RC2_REPAIR_REPORT.md: closure evidence R1-R4, changes, checks/counts, physical settlement proof
and remaining uncertainty, failed attempts, production/negatives, baseline preservation. Acceptance stays PENDING fresh explicit
Astra/xhigh. Stop after repaired ASK-A and return sole checkout ownership on exit, confirming background work is stopped.
