# REQUEST_CHANGES — S2-LIVE plan RC1

2026-10-08. Fresh native GPT-6 Astra (`gpt-6-astra`), effective `xhigh`, agent `/root/astra_s2live_plan_rc1`.
Read-only procedure review; no implementation/live acceptance. Codex saved the returned report.

Plan package `f7ce77e6cd6ad35c872bc6cbf1ba77b9647880cba64757dca318bc600f653120`;
brief SHA-256 `919ad79f266a86dbbee83c9b6eb2b269d9c84667290227113927064002cdcb22`.

## Required R1 — Stage 1 redirect recording gap

Brief L4 requires every dispatch inspected and recorded, while implementation checks require unchanged transport delegation.
`connectors/http.ts` delegates to fetch without redirect policy. A function-level recorder sees the initial call/final
response, while automatic redirects can bypass destination admission and receipts. Atera/Huntress live-read is affected.
Specify either an enforcer covering underlying redirects or an explicitly authorized pilot-only redirect rejection before
following. Require same-origin/cross-origin redirect tests proving zero follow-up calls or complete enforcement/receipts;
also thrown-call and recorder-failure tests without raw URL/header/body persistence. No production core change required.

Nonblocking correction: M365 mapping confirmation/review needs `mapping:review` and `m365:read` on the same membership.

Other boundaries are appropriate: confinement/target authorization, private credentials, canonical-hour bounds, retry
budgets, genuine human confirmation, partial outcomes and separate harness/final LIVE acceptance.

## Independent checks and limits

Verified all 4 plan entries, 307 accepted S2-C entries, 11 normative entries and declared package algorithms; HEAD/branch
match, final brief hash unchanged. Inspected focused CLI/transport/activation/window/mapping paths. In-memory transport
check confirms default redirect mode is follow; zero network calls. No DB access, credential inspection, file writes,
deployment or live requests. Current missing pilot target/config/license/real sample/human attestation and reported
RLS_NOT_ENABLED are conditional admission limits, not further plan defects. No LIVE acceptance claimed.
