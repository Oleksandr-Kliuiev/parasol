# Astra S2-B corrective policy RC1 — REQUIRED CHANGES

2026-10-08. Fresh native gpt-6-astra / effective xhigh; read-only architecture/detail review.
Plan SHA256: 9a9d033cbf8f3897e0dc38e6521ddd6cdbeaaef10648c6fb1d9c65aa05838c2d.
Normative RC5 hashes verified unchanged. No implementation edits/tests/probes.

1. Reset of an expired first-ever claim cannot retain PENDING while advancing latestRecordedSeq: that violates the frozen
M365ResourceState_pending_check. Define ERROR/M365_CLAIM_EXPIRED (preserve an actual prior failure) and cleanup-deleted
latest-generation eligibility. Regressions before any successful publication and after cleanup, with delayed claims fenced.
2. Initialize existing directory retry budget deterministically, e.g. min(8, latestStartedSeq-latestPublishedSeq), rather
than defaulting all chains to zero. Sign-in rows remain zero. Keep future retryAt/sequences/publication; populated upgrade
must prove remaining budget and throttle survive migration/reprovisioning.

Other policies coherent: serialized admission, exact Retry-After, latest-claim/reset fencing, terminal outcomes and actor-bound
workspace denial audit. Terminal sign-in return must precede expired-attempt maintenance to keep repeat terminal passes
free of evidence changes. Approval pending plan corrections.
