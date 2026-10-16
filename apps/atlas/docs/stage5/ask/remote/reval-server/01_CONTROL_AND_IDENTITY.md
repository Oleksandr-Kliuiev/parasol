# Owner control, authority and loaded identity

## Processes and authority

The owner administration CLI, API runtime and evaluation instrument are separate principals/processes.
One designated browser operator remains the only remote-admitted actor. No field sent by the browser,
instrument or model supplies owner authority, a permission, scope, effective clock or fixture identity.

| Principal | Allowed | Denied |
|---|---|---|
| API runtime | Existing confined role/routines; read registered evaluation binding; ephemeral capture/handoff | Owner credentials, policy activation/provisioning, direct attempt/counter DML, export-reader EXECUTE |
| Owner evidence reader | Dedicated DB login; execute one registration-bound metadata snapshot routine | Table DML, source rows, secrets, arbitrary SQL export, reserve/settle/pause/activate, role inheritance |
| Evidence definer | NOLOGIN, NOINHERIT, NOBYPASSRLS; exact SELECT columns needed by the snapshot routine | Any INSERT/UPDATE/DELETE, schema CREATE, GRANT, arbitrary routine EXECUTE, source payload |
| Owner pause command | Existing owner authentication; call existing fence-first policy revision with PAUSED only | Implicit resume/activate, cap/expiry/project/profile changes, refunds, raw query console |
| Fixed fixture verifier | Owner-launched bounded process, existing confined runtime DB role, fixed registered scope and current DB actor/membership checks; no bearer | Ask/provider entrypoints, user credentials, arbitrary scope/query/export, writes |
| Synthetic seed owner | Explicit offline isolated-DB maintenance in 03 | Customer DB, runtime credentials, financial/audit deletion, trigger/RLS bypass |
| Local instrument | Frozen corpus/comparators, owner-delivered safe metadata, one paired transient handoff | Owner DB credential, invoking Ask/provider, automatic consent/submit/retry, activation |

The new owner-reader function `atlas_reval_snapshot` runs under FORCE RLS using exact registered workspace scope; every FK carries
workspace/client scope. Registration maps a dedicated evidence-reader login OID to exactly one sandbox,
workspace/client/actor/admission. The function derives scope from that registration, compares the effective
login and captured session_user, clears stale local settings, and sets scoped settings transaction-locally.
Caller-supplied workspace hints or SET ROLE never enlarge this mapping. Cross-registration requests fail
with a fixed code and return no existence/financial details.

Use new migrations, never edit accepted migrations. Revoke PUBLIC EXECUTE on every new routine/trigger.
The evidence definer owns exactly `public.atlas_reval_snapshot()` under a separate exact routine/EXECUTE
allowlist and count. Use the distinct atlas_reval_* prefix; the accepted atlas_ask_remote_* allowlist/count
remains exactly its existing nine routines under the remote definer. No wildcard ownership/grant or prefix
exception. The evidence definer gains SELECT only on explicit metadata columns of
RemoteAskPolicy, RemoteAskClientAdmission, RemoteAskPeriodCounter, RemoteAskAttempt,
ActionAuthorityFence and the two new registration/binding tables. Policy secretRef, projectIdentity,
ownerApprovalRef, retentionAttestationRef and provider credentials are not exported. Internal project
selection uses its fixed registered binding; the reader cannot request another project.
Any columns required internally but not exported remain confined to the definer.

Runtime receives only the needed SELECT columns of registration/binding, never their write or ownership
capability. Revoke generic/default-grant write privileges after provisioning; test effective column grants,
PUBLIC paths, role membership, ownership and reprovisioning. Existing cleanup, Stage3 and remote financial
definers receive no new privileges. RS-A adds a ninth distinct protected role for the evidence definer;
the dedicated evidence-reader LOGIN is a tenth distinct principal, never an alias/member of those nine.
Extend roles.sql distinct-role, creation/reprovisioning and exact routine ownership/EXECUTE allowlist checks
and assertRuntimeRole/readiness negatives for BOTH new roles. No name-prefix exception may admit arbitrary
atlas_ask_remote_* functions. The existing remote definer does not own the new evidence routine. The owner pause command uses the EXISTING owner-only
`atlas_ask_remote_policy_revise`, not an expanded runtime pause enum or runtime policy mutation path.

The evidence-reader login is C's ONLY resident DB credential. Table-owner authentication/connection is
available only to the explicitly owner-initiated PAUSE_EXPORT, seed or registration operation through its
short-lived owner-authenticated executor/handle. It must never enter C's process heap, pool, connection-serving
state, instrument channel or server bridge. C may coordinate the exact authorized metadata command, but the
owner executor alone opens that bounded owner DB transaction; its handle is scoped to that one operation
and is destroyed/closed on completion or failure. No persistent owner connection, generic SQL executor,
credential-return command, or promotion of an I/S-originated frame to an owner operation is permitted.

## Proposed owner CLI surface

Names below are contracts for later implementation, not runnable commands today. Exact request shapes,
direction permissions, secret separation, response matching and closed failure enums are frozen in06:

| Command | Effect |
|---|---|
| `identity` | Read measured server/process/registration binding with a fresh challenge |
| `snapshot` | Read complete bounded financial census and current policy/fence atomically |
| `pair` / `end-pair` | Create/revoke one memory-only browser/instrument measurement pairing |
| `arm-case` | Registered instrument asks the controller to arm one slot after explicit operator GO prerequisites; no Ask request |
| `pause-export` | Explicit owner PAUSED revision, then export four-key closure after confirmed commit |
| `drain` / `process-census` / `terminal-observation` | Read finite census/physical-owner/safe original-fault metadata; never cancel/refund/dispatch/retry |
| `platform-proof` / `privacy-proof` | Read the closed measured proof records in05; no account/network action |
| `fixture-check` | Read registered DB projection equality proof, no source mutation |

Provisioning/fixture replacement is a separate owner maintenance command in 03. No command accepts a URL,
SQL, provider key, question, intent, request body, arbitrary file-write path, activation state or cap change.
CLI parameters are safe registration/case IDs and closed options; credentials use private inherited handles
or an approved secret resolver, never argv, shell history, terminal output or receipt fields.

Owner reader talks directly to the registered local PostgreSQL instance through its configured local socket.
The instrument does not acquire that DB connection. Its authenticated local IPC connects to one measured
owner controller and the measured server's evidence bridge; no TCP listener or HTTP proxy in the instrument.
The instrument's current blanket network guard needs a separately reviewed future exception for these exact
pre-established local IPC handles. All DNS/TCP/TLS/fetch/provider paths stay blocked for the instrument.
Offline rehearsal retains its existing total network prohibition.

## Local channel and registration

A private Unix-domain socket lives in an owner-created 0700 directory, socket mode 0600, with no symlink or
attacker-writable ancestor. The platform adapter must verify peer credentials/PID and process incarnation;
if it cannot, identity remains UNVERIFIED and live preparation cannot claim a bound channel. A pathname or
UID alone is insufficient. No unauthenticated loopback substitute or silent platform fallback.
Use a private inherited launch channel to bind the server child to the controller before opening commands.
The command protocol uses length-prefixed strict UTF-8 JSON, rejects duplicate keys, unknown keys and trailing
bytes, has a 2-second operation bound, and accepts only the closed operations in this package.
Metadata frames are at most 256 KiB; transient handoff frames at most 288 KiB. Overflow closes the pairing.
All frames follow the per-direction sequence/request-challenge rules in06. Response replays, sequence gaps,
wrong process boot ID or a reconnect invalidate outstanding operations; previously authenticated safe fault
observations retain their historical meaning, never fresh/current authority.

`RevalSandboxRegistration` is owner-created only after isolated-DB evidence in 03. Its immutable metadata:
registrationId and databaseInstanceId (UUIDv4), fixed workspace/client/actor/admission IDs, evidenceReaderRoleOid,
datasetManifestSha256, approved build-manifest identity and synthetic-only designation. No provider credential,
question, raw answer, case label or request ID. A database name or env flag cannot create this registration.
The independent owner registration record binds the actual DB instance; a copied row in another DB is insufficient.
Its physical binding source is the owner-observed PostgreSQL system_identifier from pg_control_system(),
actual local postmaster PID/start, resolved data-directory and local socket device/inode, database OID and
created registration UUID. Record only these allowlisted identity metadata in the protected owner record;
paths stay owner-local and are not instrument payloads. Recheck on connection/restart. A cloned cluster may
copy system_identifier, so that value alone does not suffice; changed physical-instance binding needs new
owner isolation review, not acceptance of a copied registration row.

Creation is a separate offline seed-owner transaction using the existing trusted migration/table-owner
login and explicit scoped DML on ONLY the two new metadata tables, under the isolation procedure in03.
No registration-write definer, runtime registration API or generic CLI SQL is added. Registration is
immutable; binding updates use the exact fence-first source-switch transaction in03. PostgreSQL table
ownership necessarily remains a trust boundary, not an assertion that the owner lacks DML power. The
controlled owner tool, effective grants and independent tests must prohibit edits to immutable registration
and any registration deletion/rebinding during evaluation. Ordinary reader/runtime logins have no DML path.

`RevalFixtureBinding` is a single current row per registration: registration/scope FKs, fixtureId FX01..FX11,
positive signed-64 generation, fixed syntheticFreshnessAt, datasetManifestSha256, installedAt (REAL DB time).
Only the isolated seed owner mutates it transactionally with source rows. Generations never reset/reuse.
No generic binding editor is exposed. Runtime derives this row from its measured launch registration, not headers.
Its generation is captured with phase1 and rechecked under the existing fence in egress and final publication.
A mismatch refuses/discards rather than selecting another fixture. It never supplies financial/actor authority.

## Common scalar bounds and envelopes

Every object is closed: all specified keys required, optional states represented by explicit null, unknown keys
rejected. Strings are well-formed UTF-8; duplicate keys and non-finite/exponent numeric forms reject where decimal
strings are required. There are no opaque arbitrary JSON, exception-message or unbounded string fields.

- `UUID`: canonical lowercase UUIDv4. New randomness uses the OS cryptographic RNG.
- `ScopeId`: accepted Atlas identifier, 1..128 ASCII `[A-Za-z0-9][A-Za-z0-9_.:-]*`.
- `Dec64`: canonical unsigned decimal string, 0..9223372036854775807; positive where specified.
  Parse with BigInt, never Number. Policy versions are positive. FenceEpoch may be zero at observation;
  a closure fence is positive and strictly advances. Actual shared SQL fence remains its existing Int bound.
- `Money`: Dec64, amounts nonnegative; per attempt 0..300000; limits reserve300000, DAY<=2000000,
  MONTH<=10000000 with RC6 lower-only admission. Aggregate arithmetic uses checked BigInt.
- `Time`: UTC ISO instant with milliseconds and `Z`; DAY `YYYY-MM-DD`, MONTH its first date.
- `Digest`: lowercase 64-hex SHA-256 of approved files/build/dataset/metadata ONLY, never a runtime question,
  answer, intent or provider/body content. Frozen corpus file identity is separate from runtime evidence.
- `CaseId`: one of the frozen 200 IDs, not arbitrary text; fixtureId one of FX01..FX11.
- `Seq`: positive Dec64; monotonic, no wrap/reuse. Counts are Dec64; per-case attempt cardinality is 0 or 1.

The exact safe request/response envelopes, permitted operations, secret frame, transient protocol and
FailureCode/PublicError enums are in06. No raw transfer/secret/ACK object is a metadata payload or accepted
by the receipt writer. The four-key closure remains a separate exact value inside its transport response;
transport provenance is saved separately, never as additional closure keys. Safe terminal observations
have independent lifetime/access from the revocable raw slot, as specified in06.

## Loaded build identity and freshness

Owner controller measures a complete immutable deployment image before launch: entrypoint, all loaded runtime
JS/assets/dependencies, Node binary/runtime configuration, migrations/role surface and accepted manifest. Resolve
symlinks before measuring; prevent writes/replacement after measurement with platform-enforced read-only immutable
image/root and a pinned launcher. Disable watch/hot reload, dynamic plugins, unmeasured preload/loader/import paths
and ambient NODE_OPTIONS. No credential values enter launch evidence.

The launch challenge, controller-observed OS PID/start identity, immutable image identity, databaseInstanceId,
serverBootId and inherited-channel acknowledgement bind THIS process incarnation. `IDENTITY` payload exact:
`{databaseInstanceId,buildManifestSha256,runtimeImageSha256,launcherManifestSha256,platformEvidenceRef,
loadedBinding:'MEASURED'|'UNVERIFIED',startedAt}`. EvidenceRef is a fixed registered safe ID <=128 ASCII, not a URL.
The server's reported hash, an on-disk manifest after startup, process name or copied signature alone is UNVERIFIED.
The platform measurement must show why the live process can load only the measured bytes. If unavailable, stop.

Before each arm/submit and after reconnect, use a fresh challenge, measured boot ID and connection sequence;
accept a preflight snapshot only within30 seconds on controller monotonic time and the same real UTC day/month.
This is the explicit shared arm/PRE/GO window in04, not a renewal of any Ask/provider deadline.
Latency or a clock discontinuity that prevents checking freshness invalidates it; never infer freshness from UUIDs.
A restart/new boot ID breaks session continuity, consumes any in-flight case conservatively and requires closure;
it cannot reconstruct dispatch/no-dispatch proof or revive an unknown/terminal run.

This binds an uncompromised measured host/process, not a hostile owner/root/kernel, a malicious browser extension,
or a compromised runtime image. Those are explicit platform trust limits, never authenticated away by self-report.
