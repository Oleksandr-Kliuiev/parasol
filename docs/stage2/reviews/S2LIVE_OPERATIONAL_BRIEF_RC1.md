# S2-LIVE operational brief RC1

Prepared by Codex, 2026-10-08. This artifact defines the next separate live checkpoint. It changes no accepted runtime
behavior, schema, permission contract or upstream endpoint. Plan approval is conditional on admission below; it is neither
live acceptance nor authorization to choose an arbitrary tenant, deploy to an existing database or change accounts.

## Frozen baseline and routing

- HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `planning/stage2-m365`; existing dirty work preserved.
- Accepted S2-C-rc2: 307 files, package `e43cc1858e7271577714e2b46e5c8d10956dd4e625cad779964a3a3ac6cbe3c0`.
  Manifest: `verification/stage2/S2C_RC2_MANIFEST.json`; acceptance: `docs/stage2/reviews/ASTRA_S2C_RC2.md`.
- Normative RC5: 11 files, package `1d3b1064c2633ed64ab2089a7ea62401e9415a72b16ba5a9dcd9a50c870a1efb`.
  Manifest: `docs/stage2/REVIEW_MANIFEST.json`; acceptance gates: `docs/stage2/05_ACCEPTANCE.md` L1–L4.
- All 318 entries reverified before preparation. Existing migrations and Stage 1 report remain frozen.
- Read first: root `AGENTS.md`, `docs/AI_CONTEXT_MAP.md`, `docs/DEVELOPMENT_WORKFLOW.md`, current implementation status.
  Then only RUNBOOK §8, the L1–L4 section and the named entry files below. Do not load historical review collections.

Smallest implementation entries: `scripts/ops.ts`, `packages/ops/commands.ts`, `packages/ops/m365.ts`,
`packages/ops/live-read.ts`, `packages/m365/io.ts`, `connectors/http.ts`,
`connectors/microsoft365/http.ts`, `packages/correlation/read.ts`, `packages/graph/mapping.ts`.
Use the context map/rg for smaller related modules.

## Current preflight and missing inputs

`verification/stage2/S2LIVE_PREFLIGHT_RC1.json` records local diagnostics only. Runtime admission returned
`RLS_NOT_ENABLED` before authentication/application reads. Catalogs show all 10 M365 tables missing and no present protected
table without RLS. Runtime URL, admin URL and operator token are present; shared cursor reference is absent. No standard
M365/Microsoft/Azure/Entra-prefixed environment variables were observed. Arbitrary connection env references were not read,
so this does not prove that every possible credential is absent. No Graph/vendor/provider calls or DB writes occurred.

Owner input is needed for the designated test client/tenant and M365 connection; private configuration path or credential
reference names; an existing Stage 2-ready pilot DB, or an explicit decision to prepare a designated disposable pilot DB;
read-only consent/license evidence; available Atera/Huntress connections and prior real live evidence, if any; and a human
who can privately verify one genuine device/person association. Never request credentials or customer payloads in chat.

The configured persistent DB is not automatically a pilot target. Do not deploy migrations, reprovision roles, seed,
create client/account bindings or generate persistent keys there to repair this preflight. Database preparation is a
separate concrete target/setup decision. Once specified, use reviewed migrations then roles/GRANT then confinement checks
as RUNBOOK §8 requires. No frozen migration edit, destructive reset or production deployment is in this brief.

## Admission and bounded execution contract

Codex verifies all accepted/normative hashes immediately before handoff and each review/run. The run input record is private,
not a repository artifact: exact authorized client/connection bindings, target DB identity, tenant/cloud, operator authority,
credential reference resolution, planned UTC interval and effective retrieval bounds. Public evidence uses opaque run-local
aliases, grant names, statuses, counts, timestamps and safe error codes. Recheck actual current binding/authority through
accepted services; the private input record does not mint authority or bypass RLS.

Before application reads: `assertRuntimeRole` must pass on the actual runtime target. Authenticate the configured operator;
verify current ACTIVE actor and one per-client membership with the exact permissions for each operation. Sync requires
`connections:manage` + `events:ingest`; correlation/directory reads require `context:read` + `m365:read`; mapping review/confirm
requires `mapping:review`. Never combine permissions across clients/memberships. Check the shared cursor key reference and
≥32 UTF-8 byte value in memory; all participating processes use the same key without printing it.

Resolve only already-approved env references privately. Application credentials are `<application GUID>:<client secret>`;
store only the reference in Atlas. Bound tenant GUID and application GUID are private inputs. Reject test fixture credentials,
mock preloads and `NODE_OPTIONS` injection; use the accepted production I/O composition, fixed public Graph v1.0 origin and
Microsoft login origin. National clouds, beta, delegated/GDAP/lighthouse flows and new permissions are outside this scope.

A live pass includes local Atlas writes: activation, directory/sign-in staging/publication, audit and human-approved mappings.
Vendor resource calls remain GET-only; OAuth token acquisition is the sole Microsoft POST. Account provisioning, consent
changes, credential rotation and vendor writes are excluded. Existing production connections must not be disabled/rebound
merely for a test. Use the designated pilot connection. Maintenance/cleanup, worker/provider execution and scheduling are
separate actions and are not part of the L1–L4 run.

## L1 — tenant, consent and capability

1. Verify the private target/binding and owner-provided license/consent readiness; record only permission names and the
   owner's attestation status/time. Expected application read permissions: `Organization.Read.All`, `User.Read.All`,
   `Device.Read.All`, `AuditLog.Read.All`; do not broaden grants on failure.
2. On the approved bound DISABLED pilot connection, run `m365-probe --client C --connection N` through accepted services.
   Verify `/organization` equals the bound tenant using the same token before users/devices/sign-in calls. No tenant ID,
   organization body, token, URL containing tenant or request header enters public evidence.
3. Record real organization/users/devices/sign-in capability status and safe codes. An ACTIVE pilot connection needs genuine
   current capability evidence; an existing cached flag alone is insufficient. Plan a separately approved pilot reactivation
   if necessary rather than silently disable a shared connection. `CONNECTION_ALREADY_ACTIVE` makes zero upstream calls.
4. A sign-ins 403 may produce ACTIVE directory-only capability with `M365_SIGNINS_NOT_AVAILABLE`. It does not prove a license
   diagnosis. Owner must verify actual account/license/consent; unavailable capability is a partial outcome, never full pass.

Microsoft references checked 2026-10-08: [organization](https://learn.microsoft.com/en-us/graph/api/organization-list?view=graph-rest-1.0),
[users](https://learn.microsoft.com/en-us/graph/api/user-list?view=graph-rest-1.0),
[devices](https://learn.microsoft.com/en-us/graph/api/device-list?view=graph-rest-1.0),
[sign-ins](https://learn.microsoft.com/en-us/graph/api/signin-list?view=graph-rest-1.0).
The devices endpoint returns registered Entra devices, not an Intune inventory. The documented sign-in list concerns interactive
and successful federated user sign-ins; do not claim exhaustive coverage of other event classes. Microsoft describes Graph
activity-log access for P1/P2 tenants; portal availability on Free does not establish API entitlement:
[activity log access](https://learn.microsoft.com/en-us/entra/identity/monitoring-health/howto-access-activity-logs).

## L2 — genuine bounded directory and sign-in reads

1. Run one directory attempt each through `m365-sync --client C --connection N --resource users` and `--resource devices`.
   Capture per-resource safe status, retrieved/published times, page/item counts and missing/gap/error codes. Publication must
   use the accepted atomic last-good behavior. Directory caps remain 40 pages/20,000 rows, 500/page, 5 MB/page, 15 s/page,
   10 min/job. Complete means accepted traversal completion, not externally proven instantaneous tenant consistency.
2. Pick one recent completed canonical UTC hour within the 7-day retention interval for which the owner expects a genuine
   sample. Do not select a broad interval to manufacture matches. Record both requested interval and effective root retrieval
   interval before dispatch. A narrow request widens to its intersecting canonical hour root(s); it does not bound upstream
   volume to that narrower duration. Respect the accepted 5-minute lag and retention clipping.
3. Create one bounded sign-in request with `m365-sync … --resource signins --from T --to T`. Record the request's safe local
   status/counters and effective bounds via `m365-status … [--request R]`. Retain the same request for continuation; never
   silently create replacement requests to reset retries. Request ≤24h, ≤7 days, exact millisecond input boundaries.
4. Preserve limits: leaf 20 pages/10,000 rows, root 100,000 rows, request 250,000 rows/≤25 roots, root attempt budget 5. One CLI
   pass does not sleep/retry internally. Honor persisted `retryAt`; resume the same request once due. Do not fabricate a real
   429/empty-device event, fuzz the live tenant or deliberately induce provider errors for evidence.
5. Record paging actually observed. If a collection fits one page, mark multi-page live behavior NOT_EXERCISED; existing
   synthetic/PG paging tests remain distinct evidence. Empty reads prove access only. Never replace data with fixtures.
6. Inspect `m365-directory` and correlation reads through a private local viewer or an in-memory allowlist projection;
   never tee raw JSON stdout to logs, repository artifacts or model prompts. These approved DTOs may contain names/UPNs.
   Public evidence stores presence/count/status and relation proof labels, not record content or cursor values.

## L3 — human-confirmed genuine correlation

Privately inspect an actual Huntress/Atera source association and fresh M365 directory evidence. Names/hostnames alone are
not identity proof. Human verification supplies the particular candidate local link ID and its evidence; then use the
accepted `mapping` / `confirm-link --client C --link L` path with current authority and prerequisites. Never create a
synthetic source device/person/Observation merely to satisfy L3 or automatically confirm suggested links.

For a genuine existing observation, run `correlation --client C --connection N --observation O --from T --to T` against the
published window. Verify independently the actual per-relation source references, proof labels, selection, coverage and
freshness; a confirmed-device relation does not prove an assigned-person relation. Pagination rechecks current authority;
changed/expired cursor causes an explicit restart from the first page, never an unreported merge of generations.

Human attestation must identify privately the exact source association, inspection time and confirmation action. The public
report records an opaque association alias, inspected source systems, proof labels, confirmation time and result; an
independent reviewer verifies the safe provenance receipt and explicit human attestation without seeing personal data.
No nonempty matching sign-in evidence → L3 NOT_EXERCISED; null device details/missing sign-ins retain explicit reason codes.
A populated directory or a human confirmation alone is not a positive sign-in correlation claim.

## L4 — Stage 1 live dependencies and network/provider boundary

Use genuine Stage 1 Atera/Huntress live gate evidence for the same pilot/client, or run the accepted `live-read` operation
for each authorized bound pilot connection with actual native credentials. Capture redacted resource/count/status receipts;
missing credentials, undocumented vendor contract assumptions or failed health checks keep the corresponding dependency
BLOCKED_EXTERNAL/FAILED. Historical mocked acceptance does not satisfy L4. Do not invoke `decisions-smoke`, `worker-once`
or shadow processing as a live dependency; synthetic Decisions checks are separate and may have separate billing.

Every upstream dispatch in this pilot must have metadata-only recording: endpoint class (organization/users/devices/sign-ins,
Atera/Huntress resource class/token), method, response HTTP status, sequence, duration and count. Inspect request destination
privately before dispatch and retain only the classified destination. No complete URL/query/nextLink/headers/body or secret
value is retained. Record transport completeness and process isolation: accepted production transports, no request path
bypassing the recorder, no provider/worker process in the pilot invocation, no unrelated concurrent actor sharing evidence.

Use an existing trusted metadata recorder if available and inspect its completeness. Otherwise stop before live I/O and
have one Claude implementer prepare a small pilot-only harness around accepted injectable transports after this dual plan
gate; it must preserve fixed origins, redirect/nextLink/tenant/authority checks and not change production adapter semantics.
Record failed/thrown calls as safe outcomes as well as successful responses. No raw diagnostic/error messages or token data.
Before invoking that harness, verify source identity, focused tests and fresh Astra checkpoint acceptance on its exact code.
An isolated driver must not load/use a Decisions runtime/provider; enforce and record zero provider dispatches as well as
zero prohibited vendor methods. General code review or absence of a log entry alone is not a live dispatch proof.

## Stop conditions, recovery and outcome

Stop before application reads if confinement fails; before upstream I/O if target, grant, credential, recording or license
admission is unresolved. Stop on tenant mismatch, changed authority/binding, unsafe URL/redirect, any unintended method or
payload exposure. Preserve safe failure status/last-good data; do not loosen checks, grant new scopes or replace real data.

The known single-leaf staging timeout around 9,500 memberships remains a visible FAILED outcome even within one hour. A
shorter requested interval does not avoid canonical-hour volume. If encountered, record safe counters and diagnose once;
no transaction-timeout/cap/schema change or automatic budget reset is authorized here. Further changes require a concrete
reviewed amendment, Claude implementation and renewed Astra acceptance. After two ineffective repairs, diagnose/replan.
Cleanup admission/revocation gap and unmeasured RC2 large-scale latency remain accepted limits, not live scalability proof.

| Outcome | Required truthful evidence |
|---|---|
| PASS | L1–L4 all satisfied on real authorized sources; nonempty claimed correlation; human attestation; complete dispatch proof; fresh Astra acceptance of actual evidence |
| PARTIAL | Explicit passed and unexercised/failed components; e.g. genuine directory-only capability or unavailable sign-ins; no full end-to-end claim |
| BLOCKED_EXTERNAL | Required target/config/license/credentials/human evidence unavailable; zero guessed replacements |
| FAILED | Actual admitted operation failed; safe code/counters and retained last-good status; dependent claims withheld |

A partial/blocked report does not reject the accepted S2-C synthetic/PG scope and never implies production readiness.

## Ownership, independent reviews and evidence

Codex owns checkout writes during preparation. Fresh Astra `gpt-6-astra` / `xhigh` and native Fable `claude-fable-5-1` / `high`
review this exact brief plus the pinned baseline/preflight independently, without each other's initial verdict. Any required
finding changes the artifact hash and both must approve the same replacement. Missing named-model access leaves its gate
pending; requested labels or fallback responses cannot satisfy it.

No new implementation is required to reuse already accepted commands, but recording/privacy work may require the small
harness above. If so, Codex gives one fresh native Claude Code Opus `claude-opus-5-5` / `high` session the goal, exact baseline,
allowed harness/test paths, invariants, focused checks and stopping checkpoint. It alone owns writes until stopped; Codex
and reviewers remain read only. Do not authorize core fixes or broaden scope in that handoff. No extra dependencies.
Active files ≤700 lines; cohesive modules/tests near500. Focused tests must prove fail-closed recording, safe error projection,
all upstream attempts including token POST, unchanged production transport delegation, no provider path and no personal
payload persistence. Use synthetic credentials/test endpoints only in focused tests, never in live acceptance.

If accepted payload changes, generate an exact candidate manifest/delta and run affected checks plus the mandatory checkpoint
schema/generate/typecheck/unit/PG/build/smoke/PG17/drift/diff suite in disposable DBs, then fresh Astra xhigh accepts the exact
harness before live dispatch. If only documents/preflight change, verify hashes, links/whitespace; do not repeat unchanged
453 tests as purported live evidence. Final live checkpoint needs fresh Astra xhigh assessment of the actual safe receipts,
external prerequisites, human attestation, claimed scope and unchanged accepted artifact; plan review is not that acceptance.

Store safe preflight, approved plan hashes, execution identities/efforts, elapsed time, findings/fixes, command receipts,
per-gate outcomes and residual risks under `verification/stage2/` and named reports under `docs/stage2/reviews/`. Keep private
run configuration and raw customer material outside repository/reviewer prompts. Provider routing: native Anthropic
claude.ai/firstParty subscription; verify Fable plan billing before unattended `-p`, no API/usage credits/fallback.
Record actual assistant response model(s); attributable subscription quota unknown unless observable. Public credentials,
raw streams containing personal records and secrets must never become review evidence.
