# Saved Microsoft 365 overview

`atlas-overview.v1.example.json` is a synthetic input to the CRM BFF projection of
`atlas.m365-overview.v1`. This is a separate contract: Stage 1 `ClientContextV1` and
existing Microsoft 365 directory/sign-in evidence contracts stay unchanged.

Atlas reads saved metadata for active, bound Microsoft 365 connections under the
current employee's `context:read` AND `m365:read` authority. The fixed window covers
the previous 24 complete UTC hours, using the read transaction's database clock.
The response contains directory record counts, publication freshness and sign-in
coverage/gap intervals. It contains no directory DTOs, sign-in events, tenant IDs,
credential references, user names, UPNs, IP addresses or provider error messages.

The first eight connections are returned in ID order with a full count and explicit
truncation. Expired/unavailable counts are null; valid empty generations have zero.
Cloud device registration counts are not machine inventory or licensed seats.
No connection or no usable coverage does not establish that a tenant is healthy.

CRM validates the exact schema, scope, window, dates, counts and gap consistency,
then removes Atlas workspace/client scope identifiers before returning its own
customer ID and bounded summary. Link pair AND LinkId are rechecked after the read.
The frontend validates the projected BFF contract independently. Its separate
synthetic fixture is `apps/crm/web/src/test/atlasM365.ts`.

Opening or refreshing the view reads saved data only. It never starts a sync,
resolves a secret or calls Graph. Both HTTP boundaries use `Cache-Control: no-store`.
