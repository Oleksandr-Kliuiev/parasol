# Independent Astra rereview — Stage 2 RC2

- Date: 2026-10-08.
- Reviewer: Codex, configured model `gpt-6-astra` (explicit parent dispatch confirmed; not a runtime self-identification claim).
- Package: `1.0-rc2`.
- SHA-256: `8a2932fb3a4195aa540ea934deb51720a7ba90e205991416551ee2ba656c7bf0`.
- Verdict: **APPROVE**.

Approval covers this Stage 2 design and roadmap sequencing only. It does not approve implementation, live integration, production readiness, or detailed architecture for Stages 3–9. Both required reviewers must approve the same current hash before S2-ARCH is accepted.

All 11 manifest file hashes and the aggregate hash were independently recomputed and matched. I reread the four revised normative files, using the unchanged RC1 normative files already reviewed. I did not read Fable's report. The parent provided the proposed correction approach before RC2; this verdict follows inspection of the actual revised text rather than that proposal.

## Obligatory findings

**None.** The three RC1 blockers are closed at the design level:

| Finding | Resolution and required implementation evidence |
|---|---|
| A1: overlapping reread publication authority | `02_CONTRACTS` §3 and `03_CONNECTOR_SYNC` §5 define unique UTC-hour roots, immutable attempts/leaf memberships, persisted split ancestry, exact-cover validation, durable request/job budgets, sequence fencing and one atomic published pointer. Failed refresh preserves last-good membership and retrieval time as STALE. Coverage, conflicts and cursors derive from explicit publication state; expiry also invalidates paging. Acceptance B5a/C4a exercises the previously missing crash/split/race/time cases. |
| A2: cleanup cannot execute its required transaction | `02_CONTRACTS` §6 replaces the insufficient DELETE-only role with an EXECUTE-only runner and a constrained non-owner, non-BYPASSRLS definer. It specifies required pointer/audit grants, SQL expiry predicates, scope confinement, publication lock order and atomic rollback. C5a requires exercising the actual role, fresh-publication races, scope rejection and audit/pointer/payload atomicity. |
| A3: ACTIVE-only rule prevents activation | `02_CONTRACTS` §1 and `03_CONNECTOR_SYNC` §2 explicitly allow bounded activation-purpose probes on a bound DISABLED connection. Actor/scope/version/expiry and conditional one-use activation fence revocation and replay; no ordinary read or publication is authorized by the exception. B1a covers initial activation and negative cases. |

Additional revisions preserve the intended boundary: all-of tool permissions cannot combine different client memberships; legacy public tool metadata remains unchanged; the Huntress join uses the validated scoped RawEvent externalDevice reference rather than historical Observation.entityId; SQL immutability guards cover evidence and published memberships. Narrow source inspection confirmed the RawEvent/Observation/externalDevice path exists in Foundation.

## Nonblocking notes

`02_CONTRACTS` §3 groups publication and cleanup under a shared lock-order paragraph, then lists ACTIVE/claim checks. Apply those publication checks to publication; §6 retention cleanup must still remove expired payload after connection disable/revoke. A focused implementation test should make that interpretation explicit. This is a wording clarification, not a missing retention authority design.

The revised bounded design intentionally sacrifices partial success within a root and marks historical retrievals stale after the configured freshness interval. Those are disclosed tradeoffs, not defects requiring a generalized interval engine or scheduler.

## Limits

No implementation code changed, application/database tests ran, database migrated, tenant contacted, or account modified in this rereview. Manifest verification is the only executed package check; proposed acceptance tests remain future work. RC1's source-document spot checks were not repeated because the vendor contract did not change. Real PostgreSQL privilege, trigger, FK, isolation and concurrency tests remain necessary at S2-A/B/C; tenant and end-to-end live evidence remain separate S2-LIVE gates.

This approval applies only to the exact hash above. Changed normative files require a new manifest and rereview.
