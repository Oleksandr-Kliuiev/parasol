# Acceptance matrix

## S5-A — serving, credential and client boundary

| ID | Required evidence |
|---|---|
| A1 | UI disabled by default; invalid flag rejected; enabled assets absent fail closed; disabled API works without them; built emitted modules load |
| A2 | exact loopback Host accepted; foreign/alias Host refused on assets and API, CSP/no-store/nosniff/referrer/frame headers; traversal/unknown path no file exposure |
| A3 | token input password field cleared, no token in URL/retained DOM/storage/cookie/log/artifact; reload/pagehide/bfcache disconnect; multiple tabs independent |
| A4 | fixture valid/invalid equality token; PG valid/unknown/revoked/expired stored token; server scope denies forbidden client; no clients explicit; selected context fetched/validated without rendering; UI never invents Actor/permission |
| A5 | token replacement/disconnect during deferred response and error/401/finally; old generation cannot render/clear new data; timeout/abort settle locally without retry |
| A6 | only fixed operations/relative origin; redirects refused; response cap enforced incrementally; malformed/client/workspace mismatch fails with cleared panel; no raw error echo |
| A7 | 401 clears all current data,403 clears affected scope without loop; header/status/token privacy; static JS/CSS and emitted import graph contain no credential/runtime-server imports |
| A8 | keyboard entry/selector/disconnect and visible pending/empty/error states; desktop/narrow screenshot review using real built console |

## S5-B — operator read journey

| ID | Required evidence |
|---|---|
| B1 | DB queue honors server ordering/counts/status/severity/limit and opaque pagination; filter/client/refresh resets cursor/selection; fixture fixed demo page has unsupported controls absent/disabled and no ignored-filter claim; no unlimited retained pages |
| B2 | known entity confirmed-only/unresolved visible; source HIGH/CRITICAL remains urgent with low confidence/monitor route; conflict/superseded references preserved |
| B3 | supported selected source invokes exact allowlisted read tool/connection/sourceID through actual Gateway; existing audit/ledger and optional diagnostics; positive fixture Atera alert (normalized externalEventId); fixture Huntress visibly unavailable/no request; DB get positives; unsupported source no request |
| B4 | read evidence state distinction OK/STALE/ERROR/MISSING/FIXTURE, asOf/lastSuccessAt/truncated/null vs empty; absent item in truncated read not claimed nonexistent |
| B5 | injected HTML/script/URL/CSS and malformed DTO fields never execute or enter attributes/HTML; only reviewed field projections; no arbitrary JSON display |
| B6 | delayed context/queue/evidence + client/credential/filter/selection switch including stale401/403/finally: no wrong-scope render, selection or spinner reset |
| B7 | no calls to action/mapping/lifecycle/sync/PowerOffice/M365/provider routes; no business mutation; source bytes/URLs/tokens absent from console/audit diagnostics |
| B8 | fixture fixed-queue/Atera-alert evidence journey, Huntress limitation; PG full filters/pages/get-evidence journey; selection→queue→detail→switch→disconnect; no unauthorized rows; old data cleared on failed refresh |
| B9 | keyboard, labelled controls, focus/announcements and responsive320/768/1440px screenshots; uncertainty/severity readable without color alone |

Tests must demonstrate the bug/boundary, not mirror implementation. Record browser engine/version and actual built bundle
identity. Deterministic delayed response tests cover stale completion even if AbortController is ignored. Browser assertions
must inspect DOM/storage/network and not only pure state functions. Never capture tokens or real client data in screenshots.
API/PG regressions, production install/build, pinned dependency integrity and context budget remain required.

## Exit and qualifications

Required findings resolved, actual checkpoint independently ACCEPTED by explicit Astra at required effort, exact artifact
seal/preservation checked before advancement. Reviewers initially receive no other reviewer's verdict. This first Stage5
console does not close Ask Atlas, LIVE, production authentication, operational/pilot or vendor verification gates. An
authorized user may retain information already displayed; logout clears this UI and does not revoke tokens remotely.
