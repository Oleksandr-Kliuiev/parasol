# Stage 4 PowerOffice context

A client operator can inspect the state of one PowerOffice integration and a bounded summary of issued invoices,
without seeing customer identities, document text or bank details. The first slice is synthetic and read-only relative
to the vendor. LIVE remains deferred. Local persistence, synchronization and retention are explicitly governed below.

Status at design packaging: PROPOSED; neither architecture nor implementation is accepted by this file.
Current verdicts: [review status](REVIEW_STATUS.md); current code: [implementation status](IMPLEMENTATION_STATUS.md).
The roadmap names Foundation as the direct dependency. This checkout additionally contains the accepted Stage3 authority
fence; this design reuses that installed fence and preserves the accepted Stage1/2/3 behavior.

| Concern | Normative entry |
|---|---|
| Scope, privacy and boundaries | [01_SPEC](01_SPEC.md) |
| Authority, public DTOs, arithmetic and error semantics | [02_CONTRACTS](02_CONTRACTS.md) |
| Schema, RLS, privileges, locks and retention | [03_DATA_AND_CONCURRENCY](03_DATA_AND_CONCURRENCY.md) |
| Internal port, synchronization and future LIVE gate | [04_PORT_AND_SYNC](04_PORT_AND_SYNC.md) |
| Model assignments and stopping checkpoints | [05_IMPLEMENTATION_PLAN](05_IMPLEMENTATION_PLAN.md) |
| Acceptance matrix and required checks | [06_ACCEPTANCE](06_ACCEPTANCE.md) |

The eight files AGENTS, README and01–06 form the normative package. Manifest, source ZIP and independent reviews bind
an exact version; status files are administrative. Default product assumption: integration status plus invoice summary.
The owner was offered a narrower organization-only alternative; no account or financial data is needed for this design.
