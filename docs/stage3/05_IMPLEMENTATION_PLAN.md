# Stage 3 implementation checkpoints

Codex coordinates. Architecture gate: two fresh independent reviewers, gpt-6-astra/xhigh and native claude-fable-5-1/high,
same frozen current artifact. Actual code acceptance: explicit fresh Astra/xhigh each checkpoint; implementer report is not acceptance.
Provider routing and actual assistant model evidence must match requested identity. Native subscription, no API/credits/fallback.

| Checkpoint | Cohesive scope | Writer | Required independent evidence |
|---|---|---|---|
| S3-A | Typed contracts/canonicalization, new tables/RLS/grants/immutable fields, COMPLETE authority fence/definer/owner triggers, immutable signer expiry/epoch proof, permission CHECK migration, preview/request/idempotency | Native Opus5.5/high | schema/upgrade, scope/grants, non-superuser FORCE RLS fence initialization/mutation, epoch restoration, hashes/collision/rollback; no port call |
| S3-B | Stored-preview approval/rejection/revocation/cancellation, atomic reservation/single-use permit | Native Opus5.5/high | independent approver without request grant, exact content, cross-actor/client denial, owner revocation races, expiry/consumption, audit rollback, deadlocks; no create yet |
| S3-C | Built-in synthetic store/port, execution/result publication, bounded verification/recovery, CLI and complete journey | Native Opus5.5/high | possible effect crash/timeout/late results, zero duplicate create, no network, full journey/regressions |
| S3-LIVE | Current official adapter contract + explicit write admission + live verification | Separate future reviewed amendment | Never inferred from MOCK success |

S3-A installs the complete fence role, function, policies, initialization and owner mutation triggers before any fenced
preview/request is usable. It also ships epoch/expiry capture with accepted ApiToken RLS unchanged. No partial fence is accepted.
Stop at each checkpoint. Preserve previous accepted identities; review any necessary adjacent changes.
S3-A integration delta includes safe fence-error mapping, accepted bind/activation/disable/owner-seed regression tests and
RUNBOOK dependency note; PROTECTED_TABLES + exact action grants and token lifecycle back-relations. Test FORCE action rows
via scoped runtime, never unscoped nonsuperuser owner. All accepted source deltas require actual checkpoint review.
No persistent current/pilot DB migrations or provisioning in local engineering; tests create/drop their own disposable databases.

Expected entry files: packages/actions/{contracts,canonical,policy,authority,requests,approvals,reservation,execution,
verification,recovery}.ts; packages/actions/mock-port.ts; focused operator command module; prisma/actions.prisma and new migrations.
These are domain boundaries, not mandatory tiny files. Keep active files ≤500, hard 700; thin orchestration and direct imports.
Update context routing at the first code checkpoint with the reviewed integration delta; nested area AGENTS routes this design now.

Checkpoints run focused checks during work, then: npm test, schema:validate, db:generate, typecheck, api:build, api:smoke,
test:pg (disposable PG17), db:check:pg17, db:check:drift and git diff --check, plus meaningful action tests. No new tests that
merely mirror implementation. Include owner upgrade from accepted Stage 2, duplicate-source race and confinement checks.
Archive safe logs/commands/exit codes, package/commit identity, dirty-file hashes and findings/fixes. Record model/effort,
elapsed/rework and attributable usage if available; cache/API estimates are not subscription quota measurements.
