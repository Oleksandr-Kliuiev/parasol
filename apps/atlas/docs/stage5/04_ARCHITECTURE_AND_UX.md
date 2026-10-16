# Architecture and user experience

## Feature boundaries

`apps/operator/` contains static index.html, focused CSS and browser TypeScript modules: credential/session, transport,
DTO validation, client selection, observation queue, context/evidence views and thin composition. Each concern has a
small entry; no server import, framework store or one large component. Shared enums may be copied as explicit versioned
browser contracts with parity tests; do not import Node-backed core/runtime code into the browser.

`apps/api/src/operator/` owns opt-in host/header middleware and fixed static asset serving; main.ts only wires it.
Serve only an explicit generated asset manifest under /operator/; no directory listing, arbitrary filesystem path,
repository/.env source exposure or SPA catch-all for API failures. Unknown asset/path is404; traversal and encoded variants
must never escape the allowlist. `/operator` without trailing slash is404, not a redirect. API routes keep their existing
paths. Enabled host gate is tested for API and assets.

Build with the existing pinned TypeScript compiler into ignored dist/operator. A separate DOM-only tsconfig emits native
ES modules; relative import extensions are valid emitted .js, no inline bundling/eval. Root tsconfig gains only an
apps/operator exclusion; browser modules are checked solely by apps/operator/tsconfig.json with explicit DOM/ES libs,
types:[], rewriteRelativeImportExtensions and no Node ambient types. Root currently includes default DOM libs as well
as Node types; this change partitions browser checking, it does not claim DOM was absent. Browser parity constants
imported into Node tests must be DOM-free. Both root and browser typecheck commands are required. This root config
change, new UI scripts and any pinned dev-only E2E dependency/lockfile additions are declared S5-A baseline deltas.
Copy only fixed HTML/CSS and emit
a deterministic allowlist manifest. Build scripts are focused; dependency versions stay pinned. No new runtime package
is required. Browser E2E may add a pinned dev-only runner after version/routing verification; record its actual browser
version and install source, never silently change lockfile versions for unrelated packages. UI build is a new explicit
command, included in API build/start distribution and checkpoint checks. If enabled assets are missing, startup fails
closed with a fixed code; disabled API startup must still work without UI files. Production install/build is checked.

## Layout and visual behavior

Desktop console: compact header with local/mock badge and disconnect, client selector at left, central observation queue,
detail/evidence area on selection. At narrow widths panels stack without horizontal page overflow. Neutral dark/navy
navigation, light work surface, readable type, restrained cyan accent; severity uses text/icon plus color. Avoid dashboards
of invented metrics. Empty/loading/error/permission-denied/incomplete states occupy the panel explicitly.

Client label and selected source/connection identifiers stay visible above detail. Show local console mode and context
mode independently: fixture/synthetic labels reflect actual contracts, never infer LIVE or production from mode='db'.
Show completeness, freshness and truncation next to the affected resource. For MISSING/ERROR use unavailable content;
STALE remains visibly stale and time-labelled; empty successful arrays say no stored items. Unknown item shapes, invalid required/displayed fields or unknown enum/status values fail
validation, not green/healthy fallback. Undisplayed additive fields are ignored as stated in02. Confidence is explanatory, never an urgency override.

Queue: source/severity/priority/status, short summary and timestamp; keyboard selectable rows implemented as semantic
buttons/links, not clickable divs. Detail: source identifiers, reasonCodes, confirmed entity or unresolved label, lifecycle
timestamps and superseded/conflict references as text; no guessed cross-client navigation. Context shows only allowlisted
person/device and confirmed-link information; no arbitrary payloads. Evidence button names the operation and stored source.

Use labels, headings, landmarks, visible focus, disabled/pending state and polite status announcements. Focus is moved
only when it helps navigation; loading must not trap it. Color is not the only severity/status signal. All flows work by
keyboard at desktop and narrow layout. No animated charts, chat placeholder that accepts input, or unsupported action.

## Integration preservation

Default API behavior remains unchanged while ATLAS_OPERATOR_UI disabled. Enabled host/security header behavior is explicit
opt-in and separately tested. Stage1–4 routes/DTOs/permissions, registry and database are unchanged. Context pages already
contain bounded observations/resources; UI need not fetch a vendor. Existing Gateway audit writes are retained. No new
HTTP write endpoint or business mutation is exposed. Ask Atlas design/implementation starts only after the console gates.
