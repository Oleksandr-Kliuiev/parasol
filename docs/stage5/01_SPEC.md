# Outcome and scope

## Operator journey

1. Open the opt-in local console at `http://127.0.0.1:<port>/operator/`.
2. Enter an existing synthetic/local operator bearer token into a password field. No token creation or account setup.
3. Choose a client from GET /clients. No authorized clients is an explicit empty state, not an authentication failure.
4. Read the active observation queue, default OPEN+ACKNOWLEDGED, in the server's authoritative order. Severity/status
   filters, page size25 and next-page navigation use the existing DB server query/cursor. In fixture mode the queue is
   a fixed demo page: filter/page-size/pagination controls are omitted or visibly disabled, with a fixed-demo explanation.
   Refresh repeats that fixed page; in DB mode it returns to the first page.
5. Select an observation: inspect its source, severity, priority, lifecycle, route, reasonCodes, correlation identifiers,
   confirmed entity when present and bounded client/resource context. This is a presentation of ONE observation, not
   a new incident/situation aggregation or identity inference. A null entity remains unresolved.
6. For supported source types, explicitly request stored evidence through one existing read tool. Show freshness,
   asOf, lastSuccessAt, truncation and absence separately. Evidence is a stored read, not a vendor call or verified write.
7. Switch client or disconnect; old scope content and pending results disappear immediately.

## First slice boundaries

- Local opt-in console, fixture and disposable DB journeys, existing confined runtime API; no public hosting.
- Atera/Huntress context and observations only. M365 identity/sign-ins, correlations, PowerOffice financial DTOs, audit
  browsing, actions/approvals, mapping confirmation and observation lifecycle mutations have no console controls here.
- No client-wide or workspace-wide aggregation: queue is one selected client. Existing API contracts are reused unchanged.
- No free-text Ask input, model/provider SDK, generic tool execution, background polling/sync, service worker or scheduler.
- Ask Atlas follows the accepted console and a new reviewed contract for input, provider routing, redaction, evidence,
  tool selection, prompt injection, authorization, budget and errors. Stage6 multistep workflows remain separate.
- No production login/OIDC/session design is claimed by a memory-only local bearer console. LIVE stays deferred.

## Product invariants

Source HIGH/CRITICAL remains visibly urgent regardless of route/confidence. Never reinterpret absence as healthy,
truncated evidence as complete, a candidate as confirmed, or a failed request as an empty successful response. UI controls
are navigation, not authority. The existing server determines scope/permissions and writes required audits.

Historical accepted content is immutable. New UI requirements do not retroactively claim stronger snapshot consistency,
fence/expiry guarantees or list bounds for accepted Stage1 API contracts.
