# Browser security and state

## Credentials and origin

ATLAS_OPERATOR_UI=1 enables console serving; unset/0 disables it. Other values fail startup. Existing API default and
loopback binding stay intact. While enabled, requests must have Host exactly `127.0.0.1:<configuredPort>`; reject other
hosts before static/API dispatch. The browser also refuses to show token entry outside that exact HTTP loopback origin.
No remote origin, hostname alias, reverse proxy, CORS enablement or configurable API base URL in this slice.
This is defense against accidentally exposing a local console and DNS rebinding, not production authentication.

After submission token lives in one private memory closure only; no export, URL, retained DOM value/attribute, telemetry, console log, persistence,
local/session storage, cookie, IndexedDB, shared worker or history. Clear password input immediately after submission; disable autocomplete/spellcheck and never reuse it as state.
No token in error/report/audit. A typed token is normalized only as the accepted bearer parser permits; invalid token is
rejected without network. Fixture test ATLAS_DEMO_TOKEN must satisfy the same browser bearer pattern; the existing
fixture equality guard is unchanged. Disconnect/replacement/pagehide destroys credential and all data; pageshow after bfcache must
return to disconnected rather than restoring authenticated DOM. Browser extensions/compromised same-origin JS remain
outside this local credential boundary. No claim of zero browser-internal copies or secure memory erasure.

Static HTML/assets require CSP: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self';
font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'. No inline executable code,
eval, remote font/CDN, embedded third-party widget, source map with embedded data or HTML event handlers.
Add no-store, nosniff, Referrer-Policy:no-referrer, X-Frame-Options:DENY. For enabled console API requests also no-store;
do not change business responses/auth semantics. Service workers are not registered. Logout does not revoke API tokens.
Server logs never include Authorization/body. Browser diagnostic text contains only bounded fixed codes and opaque IDs.

## State machine and asynchronous isolation

Session: DISCONNECTED → CONNECTING → READY or DISCONNECTED on401. Token replacement creates a monotonically increasing
credential epoch, aborts all old work and removes all old data BEFORE sending a new request. Multiple tabs do not share
credentials or state.401 on a current request disconnects globally; stale401 from a prior epoch is ignored.

Client: NONE → LOADING_CONTEXT → READY; selection/reset increments scope epoch, aborts old requests and clears context,
queue, evidence, selected observation and cursors synchronously. Until context validates the workspace/client, queue
and evidence requests cannot start.403 clears selected client content and refreshes the client picker with the same
credential; do not loop or auto-select another client. This full scope reset is deliberate for EVERY current403,
including evidence tool denial. Network/5xx/shape failure clears the affected panel and shows error
with explicit retry; do not show old data as newly loaded. Client switch is always available with keyboard.

Each panel has its own request generation. Every completion (success, failure,401/403,finally) checks captured credential,
scope, panel generation and, for evidence, selected observation/source tuple. Abort alone is insufficient: late responses,
already-resolved JSON and stale error/finally callbacks must not alter any current state or DOM. Filter/refresh/page request
clears queue selection/evidence and replaces page; observation selection increments evidence generation and clears it.

Render all vendor/user/source strings with textContent and createElement; no innerHTML, markdown/HTML renderer, srcdoc,
unsafe CSS/url interpolation or clickable source-supplied URL. No raw object inspector. Whitelisted text fields only.
Treat every observation/resource item as untrusted input, including synthetic fixtures.

## Existing server boundary

Bearer→Actor, per-client permissions/RLS, all-of Gateway policy, current connection selection and audit remain server-owned.
No UI actor/workspace/permission input, write tool or new delegation credential. Existing API read transaction semantics
remain unchanged; this package does not claim new post-lock token rechecks for Stage1 endpoints. An in-flight authorized
read may finish after revocation according to its accepted API semantics; each new request authenticates again. UI clears
on the next401/403/explicitdisconnect; it cannot erase data an authorized user has already seen or copied. Production
session/revocation policy requires a separate design. The UI never treats a hidden button as authorization enforcement.
