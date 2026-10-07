# Stage 1 independent review

Review the implemented Atlas Stage 1 checkpoint. Read CHECKPOINT_REPORT.md, AGENTS.md and the current diff. Read the specification sections needed to assess the change; do not load the entire architecture into context by default.

Prioritize correctness and tenant isolation: composite keys, auth scope, connection mapping, no secret fields in context, durable duplicate/revision semantics, atomic observation/audit, stale/error resource handling, bounded retries and Decisions failure/urgency behaviour. Ensure synthetic demo data and mocked transports are not reported as live verification.

Reproduce relevant tests. Distinguish blockers from optional improvements. Do not expand scope into UI, remediation, M365/PowerOffice connectors or multi-agent orchestration.

Write REVIEW_REPORT.md with: verdict; concrete findings ordered by severity; file references; reproduced commands/results; required fixes; and what is safe to implement next. If no blocking findings remain, say so explicitly and identify any unexecuted PostgreSQL/live gates.
