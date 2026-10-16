# Implement Atlas Stage 2 — M365 Correlation

Use this prompt only when the owner requests implementation and S2-ARCH is accepted for the current manifest.
First read AGENTS.md, docs/AI_CONTEXT_MAP.md, docs/stage2/README.md and REVIEW_STATUS.md.
Verify both Fable 5.1 and Astra verdicts refer to the current REVIEW_MANIFEST package hash.
If a review is missing or has obligatory findings, resolve the architecture gate before schema/adapter implementation.

Implement docs/stage2/04_IMPLEMENTATION_PLAN.md through checkpoints S2-A/B/C, using contract sections as needed.
Preserve Stage 1, frozen migrations, ClientContextV1, source urgency, human triage and Decisions redaction.
Use real PostgreSQL/Prisma tests; distinguish synthetic transport, real database and live vendors in reports.
Do not widen Graph access, add writes/UI/AI payload, deploy or provision accounts as routine implementation choices.
Unknown/missing/partial/stale data is visible; no automatic canonical identity from names or hostname.

Create docs/stage2/IMPLEMENTATION_STATUS.md during implementation; keep reports focused on changed files,
behavior, actual tests, findings and open external gates. Follow root context limits and add focused context routing
for packages/m365 and packages/correlation as those areas grow. No claim that later stages are already approved.
