# Vendor contracts used by the Stage 1 read adapters (task 1.5)

Atlas reads only what is listed here. Each adapter validates these fields at runtime and fails closed
(`UPSTREAM_CONTRACT_MISMATCH`, PERMANENT, field name only). Vendor URLs are fixed in code, never taken from data.

| Vendor | Source | Retrieved | Status |
|---|---|---|---|
| Huntress | Official API reference https://api.huntress.io/docs (Swagger 2.0 embedded in the page, `info.version` 1.0.0) | 2026-10-07 | **Verified** against the vendor's own reference (page sha256 `bd5dfd8e…08b4bc`, extracted spec `86e98570…256091`) |
| Atera | "Atera OpenAPI v3 documentation" (OpenAPI 3.0.4) as exported into the public repository `davejlong/PSAtera`, file `atera-openapi.yaml`, commit of 2026-06-16 | 2026-10-07 | **Unverified against an account**: the vendor reference `app.atera.com/apidocs` requires login (HTTP 401), `/swagger/docs/v3` returns an empty body. File sha256 `be9c2f98…4fdae` |

No credentials were used. Fixtures in `fixtures/vendor` are synthetic and shaped after these contracts.

## Huntress (`connectors/huntress/`)

- Base `https://api.huntress.io`; HTTP Basic with base64(`<api key>:<api secret>`); the vault holds the pair as one secret.
- Rate limit 60 requests/minute per account (sliding window) → 429; Atlas surfaces it as TRANSIENT with Retry-After.
- Pagination: `limit` (1–500, Atlas uses 100) and `page_token`; the response has the plural key and `pagination.next_page_token` only when more pages exist. At most 20 pages per read.
- Reads, all with the server-side filter `organization_id=<bound tenant>`:
  - `GET /v1/incident_reports?organization_id&status=sent` → snapshot `incident` (open = `sent`: the SOC has notified the partner).
  - `GET /v1/agents?organization_id` → identities `agent` (`id`, `organization_id`, `hostname`, `platform`, `updated_at`).
  - `GET /v1/organizations/{id}` → health check (`organization.id` must equal the bound tenant).
- Incident fields read: `id`, `organization_id`, `agent_id`, `severity` (`low|high|critical`), `status` (`sent|closed|dismissed|draft`), `subject`, `sent_at`, `updated_at` (required — it is the event revision). `summary`, `body`, remediations and indicator details are not copied.
- Severity mapping (source scale, no Atlas threshold): `low → LOW`, `high → HIGH`, `critical → CRITICAL`.
- All properties are optional in the spec (`required` is empty), so absence is checked per field.

## Atera (`connectors/atera/`) — confirm before activating a live connection

- Base `https://app.atera.com`; the export documents JWT bearer authentication (`Authorization: Bearer {token}`).
- Pagination: `page`, `itemsInPage` (max 50); envelope `items` (nullable), `page`, `totalPages`, `totalItemCount`, `prevLink`, `nextLink`. At most 40 pages per read.
- Reads:
  - `GET /api/v3/tickets?customerId=<bound tenant>&ticketStatus=Open` → snapshot `ticket` (`TicketID`, `CustomerID`, `TicketTitle`, `TicketStatus`, `TicketPriority` `Low|Medium|High|Critical`, `TicketCreatedDate`). Requester names, e-mail, phone, comments are not copied.
  - `GET /api/v3/agents/customer/<bound tenant>` → identities `agent` (`AgentID`, `CustomerID`, `MachineName` as hostname, `OSType`, `Modified`).
  - `GET /api/v3/customers/<bound tenant>` → health check (`CustomerID`).
  - **Alerts are not read.** `GET /api/v3/alerts` accepts only `page`, `itemsInPage`, `alertStatus` — no customer filter. docs/01 (condition 5) requires the upstream request itself to be limited to the bound customer, so the resource is recorded `UNAVAILABLE` with `UPSTREAM_TENANT_FILTER_UNAVAILABLE`. Reading all MSP alerts and filtering afterwards is a separate decision (docs/03 allows it only as an isolated job).
- Alert severity mapping kept with the contract for that decision: `Information → INFO`, `Warning → MEDIUM`, `Critical → CRITICAL`.

Account checklist (Atera):
1. Compare the fields above with `app.atera.com/apidocs` of the account; update `ATERA_CONTRACT_VERSION` and drop `unverified`.
2. Confirm the authentication scheme for the issued key (bearer token vs. the older `X-API-KEY` header).
3. Confirm the time zone of zone-less timestamps (Atlas currently reads them as UTC).
4. Confirm which `TicketStatus` values count as open in this account (Atlas reads `Open` only).
5. Check whether a customer-scoped alert read exists for the account (filter, webhook or per-agent endpoint).

Decision on Atera alerts (owner, 2026-10-07): keep them unavailable for now — no MSP-wide read with a post-filter. When
account access exists, check item 5; only a customer-scoped read (filter, webhook or per-agent endpoint) re-opens them.
