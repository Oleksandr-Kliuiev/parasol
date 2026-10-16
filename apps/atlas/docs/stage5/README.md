# Stage 5 — operator console, first slice

Owner selected **operator console first, then Ask Atlas** on2026-10-10. Stage1–4 MOCK engineering is accepted, most
recently S4C-rc5. This is a new architecture proposal, not acceptance of a UI or of LIVE.

The first result is a local read-only console: choose an authorized client, inspect its observation queue, select one
observation and inspect existing context/source evidence. Visible uncertainty and source severity survive presentation.
Read-only means no business/domain mutations. Existing tool execution audits/ToolExecution and scope-denial security
audits remain mandatory; Stage1 GET clients/overview/observations do not acquire new success-audit writes.

| Concern | Entry |
|---|---|
| Outcome and exclusions | [01_SPEC](01_SPEC.md) |
| Existing API/DTO contracts and evidence selection | [02_CONTRACTS](02_CONTRACTS.md) |
| Browser credential, origin and asynchronous isolation | [03_SECURITY_AND_STATE](03_SECURITY_AND_STATE.md) |
| Components, build and UX | [04_ARCHITECTURE_AND_UX](04_ARCHITECTURE_AND_UX.md) |
| Assignments and stopping checkpoints | [05_IMPLEMENTATION_PLAN](05_IMPLEMENTATION_PLAN.md) |
| Acceptance cases and gates | [06_ACCEPTANCE](06_ACCEPTANCE.md) |

Status: [REVIEW_STATUS](REVIEW_STATUS.md), [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md).
Dependencies: accepted Stage1 read APIs/Gateway, Stage2 all-of discovery, existing loopback API process.
S4C is preserved; financial information is deliberately outside this initial console's data paths.
