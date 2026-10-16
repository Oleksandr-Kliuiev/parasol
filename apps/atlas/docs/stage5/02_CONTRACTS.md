# Read contracts and evidence

No new data endpoint, database model, permission, migration or Gateway entry is introduced. No browser imports server
repositories. Browser DTO types/validators are focused local projections of the accepted contracts, not broad core barrels.

## Exact allowed HTTP operations

| Operation | Existing contract | Console use |
|---|---|---|
| GET /clients | ClientSummary[] `{id,name}` | authorized client picker |
| GET /clients/:id/overview | ClientContextV1 | clientName, workspace/client scope, graph, resources and completeness |
| GET /clients/:id/observations | ObservationPage | one client queue, existing status/severity/limit/cursor |
| POST /tools/execute | ToolRequest v1; ResourceView result | explicit source-evidence button only |

The transport constructs relative paths from fixed templates, encodeURIComponent IDs and URLSearchParams query values.
No caller-controlled URL/method/headers/tool name. Authorization is injected from the private current credential holder.
Fetch uses credentials:'omit', redirect:'error', cache:'no-store', signal and an original10s browser request deadline.
Abort/timeout cancels browser consumption; it does NOT claim database cancellation or rolled-back audit.
No automatic retry; refresh is an explicit new request. Error bodies are never echoed as HTML/raw JSON.

Observation defaults: status OPEN,ACKNOWLEDGED; all severities; limit25. Permitted statuses/severities follow core enums.
Cursor is opaque; reset on client/filter/limit/refresh change. Client-side sorts must not reorder server severity/priority.
These filter/page-size/cursor rules are DB-mode only. Fixture context.mode=fixture selects a fixed-demo queue: GET
/observations with no query, all active statuses/severities, up to100 returned items, no page-size claim or pagination.
Unsupported fixture filter/page requests are rejected locally as RESPONSE_INVALID, never sent or silently ignored.
Page replacement (not unlimited append) bounds retained queue rows to100. Counts/total belong to this response selection.
No stable multi-request snapshot is promised; concurrent lifecycle updates can alter counts/pages. Source evidence and
overview have their own times; do not invent a shared generatedAt or label them one atomic snapshot.

## Runtime validation and bounds

Validate response shape, relevant enums/times and displayed field types BEFORE committing any response to state. Context
must be ClientContextV1 and match the requested client. Its workspaceId establishes that credential epoch's workspace;
later contexts/observation items must match it. Observation items must match selected client and current workspace.
Only a validated GET /clients response in the current credential epoch populates the picker; no response can grant
authority or automatically select a client. Any mismatch is a fixed visible RESPONSE_INVALID with no payload. In DB mode
every observation item must satisfy requested status/severity and items.length<=requested limit. In fixture mode items
must be active, up to100, and no cursor/truncation may imply pagination. Check all nested graph rows for workspace/client
match and confirmed-link status. Resource source/resourceType/connectionId must match the captured request tuple.
The client picker filters the accepted bounded list locally by name/ID; show at most250 matching rows in server order
and expose narrowing search, so later authorized clients remain selectable without a new endpoint.
Resource results have no scope envelope; the existing Gateway is authoritative, and the browser binds result acceptance
to the exact captured credential/client/selection epoch and requested connection/resource/source tuple.

Consume at most4MiB per response stream, cancelling on overflow; max10,000 client summaries accepted, first250 displayed
with explicit list-truncated message when larger. Do not silently pretend client-side truncation is a server total. Maximum
queue100 items, context people/devices/links each1000, resources100, each resource items1000; oversized responses are a
fixed RESPONSE_TOO_LARGE, never partial success. Strings displayed at most4000 codepoints, with a visible shortened marker;
identifiers needed for requests must validate unshortened, never use shortened labels as identity. A context beyond
these caps is unavailable to this console, including its queue; no narrower response is invented. Exact validators and
field-limit parity are implementation brief material before S5-B. Display only these item shapes:
- DB SnapshotItem: source/resourceType/externalId/title/status/severity/priority/device reference/occurredAt/updatedAt.
- FIXTURE normalized alert/incident: workspaceId/clientId/source/connectionId/resourceType/externalEventId/revision/kind,
  summary/sourceSeverity/occurredAt; verify its scope/source tuple. Do not display facts or externalDevice.
- FIXTURE ticket: id/title/status only. The accepted get tool matches this id.
Context person displayName and device hostname/confirmed person reference may be shown; Person.email is not displayed.
Unknown item shapes are RESPONSE_INVALID, never arbitrary JSON. Ignore undisplayed additive fields after validation.

## Evidence action allowlist

Only the selected current observation can create this request; parameters are derived from validated source references.
| Observation source/resourceType | Tool and required parameters |
|---|---|
| atera/alert | atera.alert.list; explicit connectionId, then local exact ID filtering as below |
| atera/ticket | atera.ticket.get; ticketId=externalEventId and explicit connectionId |
| huntress/incident in DB context | huntress.incident.get; incidentId=externalEventId and explicit connectionId |
| huntress/incident in fixture context | lookup unavailable in this demo; no tool request or absence claim |

Request body: `{version:'1',clientId,tool,parameters,requestId}`. A fresh opaque requestId is generated per deliberate click.
No arbitrary parameters or names from text/evidence. connectionId must match SCOPE_ID_PATTERN
(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`); source IDs must match EXTERNAL_ID_PATTERN (`^[\x21-\x7e]{1,128}$`).
Invalid references are visible evidence-unavailable without a request. Atera alert list filtering uses SnapshotItem.externalId
in DB mode, or validated NormalizedEvent.externalEventId in fixture mode, equal to selected observation.externalEventId;
source/resource/connection and any item scope must also match. Never coalesce arbitrary identifier fields.
The accepted fixture Huntress get would discard its normalized item: do not call it or interpret its empty array. Positive
fixture evidence uses its Atera alert list; DB proves supported get/filtered evidence. Unsupported source/type has a visible evidence-unavailable reason.
No broad list fallback after get/permission/error. No external vendor hyperlinks from source values; identifiers are text.
Retain X-Atlas-Correlation-Id and X-Atlas-Tool-Execution-Id as optional bounded diagnostic text only; never invent
missing values. Fixture responses have no execution-id header; DB supplies it only on successful tool execution. Server permission checks and
ToolExecution/audit settlement remain unchanged. A timeout can have an audit/ledger outcome; no execution replay claim.
