# REQUEST_CHANGES — S2-LIVE operational plan RC4

2026-10-08. Fresh native GPT-6 Astra (`gpt-6-astra`), effective `xhigh`, `/root/astra_s2live_plan_rc4`.
No separate upstream response metadata exposed. Codex saved the returned read-only report.
Brief `772b9c5772bd5a2fe2bca24a40679dfba9921b7426ab01cf48d30b3c94c16914`;
plan package `4cc8024d01472f7d16118845499fb90778473e2f9a6d1bb06b13c3c85d6748d6`.
All 4 plan, 307 accepted, 11 normative entries and three aggregates verified; unchanged at completion.

Required R1: remove optional DISABLED/unbound Connection bootstrap. Accepted bindConnection only creates a new row:
a precreated ID yields CONNECTION_EXISTS, a different ID for the same workspace/system/tenant yields TENANT_ALREADY_BOUND.
Bootstrap must leave Connection empty. After owner disconnect, runtime confinement and operator authentication, separately
authorized accepted bind creates the DISABLED connection/provenance/lifecycle. Future helper tests must prove empty
Connection after setup and successful subsequent accepted runtime bind. No production binding change required.

No other required findings. Proposed owner exception is explicitly pending target-specific authorization; five grants,
ACTIVE actor, empty workspace permissions, token digest/expiry/collision rules fit schema/auth. Recording/redirect/safe
failure guards, blocked L3, retry budgets and separate harness/final LIVE gates are adequate for conditional preparation.
Read-only source/schema/test/hash/reference/whitespace inspection; no suites, DB/network/credentials/writes. External
prerequisites/RLS_NOT_ENABLED remain unresolved. No implementation or LIVE acceptance.
