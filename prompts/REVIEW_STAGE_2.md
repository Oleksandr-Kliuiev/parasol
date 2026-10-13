# Independent architecture review — Stage 2

Review only the fixed specification package identified by docs/stage2/REVIEW_MANIFEST.json.
Read root AGENTS.md and docs/stage2/AGENTS.md, then docs/ROADMAP.md, docs/stage2/README.md,
01_SPEC, 02_CONTRACTS, 03_CONNECTOR_SYNC, 04_IMPLEMENTATION_PLAN, 05_ACCEPTANCE and 06_SOURCES_AND_ADR.
Inspect existing source through docs/AI_CONTEXT_MAP.md only as needed to verify compatibility assumptions.
Do not implement, migrate, call live tenants, modify accounts or overwrite Stage 1 review.

Assess independently; do not read the other review before your first verdict. Focus on concrete failure modes:
- scope, token/cache/nextLink authority and connection revocation;
- directory id vs deviceId, guest identities, canonical confirmation, stale/deleted mapping and false causality;
- durable publication, retries/crashes/races, late sign-ins, coverage and retention;
- permissions across old API/context/mapping/CLI/audit paths and no new data in Decisions;
- implementable Prisma/SQL/RLS contracts and testable acceptance gates;
- roadmap dependencies (approval before write) and accurate approval scope.

Return a concise Markdown report with actual model identity, date, manifest package hash, verdict APPROVE or
REQUEST_CHANGES, scope, obligatory findings (priority/file/section/scenario/fix/test), nonblocking notes and limits.
If no blockers, explicitly say none. Do not invent a passing implementation test or live check.
Approval covers this Stage 2 design and roadmap sequencing only; it cannot approve detailed architecture for Stages 3–9.
After fixes, rereview the new hash; historical approval never automatically transfers to changed normative files.
