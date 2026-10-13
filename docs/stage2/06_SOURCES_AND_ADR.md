# Stage 2 — sources and assumptions

Checked on 2026-10-08 against Microsoft Learn. These are API facts, not proof of access to the user's tenant.
The links below are the authoritative starting points for implementation; do not use a beta example as a v1.0 contract.

| Source | Fact used / design consequence |
|---|---|
| [List users](https://learn.microsoft.com/en-us/graph/api/user-list?view=graph-rest-1.0) | Application User.Read.All; select documented fields; directory reads can have replication delays |
| [List devices](https://learn.microsoft.com/en-us/graph/api/device-list?view=graph-rest-1.0) | Application Device.Read.All; registered directory devices, not an Intune inventory |
| [Device resource](https://learn.microsoft.com/en-us/graph/api/resources/device?view=graph-rest-1.0) | Directory id and registration deviceId have different meanings; registered owner is not a claim of current user |
| [Device detail](https://learn.microsoft.com/en-us/graph/api/resources/devicedetail?view=graph-rest-1.0) | Sign-in device reference may be unpopulated for unregistered devices |
| [List sign-ins](https://learn.microsoft.com/en-us/graph/api/signin-list?view=graph-rest-1.0) | AuditLog.Read.All; bounded time filters and pagination; maximum page size 1,000; source subset described as interactive and successful federated user sign-ins. Atlas does not claim all event classes |
| [Sign-in resource](https://learn.microsoft.com/en-us/graph/api/resources/signin?view=graph-rest-1.0) | IDs, event time, status, user and device references; risk/CA properties are separate and excluded here |
| [Access activity logs](https://learn.microsoft.com/en-us/entra/identity/monitoring-health/howto-access-activity-logs) | Microsoft Graph access described for Entra P1/P2 tenants; portal visibility alone is not proof of API entitlement |
| [List organizations](https://learn.microsoft.com/en-us/graph/api/organization-list?view=graph-rest-1.0) | Organization.Read.All for application read; Atlas uses returned organization ID to check bound tenant |
| [Client credentials flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow) | Tenant-specific authority, client_credentials and graph .default; application consent prerequisite |
| [Graph paging](https://learn.microsoft.com/en-us/graph/paging) | Follow returned nextLink until exhausted; Atlas additionally validates origin/path and keeps tokens out of logs |
| [Throttling](https://learn.microsoft.com/en-us/graph/throttling) | Respect 429 Retry-After; absent Retry-After requires backoff |

Atlas inference requiring fixture and live contract validation: sign-in deviceDetail.deviceId joins to the registered
device.deviceId alternate key. The implementation must deliberately test different directory id/deviceId values;
S2-LIVE must confirm this chain with real evidence, not infer it from matching display names.

## Explicit design choices, not Microsoft promises

- 7d Atlas sign-in lifetime, 24h directory payload cap, 60m/15m freshness, 5m collection buffer.
- Full directory generations instead of Graph delta in this first slice.
- 1h windows, bounded splitting, page/byte/time caps and 5 attempts.
- Manual canonical mappings; exact source references never prove causation or ownership.
- One commercial tenant per connection; no beta, national-cloud, guest-home-tenant or GDAP expansion.
- Extra Organization.Read.All chosen for an independently observable tenant check instead of decoding opaque tokens.
- Explicit permission-gated endpoint; existing ClientContextV1 and Decisions input remain unchanged.

## Open external facts and owner decisions for live gate

Actual tenant/application IDs, consent, account licensing, observable event classes, retention accessible from the
source, volume/page limits and nonempty correlation sample are not known. They are S2-LIVE prerequisites, not
reasons to delay contract tests. No credential is needed to prepare or review this specification.
Pilot schedules, production IdP/vault, retention policy beyond these bounded test defaults and deployment belong
to the operational gate before any real sustained use.

## Baseline references

- [Stage 1 specification](../01_STAGE_1_SPEC.md) and [ADRs](../07_SOURCES_AND_ADR.md).
- [Independent Checkpoint C approval](../../REVIEW_REPORT.md).
- [Open limitations](../../CHECKPOINT_REPORT.md#remaining-gates--blockers).
- [Reconciled roadmap](../ROADMAP.md).

The old START_HERE/implementation-plan text describes the imported reference pack in some sections.
Use the dated independent review and checkpoint report for implemented Stage 1 status, not those historical future-tense paragraphs.
