# ACCEPTED — Atlas S2-C-rc2

Date: **2026-10-08**. Independent checkpoint review by native **GPT-6 Astra (`gpt-6-astra`), effective effort `xhigh`**, fresh subagent `/root/astra_s2c_rc2`. Scope: tasks 2.7–2.10; C1–C6 including lettered cases; Stage 1/S2-A/S2-B regressions; closure of the two RC1 cursor findings. **No required findings remain.** Report returned to and saved by Codex; reviewer made no checkout edits.

## Verified artifact identity

| Artifact | Independently verified value |
|---|---|
| Candidate payload | `e43cc1858e7271577714e2b46e5c8d10956dd4e625cad779964a3a3ac6cbe3c0` |
| Payload | 307 files; every current file and ZIP entry matches |
| HEAD | `916a4d69853ff6da636e8609a2e0bd33aa787f66` |
| Branch | `planning/stage2-m365` |
| Accepted S2-B baseline | `d122f0ea4031ce3421c114c286d409b974d83449d8db6f3930b53884486eb841` |
| Normative package | `1d3b1064c2633ed64ab2089a7ea62401e9415a72b16ba5a9dcd9a50c870a1efb`; 11 files verified |
| Frozen implementation brief | `de3eea93865ef907872a4cf170a87993f629f4ff2ea006bf7fe4293073ad7f57` |
| Candidate ZIP SHA-256 | `095965c488a943b06d1f4d57df484d80bc9f0c01d172be297ff89d88939cf6aa` |

Pre-check, post-check, and final current payload entries are identical. Relative to S2-B: 17 modified, 38 new, no removed files. Existing migrations and the Stage 1 review are unchanged. Maximum active file length is 447 lines.

## RC1 findings closed

- **R1, transition precision:** `packages/correlation/cursor.ts:110` determines future transitions using seven-digit keys before flooring the expiry. Strict eligibility/retention boundaries include equality; inclusive expiry/freshness boundaries already reached are excluded. Both page surfaces check cursor expiry before interval eligibility. Same-millisecond future transitions conservatively expire at issuance rather than outliving the transition. Already stale data remains pageable. The extracted page functions introduce no clock override into public services: those still obtain current authority and one actual database clock inside RepeatableRead.
- **R2, historical membership lifetime:** `packages/correlation/query.ts:92` computes `min(evidence expiry, maximum expiry of still-valid published memberships)`. That effective validity enters both fingerprint and cursor transitions. Losing a nonlast membership leaves the contribution stable; expiry of the last valid membership produces `CORRELATION_CURSOR_EXPIRED` on both surfaces. Fresh reads restore CURRENT/canonical-person annotation as appropriate. Historical contributors outside the interval remain relevant without entering selection, inflating totals, or borrowing current coverage/retrieval time.

The broader checkpoint is consistent with the approved contracts: exact device/assigned-person selection union; current confirmed mappings and per-relation proof; seven-digit filtering/counting/order/keyset; truthful coverage versus freshness; current ACTIVE actor/all-of authority; strict shared input and cursor limits; one composed registry; persisted safe ledger closure after authority withdrawal; and unchanged Stage 1 public/provider contracts.

Maintenance uses the factory-bound runtime target, credentials-only runner substitution, runner-perspective confinement checks, current-authority admission immediately before the separate transaction, and scoped atomic cleanup. Reviewed tests cover wrong-database refusal, privilege refusal, rollback, contention, fresh publication, other-client/Stage 1 preservation, and DISABLED cleanup. CLI recovery and C6 exercise actual subprocess/API/tool paths using the test-only fixed-route mock.

## Verification

All ten mandatory final checks have matching raw/archive log hashes and successful receipts. Counts: **145/145 unit/PGlite and 308/308 PostgreSQL tests**, zero failed, skipped, cancelled or todo. Schema validation/generation, typecheck, API build/smoke, PG17 SQL checks, drift and diff checks passed. The earlier failed tamper test run remains archived; final checks followed its deterministic correction.

Independently ran **38 tests across eight files**, all passing with zero skips:

- 28: correlation units, cursor bounds, expiry, pagination and provenance.
- 10: cleanup target binding, privacy/retention and the actual C6 journey; process exit 0.

Independent evidence:

| File | SHA-256 |
|---|---|
| `/tmp/atlas-astra-s2c-rc2-focused.log` | `c1e1242731260fec5b2ab7adb9619c75737481ee6443f18246390fb2965338f5` |
| `/tmp/atlas-astra-s2c-rc2-maintenance.log` | `816ce0b613368e3db83e660b385f449b0dae89179261a0565c78f1aa5271a05b` |
| `verification/stage2/S2C_RC2_CHECKS.json` | `bc83171590e8306ca43b91275bdec361f30b01be8660bbf930e565c395777270` |
| `verification/stage2/S2C_RC2_SAFE_LOGS.zip` | `3c2775cb0d20a4419187017c5bda4031b81594c48551f9cf40f0c920fa88f333` |

## Residual limits

The approved cleanup revocation gap remains; cleanup is one bounded transaction, without batching. A cursor may already be expired when issued near a sub-millisecond transition. RC2 aggregate-query latency was **not remeasured**; the approximately 480 ms/19,000-row receipt belongs to RC1. The pre-existing S2-B large-leaf transaction timeout remains a visible failure condition.

Checkout remained read only throughout this review. **LIVE, real tenants, deployment and production readiness were not exercised or accepted.**
