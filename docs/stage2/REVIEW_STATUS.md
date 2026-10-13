# Stage 2 — architectural review status

**S2-ARCH — ACCEPTED, 2026-10-08.** Both required reviewers approve the same current package.
Version **1.0-rc5**, SHA-256 `1d3b1064c2633ed64ab2089a7ea62401e9415a72b16ba5a9dcd9a50c870a1efb`.
Identity: [REVIEW_MANIFEST.json](REVIEW_MANIFEST.json); immutable snapshot: [RC5 package](reviews/RC5_PACKAGE.zip).

| Reviewer | Model / effort | Verdict | Evidence |
|---|---|---|---|
| GPT-6 Astra | gpt-6-astra / xhigh | APPROVE RC5 | [Report](reviews/ASTRA_RC5.md) |
| Native Anthropic Fable 5.1 | claude-fable-5-1 / high | APPROVE RC5 | [Report](reviews/FABLE_NATIVE_RC5.md), [response-model evidence](reviews/FABLE_NATIVE_RC5_EXECUTION.json) |

The orchestrator and Astra independently verified all 11 file hashes and aggregate. Fable's Read/Glob/Grep
session checked changed content but could not independently compute hashes; its report discloses this limit.
Astra uses the explicit built-in subagent model override; no separate upstream response metadata was exposed.
Fable identity is verified from actual response message.model/message_start fields, with native firstParty authentication.
No API billing or usage credits were enabled; API cost estimates do not measure subscription quota.

## Scope and next gate

Approval covers Stage 2 architecture and roadmap sequencing. It does not accept implementation, live vendors,
production deployment, or detailed designs for Stages 3–9. The owner requested Stage 2 implementation.
**Tasks 2.1–2.3 / S2-A are independently ACCEPTED** on S2-A-rc5 by Astra xhigh;
see [implementation status](IMPLEMENTATION_STATUS.md) and [acceptance](reviews/ASTRA_S2A_RC5.md).
**Tasks 2.4–2.6 / S2-B are ACCEPTED** on S2-B-rc4 (fresh Astra xhigh code acceptance on RC3, bounded administrative closure on RC4);
[code acceptance](reviews/ASTRA_S2B_RC3.md), [final identity](reviews/ASTRA_S2B_RC4.md).
The bounded directory retry corrective policy was approved by both named reviewers on the same exact hash before implementation;
[policy and evidence](IMPLEMENTATION_STATUS.md#s2-b-accepted-artifact-and-verification). S2-C/LIVE remain NOT_STARTED. Stage 1 live-read remains open.

Before implementation: npm test 81/81, typecheck PASS, test:pg 114/114 on PostgreSQL 17 PASS.
These are Stage 1 baseline results, not Stage 2 acceptance. The dirty Stage 1 REVIEW_REPORT.md remains preserved;
its hash is recorded in the manifest. No database migration or source change preceded architecture acceptance.

## Historical review corrections and closures

Early CLI RC1–RC3 reviews used a DeepSeek endpoint and were incorrectly attributed to Fable.
[Attribution correction](reviews/PROVIDER_ATTRIBUTION_CORRECTION.md). Their original reports remain preserved
with warnings and never satisfy the required Fable gate. Exact RC1–RC4 packages are archived under reviews/.

Native [Fable RC3](reviews/FABLE_NATIVE_RC3.md) requested explicit directory freshness/retention semantics,
local disable/revocation, and role provisioning outside migrations. RC4 addressed these; native
[Fable RC4](reviews/FABLE_NATIVE_RC4.md) approved. [Astra RC4](reviews/ASTRA_RC4.md) required the missing
least-privilege Connection lock grant. RC5 closes it and adds role-upgrade, Graph-bound, cursor-key and lifecycle clarifications.
Both reviewers examined RC5 independently, without the other's verdict in the initial brief.

This status and review evidence are outside the normative hash. Any further normative change requires updated
identity and both approvals. Status edits alone cannot establish approval.
