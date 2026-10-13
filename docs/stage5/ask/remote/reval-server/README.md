# R-EVAL server contracts — proposed amendment RC4

**DESIGN DRAFT; independent architecture agreement PENDING.** This package defines the missing server
contracts for a later supervised synthetic evaluation. It performs no implementation or live admission.
The author session does not count as independent architectural approval.

The accepted architecture already supplies authority checks, private dispatch proof, durable reservations,
settlement and pause. This amendment supplies authoritative evidence interfaces without turning the local
instrument into an inference client or an administrative authority.

| Missing contract | Proposed boundary |
|---|---|
| Ledger metadata | Owner-only local reader; one atomic project-wide census plus correlation-specific accounting |
| Closure receipt | Owner command uses the existing fence-first owner policy revision; exact four-key receipt |
| Fixture DB provisioning | Isolated synthetic DB; one of eleven exact fixtures at a time in the SAME client scope |
| Response handoff | Explicit manual browser action; bounded memory-only comparison with the server's exact publication |
| Loaded server identity | Measured immutable launch, private local channel and process-incarnation binding |
| Egress/privacy proof | Complete destination inventory, platform enforcement and measured before/after scans |

## Normative boundaries

Normative files: this README, `AGENTS.md`, and `01_CONTROL_AND_IDENTITY.md` through
`06_LOCAL_PROTOCOL.md`. `DESIGN_STATUS.md` is administrative and cannot grant acceptance.
A frozen manifest must list these eight paths and hashes plus the exact dependency identities before
fresh independent Astra/xhigh and native Fable5.1/xhigh reviews of the SAME artifact.

Dependencies (preserve bytes and historical approvals):

- Remote DESIGN RC2: `9c92327f6a3d693031c30cc907091f6dd61f4e0747491e10f00a784f877719d3`.
- R-EVAL preparation RC6: `66dcc033c71f5836e8904b289c0aeb493b5de96264098f884eded931e01b6fa7`.
- Offline RC3: `d706a437b2e77ccb215080d4676d2ae70fee53376636d3d9040590d5d8f2dc3a`.
- Accepted R-A/R-B/R-C and parent Ask/console seals: exact references in the freeze manifest.
- Execution RC5 is the current drafting reference, package
  `5c6a7e521220b703ca78efd045376f7ac98e41c613e17e766b0eadc27b994d97`.
  Its independent acceptance is separate and is NOT claimed here. A later execution repair must be
  named and resealed at integration; this design does not inherit another candidate's approval.

## Explicit amendments proposed for review

1. Add a separate owner local administration protocol. The API process never receives owner DB credentials.
2. Add one optional, private, same-origin evaluation handoff POST and an evaluation session header on
   the existing Ask POST. This is a narrow exception to the two-operation browser surface in remote
   `02_CONTRACTS.md`; it cannot perform inference, source reads, activation, consent or Ask submission.
3. Add one bounded transient publication slot for the paired synthetic run. This explicitly extends
   raw request/answer lifetime for at most 120 seconds solely for handoff, outside ordinary Ask operation.
4. Add a pinned synthetic freshness reference for the fixture DB source projection. Real authorization,
   billing, expiry, deadline and audit clocks retain their real clocks. This explicitly supersedes only the
   registered-sandbox freshness/time-invariance assertion at R-EVAL RC6 plan53–54, as detailed in03.
5. Add owner-controlled sandbox/fixture registration and read-only evidence interfaces, with explicit
   SQL confinement checks. No runtime policy provisioning, direct ledger DML or refund authority is added.
6. Add a synthetic-only browser pane with MANUAL selection of the registered fixture's single exact focus,
   including FX10 MISSING. Explicit event transitions retain newly typed input and retain that draft on
   deliberate fixed-choice selection, departing from ordinary selectedObservation focus/draft clearing ONLY
   in this pane. Corpus/predicates, V2, backend MISSING and fresh-consent/stale-generation rules remain intact.
7. Require pair/one-use arm for every registered-scope Ask POST throughout registration lifetime. The bounded
   pre-authentication ingress claim is measurement only; denial reuses ASK_REMOTE_NOT_ADMITTED503, malformed
   or out-of-sandbox evaluation headers reuse ASK_REQUEST_INVALID400, and OFF stays404 as specified in04.
8. Pin the future synthetic arm/PRE/GO window to30s. The case consumed by its FIRST current GO may arm
   once; prior consumption or a failed/lost arm cannot re-arm. Current instrument
   bytes are unchanged; RS-C must explicitly reseal this timing/IPC integration. Added ARM/READY failures
   after consumption tighten RC6 plan236–238 as detailed in04; Ask/provider deadlines stay fixed.
9. Preserve fixed original-task fault metadata over the independent owner channel after raw revocation or
   unknown settlement; exact local transfer/ACK/commit and safe persistence boundaries are in06.

All other accepted request/answer DTOs, provider profile, prompt/schema, private dispatch proof, financial
semantics and manual per-question consent rules remain authoritative. Any contradiction outside these listed exceptions
blocks implementation and returns to architecture review.

## Meaning of evidence

A server-authenticated DTO establishes which values this server published. A safe original-task observation
separately records detected fixed faults and actual server HTTP completion, surviving raw-slot revocation. A current role check establishes
specific current authority. A database census establishes accounting at one snapshot. Platform measurements
establish their stated destination/process coverage. None substitutes for another, proves a human click,
proves provider weights, or admits spending.

Unknown/missing handoff, process continuity, commit, census, drain or destination coverage stays UNKNOWN.
A valid answer with unknown liability receives no passing-case or validated-provider credit. A known
authenticated safety/configuration fault remains FAILED even if handoff/publication/settlement is unknown. The execution
RC6 terminal/no-retry rules and stronger safety/threshold failure priority remain mandatory. Additional
metadata may not silently flip the current instrument's constant `verifiedPass:false` or
`liveAcceptanceEligible:false`; a future reviewed integration artifact must define any new eligibility state.

Architecture agreement permits preparation of implementation briefs only. Each later code checkpoint needs
explicit owner scope and independent Sol/Opus acceptance. Account EU/ZDR, current price, human labels,
operator identity, data, budget, actual evaluation and deployment remain separate owner gates.
