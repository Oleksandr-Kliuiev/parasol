# Stage 3 specification — governed ticket flow, local engineering scope

RC4, 2026-10-09. Normative with 02–06. Engineering scope is MOCK only; LIVE is not a supported execution mode.
Direct dependency: accepted Foundation. Stage 2 correlation and all previous live gates remain separate.

## Result

An operator previews an exact ticket request, stores it, obtains another actor's approval, reserves one execution,
creates one synthetic ticket through the internal port, then verifies that ticket. Uncertainty is a visible outcome.
Policy, approval, execution reservation, verification and audit ship together; no action can bypass one of these steps.
The existing read-only Gateway keeps denying writes. No existing read tool becomes an action.

Initial action type: `atera.create_ticket`, version `atlas-ticket-port/1/mock`. This is an Atlas port contract, not a
claim about Atera's current HTTP payload. No production Atera write adapter or endpoint configuration is implemented.
The supplied port is a scoped synthetic ticket store with independent transactions; it is not a network transport.
Its rows cannot become Stage 1/2 source evidence. Every action response says `synthetic: true`.

## Product and policy limits

- One human-entered plain-text title and description for one existing FIXTURE Atera connection; no attachments, contact
  creation, recipient/email fields, ticket updates/deletes, remediation, scheduling, provider calls or generated free text.
- Customer identity comes only from that scoped Connection binding. Request fields cannot select a different customer.
- Every command requires `context:read` plus its action permission on the same membership. Model confidence cannot grant rights.
- Approval is always required. Requester and approver must be different ACTIVE actors; executor may be either if independently
  granted execution permission. No fixture bypass of separation, RLS or approval exists.
- Title/description are private action content, shown only through an explicit protected preview file. They never enter
  stdout summaries, errors, audit, telemetry, Decisions or the existing ClientContextV1.
- New engineering commands default to DISABLED. Explicit MOCK composition uses only FIXTURE connections and the built-in
  synthetic port. LIVE, configurable origins, custom scripts/ports and inherited provider callbacks are refused.

## Limits and outcomes

Title: 1–160 Unicode scalar values; description: 1–2,000; each is NFC-normalized and trimmed. Reject lone surrogates,
Unicode categories Cc/Cf/Cs/Co/Cn (including C1, bidi/format, private-use and noncharacters), except description LF; validate
raw scalars before normalization/trim. No HTML interpretation. Input maximum 16 KiB. The exact normalized content plus a visible
server-generated correlation marker is previewed and hashed. Total marked title is limited to 240 scalar values.
Approval lifetime: 15 minutes from DB clock, never beyond either signer's token expiry. Execution permit starts within
5 seconds and never after approval expiry. One create invocation per request, no automatic retries.
Create deadline: 15 seconds; read verification deadline: 15 seconds; at most three verification invocations, including the
initial read after create. Each consumes a durable ordinal; a crash or timeout cannot refund it.
Recovery can mark a reservation unresolved after 35 seconds (deadline plus grace), without issuing another create.
Lists: keyset pagination, 50 default/100 maximum, no text bodies. No long-lived worker is introduced.

Outcomes distinguish `OUTCOME_UNKNOWN`, `CREATED_UNVERIFIED`, `VERIFICATION_MISMATCH`, `VERIFIED`, and known zero-dispatch
`NOT_DISPATCHED`. A successful port create alone does not mean VERIFIED. False success or automatic duplicate creation is forbidden.
Before reservation, explicit revocation becomes REVOKED; lost authority becomes INVALIDATED, expiry becomes EXPIRED.
Any protected owner mutation increments a workspace epoch and permanently invalidates older unreserved requests, including
after permissions are restored. This conservative rule includes unrelated/no-op mutations in that workspace.

## Delivery

S3-A: contracts, schema, RLS, complete authority fence/role, immutable signer expiry/epoch proof, immutable request and deterministic preview/policy.
S3-B: exact stored-preview approval, single reservation and revocation/cancellation concurrency.
S3-C: synthetic port, execution/verification/recovery, operator commands and complete synthetic evidence.
Each checkpoint requires actual independent Astra acceptance before dependent work. Implementation starts only after
fresh independent Astra/xhigh and native Fable/high approvals of the same current package.

Actual vendor execution requires a separately frozen wire-contract/live amendment and explicit owner admission. Until
then every production connection is refused by action execution, irrespective of ordinary read permissions or API credentials.
