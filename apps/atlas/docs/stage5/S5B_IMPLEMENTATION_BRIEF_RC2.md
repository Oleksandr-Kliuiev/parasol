# S5-B implementation brief — operator read journey

Status: RC2 PENDING bounded independent brief re-review; RC1 findings R1/R2 corrected. Concrete projections of approved Stage5 RC3, not a new API or authority contract.
Dependency: S5-A ACCEPTED S5A-rc2, seal `verification/stage5/S5A_APPROVED.json`; verify accepted source/build identity
before implementation. Preparation baseline: `verification/stage5/S5B_BASELINE.json`. Owner instruction: console first,
then Ask Atlas. Stop at independent actual-code S5-B acceptance; do not implement Ask Atlas or LIVE.

## Sources and invariants

Norms: Stage5 01–06, especially02/03 and B1–B9. Source contracts: `packages/core/contracts.ts:101–108,172–181,226–264`;
query/DTO parsers `apps/api/src/http-boundary.ts`; fixture dispatch `apps/api/src/atlas.module.ts`; DB clients/tools
controllers; `packages/tools/registry.ts:42–108`. These accepted server files are READ-ONLY dependencies.
Current browser routing: `apps/operator/AGENTS.md`. All8 architecture normative hashes and accepted seals remain frozen.
No new endpoint/schema/permission/Gateway entry, server authorization semantic, source/vendor/model request, mutation,
audit browser, financial/M365 view, generic tool executor, polling, persistent credential or external UI dependency.
GET clients/overview/observations keep existing no-success-audit semantics. Evidence POST uses actual Gateway and its
existing audit/ToolExecution outcomes. Read-only describes business state; tool execution still has its accepted ledger.

## Field allowlists and exact limits

All responses: original10s total browser deadline including body/decode/parse/validation; incremental4MiB limit.
Unknown required/displayed shapes or Atlas enums → RESPONSE_INVALID; array/byte cap overflow → RESPONSE_TOO_LARGE.
Undisplayed additive fields ignored. Copy projections explicitly; never retain/spread raw response objects or render JSON.
Every displayed string uses the existing4000-codepoint cap with a visible shortened marker. IDs used for requests are
validated unshortened and never recovered from labels. Free text has no invented enum or tighter vendor length promise.
Keep accepted S5-A enum/pattern/time/nullable validation, deadline fix and fixture pagination fix as regressions.

| DTO | Validated/retained projection and bounds |
|---|---|
| ClientSummary | id (SCOPE_ID_PATTERN,1..128), name string; max10000, local search and at most250 matching rows |
| Context identity | contractVersion=ClientContextV1; workspaceId/clientId scope pattern and captured scope; clientName; mode fixture/db; completeness consistency; ISO generatedAt |
| Person | workspaceId/clientId match; id nonempty≤256, displayName string; email retains accepted validation but is never retained/displayed |
| Device | matching scope; id nonempty≤256, hostname string, personId nullable nonempty≤256; references are stored IDs, no name/hostname identity inference |
| Confirmed link | matching scope; connectionId scope pattern, system/resourceType accepted enums, externalId/entityId nonempty≤256, entityKind PERSON/DEVICE, status exactlyCONFIRMED |
| ObservationSummary | matching scope; id/eventKey nonempty≤256; source/resourceType/kind/domain/severity/priority/route/provider/status accepted enums; connectionId/externalEventId/revision strings; entityId/decisionRunId/supersededById nullable nonempty≤256; confidence finite0..1; reasonCodes max100 strings; conflictOfEventKey nullable string; summary string; occurredAt/createdAt/updatedAt ISO; acknowledgedAt/resolvedAt nullableISO |
| ObservationPage | max100 items; counts for each severity safe nonnegative integer, total safe nonnegative integer≥items.length; boolean truncated, nextCursor null or opaque base64url1..400; no stronger count/snapshot consistency promise |
| ResourceView | source/resourceType enum, connectionId null or scope pattern; status OK/STALE/ERROR/MISSING/FIXTURE; asOf/lastSuccessAt nullableISO; safeErrorCode nullable string validated but not displayed; boolean truncated; items null for ERROR/MISSING, bounded array for OK/STALE/FIXTURE |
| DB SnapshotItem | source/resourceType match view; externalId nonempty≤256; title/status strings (status free text); severity nullable Atlas severity; priority nullable string; device null or resourceType/externalId reference; occurredAt/updatedAt nullableISO |
| Fixture normalized alert/incident | workspaceId/clientId/source/connectionId/resourceType match view/captured scope; externalEventId nonempty≤256, revision/summary strings, kind enum, sourceSeverity enum, occurredAtISO; never retain/display facts, externalDevice, receivedAt or additive fields |
| Fixture ticket | id nonempty≤256, title/status strings; no invented normalized-event envelope |

Context caps: people/devices/links1000 each, resources100, items1000 per resource. Validate the whole context before state
commit; over-cap context blocks its queue too. Context observations remain active only and fixture has false truncation/
null cursor. Standalone DB queue permits all4 lifecycle statuses selected by the query. Queue IDs must be unambiguous
within a page; duplicate observation IDs fail validation. Every DB queue item must satisfy captured status/severity
filters and items.length must fit requested limit. Keep server order, do not rank/re-sort locally.
Context display is limited to Atera/Huntress data: person names/device hostnames, stored person references, confirmed
Atera/Huntress links and reviewed resource items. Validate other accepted context fields as before but do not expose
financial/M365 content or add their calls. A displayed entity is confirmed only when its exact ID resolves unambiguously
to a current person/device and a CONFIRMED context link; otherwise show unresolved/reference unavailable. Missing graph
rows never establish absence or permit guesses. Conflict/superseded references are text only, with no cross-client jump.
HIGH/CRITICAL is visibly urgent in queue/detail/evidence independent of confidence, route or a conflicting priority label.

## Fixed operations and evidence binding

Extend the private holder with closed typed operations, retaining existing GET semantics. Never expose a generic
URL/method/header/tool/parameters sender. Build URLSearchParams from validated selections and encodeURIComponent IDs.
Only these additions to the existing clients/overview reads:

1. GET `/clients/:id/observations`: DB explicit status comma-list (nonempty unique known max4), severity comma-list
   (nonempty unique known max5), integer limit1..100 (UI25/50/100, default25), optional opaque cursor1..400. Defaults
   OPEN+ACKNOWLEDGED/all severities. Fixture: no query at all, fixed active page≤100, no cursor/truncation; unsupported
   fixture filter/page input is refused locally. No fixture control suggests those server features work.
2. POST `/tools/execute`, only from a deliberate current observation evidence click. Body exactly
   `{version:'1',clientId,tool,parameters,requestId}`. Fresh crypto.randomUUID requestId per click (API8..64 pattern).
   Derive client/source/connection/sourceID from validated selection, never form text. Explicit connectionId matches
   scope pattern; externalEventId matches EXTERNAL_ID_PATTERN (printableASCII1..128). Invalid references cause visible
   evidence-unavailable and zero request. Use application/json; holder injects bearer and same-origin/omit/no-store/
   redirect-error/no-referrer options. Same original deadline and byte cap apply to POST result. No automatic retry.
   Operation-specific success: GET requires HTTP200; evidence POST requires the existing controllers' HTTP201 JSON
   ResourceView response. Keep content-type/redirect/body/deadline/401/403 guards; no arbitrary2xx acceptance or server
   status change. Positive fixture/DB evidence journeys must exercise actual201; GET200-only has a focused regression.

| Captured source/type/mode | Exact tool/parameters and result identity |
|---|---|
| atera/alert, either mode | atera.alert.list, {connectionId}; validate whole bounded result then filter exact selected ID: DB externalId, fixture externalEventId |
| atera/ticket, either mode | atera.ticket.get, {connectionId,ticketId:externalEventId}; every returned item must match selected ID: DB externalId, fixture id |
| huntress/incident, DB | huntress.incident.get, {connectionId,incidentId:externalEventId}; every returned SnapshotItem.externalId must match selected ID |
| huntress/incident, fixture | visibly unavailable in this demo; no request, no absence claim |
| any other source/type | unsupported stored evidence; no request or fallback |

Before accepting evidence, ResourceView source/resourceType/connectionId must exactly match captured tuple (no null
connection fallback). Item type/mode/scope/tuple validation uses the table above. FIXTURE only in fixture mode;
OK/STALE/ERROR/MISSING only in DB mode, preserving accepted S5-A status-mode validation. Preserve original truncation
even after local alert filtering. Empty success means only “not in this stored read”; truncated empty must explain it
may exist beyond the bounded read. ERROR/MISSING null is unavailable, never empty success. STALE/FIXTURE visibly labelled.
Show asOf/lastSuccessAt independently; null time unknown. Never label overview/queue/evidence one atomic snapshot.
Do not show raw safeErrorCode or body as diagnostics. Optional X-Atlas-Correlation-Id/X-Atlas-Tool-Execution-Id are
displayed only when ASCII opaque IDs matching `^[A-Za-z0-9._:-]{1,128}$`; otherwise omit. They grant no authority;
fixture has no execution header and none is invented. No source-provided URL is made clickable or placed in attributes.

## State and UX changes

Retain credential/scope/panel generations and memory-only token. Until context validates current workspace/client,
queue/evidence cannot start. Successful initial context triggers one queue fetch; evidence always requires explicit click.
Separate context/queue/detail/evidence regions and loading/error/empty states. Context refresh clears dependent queue,
selection, evidence and cursor synchronously, then reloads queue only after valid context. Queue filter/page/refresh
clears prior queue page, selected observation and evidence before request; first-page reset on filter/limit/refresh.
Next page replaces one page; offer first-page reset, no unbounded retained history. Observation selection invalidates
evidence generation and clears it synchronously, no automatic source fetch. Explicit evidence refresh uses fresh requestId.
Every completion including error/401/403/finally checks captured credential/scope/panel generation; evidence also checks
selected observation ID and source tuple. Stale work changes no data, selection, error, mode badge or spinner.
Current401 disconnects all. Every current403 including evidence clears full scope and refreshes picker once, no automatic
selection; picker403 does not recurse. Other failures clear affected panel, fixed code+explicit retry, no stale success.
Credential replacement/disconnect/pagehide/bfcache rules remain unchanged. Abort is never the isolation guarantee.
Desktop retains navy header/light work surface/teal accent; client picker, queue, selected detail/evidence and bounded
context. At320/768/1440 panels fit/stack. Semantic buttons, labels, headings, focus and polite announcements; source
urgency/uncertainty text independent of color. No chat/action placeholders or invented metrics. Long identifiers wrap.

## Ownership, scope, checks and stopping point

Codex owns brief/integration/status; independent explicit Astra/xhigh reviews this source-backed concretization before
code. Existing dual-approved architecture remains controlling. Material contract/data/authority changes return to both
required architecture reviewers before implementation. Initial actual-code S5-B acceptance is a separate fresh Astra/xhigh.
Fresh native Opus5.5/high owns one cohesive S5-B implementation and its repairs, no subagents, sole checkout writer.
Permitted code: `apps/operator/` focused modules/HTML/CSS/nearest AGENTS; focused operator unit/browser/PG tests and
small support; routing context map and RUNBOOK; new S5-B implementation report. Preserve API/static server/build scripts,
dependencies/lockfile/tsconfigs, accepted server/domain/authority/schema/migrations/fixtures, all normative8files, historical
reports/manifests/archives/seals. New view modules may own DOM construction; update local routing and artifact/parity tests
for actual module boundaries without weakening no-inline/no-storage/no-server-import/Authorization-only-holder checks.
Keep modules near500/hard700, thin controller/composition; extract queue/evidence/DTO/view concerns cohesively.

Required checks: all14 established commands (unit/PGlite incl context budget, schema/generate, root+browser typecheck,
UI/API build/smoke, actual PG17 suite, PG17 check/drift, browser E2E, tracked/untracked whitespace). Fresh production
install/build/prune/other-cwd serve; actual engine/version and bundle manifest; visual review320/768/1440 with synthetic
data, after token cleared. B1–B9 plus A1–A8 regressions. Deterministic ignored-abort context/queue/evidence races,
malformed/scope/tuple/cap/injection responses, queue resets, all evidence states/absence semantics, positive fixture
Atera alert and honest Huntress limitation, DB filter/page/get-evidence/Gateway-audit journey and denial, no mutation/
unapproved-route calls. Tests must catch removed guards/validation/render safety with restored-byte negative controls.
Require synthetic visual PNGs after clearing the password INPUT and verifying token-free DOM/capture; the synthetic
session may stay connected for queue/detail/evidence screenshots. Prohibit trace/HAR/video and credential-bearing
captures. Safe check reports/logs are retained; no token, Authorization, private URL or raw sensitive diagnostic in them.
No real data/provider/vendor call. DisposablePG17 via existing silent
wrapper only; never print credentials/URLs/Authorization or read private config. Preserve failures and original reviews.
Checkpoint report binds source/built inventory, checks/probes/visuals, actual model/effort/elapsed/repairs and residuals.
Native subscription only, no API/credits/fallback; actual Claude message-model stream required, quota unknown if unexposed.
