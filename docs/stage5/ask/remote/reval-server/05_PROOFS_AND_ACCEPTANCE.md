# Platform proof, privacy and implementation gates

## Independent process/ingress census

The DB ledger cannot count pre-reserve rejects, hidden requests or process-local dispatch work. A measured
server guard and independent platform process/socket inventory therefore supplement the atomic financial
snapshot. This slice admits exactly ONE API server incarnation for the registered synthetic DB. No second
remote operator/process, worker, load balancer retry or replica is silently allowed.

The guard records metadata at entry to every Ask capability/submit path (including rejected/unpaired calls),
authenticated task creation, commit outcome, dispatch capability consumption, transport entry, publication
and actual physical-owner release. Counters advance before handing work to an asynchronous path. No sampled
logs, caller-reported counts or counting only successful handoffs. It stores no question/body/length/hash,
raw path/header, bearer, observed intent or source fact. Pre-scope events use aggregate unattributed counts;
they do not invent a scoped correlation or disclose another tenant.

Exact PROCESS_CENSUS payload:
```
{censusId,guardEpoch,capabilityIngressCount,submitIngressCount,handoffIngressCount,
 rejectedUnpairedCount,unattributedCount,reservationConfirmedCount,commitUnknownCount,
 capabilityConsumedCount,transportEntryCount,publicationCount,physicalReleaseCount,
 uncollectedTerminalCount,activeTaskCount,pendingCommitCount,coverage:'COMPLETE'|'UNKNOWN',tasks}
```
All event counters above through uncollectedTerminalCount are monotonic Dec64 per UUID guardEpoch/serverBootId.
activeTaskCount is instead a CURRENT gauge0..4: it increases on physical task acquisition and decreases on
actual release. pendingCommitCount is a CURRENT0..4 gauge of physically pending reserve/settlement/publication
DB commits, regardless of whether a logical timeout already occurred. Never reject a legitimate gauge
decrease or use it as a cumulative event delta. Similarly,
DRAIN pendingTaskCount/pendingCommitCount/physicalOwnerCount and reachableProcessCount are current gauges;
its unmappedAttemptCount is the current unresolved mapping count. All remain checked nonnegative Dec64.
publicationCount increments once per Ask SUBMIT whose HTTP writer reaches SERVER_FINISHED (not capability
responses, selected outcomes, audit-only completion or partial writes). physicalReleaseCount increments
once per physical task release. uncollectedTerminalCount counts expired/missing required safe observations
and is sticky. tasks max4 physical owners plus the one handoff slot;
closed task metadata for the current armed case may remain until the POST census, without its raw content.
Each exact task item:
`{correlationId,reservation:'NONE_CONFIRMED'|'COMMITTED'|'COMMIT_UNKNOWN',
capabilityConsumed,transportEntered,noDispatchProof:'ORIGINAL_PRIVATE_PROOF'|'UNAVAILABLE',
ownerReleased,publication:'ANSWER'|'ERROR'|'NONE',terminalObservationId,terminalRevision}`.
CorrelationId/terminalObservationId are UUID|null; terminalRevision integer1..16|null, both terminal fields
null together when no scoped record exists. publication means SERVER_FINISHED kind only; NONE otherwise,
never the intended candidate. Detailed detected fault/publication/transaction distinctions are in06. Flags boolean. Private proof objects themselves are never exported/serialized.
A returned metadata flag does not mint a proof or authorize financial mutation. The safe terminal-observation
channel is independent of raw pair revocation and current browser authority; no body access is restored.

Capture guard PRE before arming and POST after task release/handoff, on the same uninterrupted epoch. Compare
ingress deltas with operator-reported capability/submission/pacing events, and reservation/transport deltas
with the DB census. Any unreported submit/duplicate/extra dispatch, gap/reset/missing task or incomplete
platform inventory stops the run. Zero net financial change does not hide a second/no-dispatch attempt.
Platform observation covers server process starts/exits and eligible network paths throughout the interval,
not just an initial `ps` snapshot. Unknown continuity makes the corresponding safety category unverified.

The measured guard proves software observations under its trust boundary; platform controls independently
exclude an unmeasured server/connection path and identify lost processes. It cannot prove absence of a
compromised kernel/root/owner or provider-side activity using a separately leaked key. Dedicated-project
account evidence remains a separate owner obligation, not an inferred local counter.

## Egress proof interface

Register the actual execution environment, process family/identity, database local socket, owner IPC,
dedicated browser origin/profile and every network-capable component BEFORE admission. The approved flow
inventory permits only local browser->API, local owner/instrument IPC, local registered DB, necessary
explicitly documented DNS resolution, and server direct TLS443 to `eu.api.openai.com` for the fixed endpoint.
No external APM, analytics, updater, proxy, alternate OpenAI host, redirect, webhook or unrecorded subprocess.
Account for DNS resolver destinations explicitly; do not pretend a hostname allowlist describes every packet.

Platform enforcement must be effective for the measured server process/container, not a documentary config.
Bind host resolution/TLS hostname verification, deny redirects/proxy env/alternate routes, and show the applied
policy includes children and denies unapproved destinations. Browser/instrument have no provider egress.
Transport source/build proof and offline negative tests supplement this, but mocks do not prove platform rules.
No packet/body capture or TLS interception is required or permitted to obtain a numeric destination census.
Do not persist per-request/flow payload byte sizes or timings that serve as body-length records; destination
connection/attempt counts and the separately admitted end-to-end latency are sufficient.

Exact PLATFORM_PROOF payload:
`{environmentId,buildManifestSha256,serverBootId,policyEvidenceRef,destinationInventorySha256,
intervalStart,intervalEnd,processCoverage:'COMPLETE'|'UNKNOWN',
destinationCoverage:'COMPLETE'|'UNKNOWN',unexpectedDestinationCount,
unknownDestinationCount,unmeasuredProcessCount,mode:'MEASURED'|'OFFLINE_SIMULATED',countsAsVerifiedZero}`.
IDs/refs/scalars follow01; booleans strict. Inventory digest hashes approved destination metadata, not traffic.
Counts are measured over the specified actual interval. countsAsVerifiedZero can be true only with measured
complete coverage, zero unknown/unexpected/unmeasured counts and accepted matching platform evidence.
OFFLINE_SIMULATED ALWAYS sets false. Before/after snapshots without interval coverage are not complete.

A proof is tied to real platform configuration/image/time; copying a record from another process, run, host
or policy revision fails. Missing privileges/capabilities leave the platform gate pending. Do not substitute
app-level `fetch` mocks for host egress enforcement or make provider calls as a readiness probe.

## Privacy proof and destination completeness

Before admission, enumerate every potential persistence destination and whether collection is disabled,
scanned locally, or outside local inspection with separate explicit owner evidence. Include at least:

| Area | Required treatment |
|---|---|
| DB | New attempt/counter/audit/security rows; DB statement/parameter/error/slow logs; relevant backups/replicas |
| API/provider client | stdout/stderr/service/container logs, reverse proxy/access/error logs, APM/traces, diagnostics |
| Process/host | crash/core/heap dumps, temp/spool files, session recorders, swap/hibernation and captured diagnostics |
| Browser | console/devtools/HAR/cache/service worker/storage/session restore, extensions/telemetry/recording, clipboard managers |
| Instrument/owner CLI | TTY/session capture, shell history/argv, receipts, replay/export files, temporary/atomic-save leftovers |
| External account | Provider retention/project controls and other project usage: separate owner EU/ZDR/MAM/account evidence |

Disable request/response/header/body collection on Ask AND handoff AND local IPC BEFORE processing data.
Credentials/pairing tokens are also forbidden in logs/receipts. The frozen corpus/fixture library and seeded
source rows are declared approved data destinations, not blanket exclusions for similarly named files/logs.
Allowlist their exact fields/artifact identity so a leaked runtime response cannot hide under a dataset label.

Run before/after scans plus collection-state/interval evidence. Load synthetic canaries and source markers
from the frozen files into scanner memory, never shell arguments. Search existing destinations locally without
copying matched bodies into reports. Persist counts/pass/fail/fixed categories only. Also validate metadata
key/value allowlists; marker absence alone cannot prove absence of paraphrased/novel content. Unknown/unreadable
or newly created destination, enabled body capture, inconsistent scan scope or unaccounted recorder blocks
privacy zero. Scanning a sample or just the application's main log is insufficient.

Use a dedicated measured browser profile with unneeded extensions/telemetry/session persistence disabled.
Avoid clipboard/body pastes, HAR, trace and screenshots during the actual run. Platform preparation must
state its memory/swap/core protections and limits; reference-dropping in JavaScript is not physical erasure.
External provider retention is not locally scanned; name that boundary and require its separate owner proof.
No claim of universal absence beyond the declared measured boundary.

Exact PRIVACY_PROOF payload:
`{environmentId,destinationInventorySha256,scannerManifestSha256,intervalStart,intervalEnd,
coveredDestinationCount,unreadableDestinationCount,newUnclassifiedDestinationCount,
forbiddenContentMatchCount,metadataViolationCount,collectionState:'DISABLED_AS_REQUIRED'|'UNKNOWN',
externalRetentionEvidenceRef,mode:'MEASURED'|'OFFLINE_SIMULATED',countsAsVerifiedZero}`.
ExternalRetentionEvidenceRef is a registered safe ID|null, never an account secret/document body. All counts
checked Dec64. True requires complete approved coverage, actual measured zero violations/unknowns, disabled
collectors and admitted external-retention evidence. OFFLINE_SIMULATED always false. A locally zero scan with
external proof missing remains explicitly incomplete; no software flag can manufacture owner verification.

## Checkpoints proposed for later owner authorization

Each checkpoint stops on an exact source/build/dirty-file manifest with checks and residuals. The author
session is not acceptance. Native Opus5.5/medium implements; clean independent Sol6.1/xhigh and native
Opus5.5/xhigh review the SAME artifact. A bounded repair remains in the corresponding cohesive implementer
session; required reviewers re-review the exact delta/current hash at xhigh. Critical architecture changes
return to fresh Astra/Fable xhigh. No paid calls or automatic activation in any engineering checkpoint.

| Checkpoint | Scope | Stop and dependency |
|---|---|---|
| RS-A | Registration/role confinement, local measured identity channel, owner metadata snapshot/census and pause export | Dual code acceptance before dependent evidence work; private dispatch/financial rules unchanged |
| RS-B | Isolated fixture materializer, source-only clock boundary, DB=fixture verifier | All11x5 PG17 equality and clock/finance isolation; both reviewers accept exact seed mapping |
| RS-C | Manual synthetic focus/pairing/handoff, lifetime ingress gate and private slot; exact local IPC and30s GO integration | All200 manual case paths including15 FX10, browser/PTY/privacy/concurrency proof, new sealed instrument/product/assets; no current receipt flag silently upgraded |
| RS-D | Complete process/egress/privacy proof adapters and integrated offline rehearsal/runbook | Actual supported-platform preparation proof or explicit pending limitations; no simulated verified zeros |
| Separate R-EVAL | Only after all engineering/human/account/data/budget/owner gates | Manual200-case run; actual results get separate Sol/Opus acceptance; no implied deployment/customer use |

RS-A and RS-B can be reviewed independently where scope permits, but no integration advances using an
unaccepted dependency. Exactly one checkout writer; isolated worktrees required for parallel implementation.
Checkpoint briefs must name allowed files, migration/role changes, invariants, baseline and required suite.
No migration or package install occurs during architecture drafting.

## Acceptance matrix

| Contract | Required meaningful verification |
|---|---|
| Roles/RLS | Actual PG17 nonsuperuser provisioning; ninth definer/tenth login distinctness; separate exact atlas_reval_snapshot() allowlist, remote nine unchanged; owner login only in a short-lived explicitly owner-initiated executor and absent from resident C/I/S state; exact role/routine validation; owner-only immutable registration/binding DML; FORCE RLS and composite FKs; table/column/function grants; PUBLIC/default/reprovisioning/SET ROLE/ownership negatives; runtime cannot read owner secrets, mutate registration or invoke owner exports |
| Metadata scope | Wrong workspace/client/actor/admission/login/project/correlation; closed schema/bounds; no foreign detail; full project census detects same-net extra rows; all counters equal original-period sums |
| Atomicity | Two-session reserve/settle/pause/read schedules; mandatory caller READ ONLY REPEATABLE READ; reject READ COMMITTED including VOLATILE split-read counterexample; missing counter vs true zero; deadline/overflow returns failure, never truncated success |
| Liability | Unknown reserve/settlement commit and restart; no retry/refund; confirmed no-dispatch original private proof vs forged DB record; answer+zero/NO_DISPATCH contradictions; late original-day/month settlement; no false credit under unknown liability |
| Closure | Owner routine/pause-only preserved fields; fence-first lock order; concurrent reserve/revoke/settle; all four exact keys; string vs boolean; signed64 boundary and narrower SQL fence overflow; strict run-wide floors; no-op already-paused; lost commit; pause vs drain distinction |
| Census | Concurrent/hidden/unpaired/duplicate ingress, zero-net settled extra attempt, process restart/disappearance, pending commit/physical owner; single-case and all-project counts; capability pacing includes actual observed events |
| Fixtures | All11x5 independent PG17 expected-facts proof, no verifier bearer, overflow page, missing/found/resolved focus, candidate link, urgency; atomic switch rollback; foreign DB/extra rows/FK dependency refusal; no finance/audit reset or trigger bypass |
| Clock isolation | Frozen source projection across real days; real credential/policy/price expiry, budget day/month, monotonic deadlines and receipt freshness unchanged; ordinary remote/OFF/MOCK real freshness regression tests; FX08 limitation explicitly reported |
| Browser focus | Actual typing then manual choice then checkbox must reach readiness for NONE, FOUND and FX10 MISSING; exact question/observationId in the captured request; manual pairing entry only in sealed dedicated console assets, no capability DTO extension, unregistered PAIR404; manual exact one-choice focus for every fixture; all15 FX10 cases request the frozen absent ID and read MISSING/hasFocus:false; all200 case paths keep exact corpus predicates; no arbitrary ID or altered normal-console focus; no auto-selection/consent |
| Browser generations | Exercise the exact04 transition table: repeated typing retains new input; selection retains draft/new choice; edit after selection requires reselection and fresh consent; external invalidations clear both; submit captures then clears form without self-invalidating; question/choice/context/queue/selection/capability/policy/credential/scope/pair/fixture/boot/disconnect/pagehide/bfcache guards; stale success/error/finally cannot restore consent/selection or affect newer request; current completion retains only eligible answer/handoff |
| Registered ingress | Entire registration lifetime, before pair/after expiry/pause/disconnect/restart; pre-GO/duplicate rejects before DB/reserve; exact503/400/OFF404 and AskErrorV1 headers; outside-header rejection; token claim before parse/auth; malformed body/bearer consumed but no false scoped Binding; stolen valid pair token plus different authenticated workspace/client/actor yields403 before phase1/reserve, consumes arm and creates no registered Binding |
| First arm | Case consumed by its FIRST current GO can arm once; prior-consumed/older GO rejected; duplicate ARM with identical and fresh sequence/challenge rejected; C/S mark seen before fallible checks; ARM/READY ACK loss and send/check failure never re-arm; pair/fixture/day change cannot reset sets; restart/state loss stops run; next unconsumed case becomes eligible only after prior completion/POST checks |
| GO integration | Explicit future30s PRE/arm/GO bound; preparation before GO; case consumed before ARM/READY, GO shown after both ACKs; UTC day/month/expiry/clock uncertainty shorten it; no retry or renewal, original Ask/provider deadline unchanged; consecutive target-platform ARM/READY rehearsal counts/latency and injected before/after-consumption failures expose denominator fragility |
| Terminal fault | Model/tier/usage/upstream-auth/invalid detection before failed/unknown settlement; pause/revoke before raw handoff; failed HTTP publication/expiry/disconnect; known FAILED survives raw cleanup and unknown liability; ordinary UNAVAILABLE stays incomplete |
| Local protocol | Exact06 schemas/directions/sequences/challenges; replay/stale/delayed ACK and commit; raw/secret-to-persistence denial; instrument/server owner-mutation or owner-handle acquisition denial; no resident controller table-owner credential; counter versus gauge behavior |
| Handoff | Exact server publication vs edited same-shape DTO; one-use concurrent claims/replay; raw bytes caps/UTF8/duplicate keys/expiry; nonce theft/crossscope/CSRF/Origin; IPC disconnect/unacked transfer; no raw values survive receipt API |
| Identity | Wrong image/Node/loader/boot/DB instance; copied system_identifier with different physical socket/data directory/postmaster; exact producer/kind evidence distinction; replace file/socket after check; unmeasured preload; peer PID reuse/reconnect; forged server hash; unsupported platform remains unverified |
| PTY/local CLI | Real-PTY raw mode before sensitive processing, type-ahead/signals/save failure/cleanup; no body/secret argv/history/stdout; exact local IPC exception, all provider/network APIs still blocked |
| Platform/privacy | Complete destination inventory, effective deny rules and process coverage; scanner failure/unreadable/new sink; canary leak detection without report content; every simulated result countsAsVerifiedZero:false |
| Integration | Context-budget, focused units, actual PG17/RLS, browser E2E/visual where changed, typecheck, migration validation, API/operator build; exact production-copy reproducibility; accepted ancestor regressions appropriate to changed boundaries |

The full required suite belongs to each concrete brief and must be run after changes. A build passing is not
architecture approval; a mock endpoint is not live verification; a signed/hashed report is not proof of its
underlying observation. Record failures, repair rounds, model/effort/effective evidence and scope honestly.

## Gates and evidence identity

Future runtime/tool/build edits invalidate the affected accepted source/build fingerprints. Preserve the
historical seals and frozen norm files; issue NEW manifests/closure verification for affected code, build,
seed mapping, scanners, observer, browser and instrument. Declare the old-to-new delta and compatibility;
never relabel old accepted bytes as the new implementation. At integration bind the exact then-accepted
execution package, including repairs, and re-review its changed scope independently.

All engineering completion still leaves explicit owner decisions: human labels/adjudication; designated
operator; isolated DB/platform; account EU/retention; dedicated key/project; current price/window; synthetic
data; duration/expiry; budget/opening liability/rerun allowance; and actual paid R-EVAL start. This design
provides no activation API and authorizes no charge, account setup, credential provisioning or deployment.

Only a future independently accepted measurement artifact can evaluate live eligibility from those gates.
The current instrument's constant false eligibility/pass flags remain unchanged. Every safety category
needs complete actual evidence; UNKNOWN cannot become zero. Preserve the privacy replay limit and all
unknown-liability no-credit/stronger-failure rules in reports, replay validators and threshold accounting.
