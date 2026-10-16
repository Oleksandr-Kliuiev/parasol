# RS-A implementation brief — BRIEF rc4 DRAFT (S5ASKREMOTE-REVAL-SERVER-RSA)

Status: BRIEF rc4 repair DRAFT (brief revision, not an architecture revision) by the implementation author (native `claude-opus-5-5`/medium, same cohesive session); not
approval. Normative pair: this `IMPLEMENTATION_BRIEF.md` plus companion `ACCEPTANCE_CHECKS.md` (tests/suite), frozen
together under `docs/stage5/ask/remote/reval-server/rs-a/`. Root owns the checkout, freezes the pair and transfers write
ownership only after independent acceptance of the SAME bytes. No paid product calls, activation, provider/account access
or deployment; native Max only, no API/credits/fast/fallback.

## 0. Identity and dependencies

- Architecture S5ASKREMOTE-REVAL-SERVER-DESIGN-rc4, package `9fa16222d6c32c18d4d193b6666e078fd3624a4bdb2ccb8ab9fbd68113b08163`
  (38 entries; seal `verification/stage5/S5ASKREMOTE_REVAL_SERVER_DESIGN_APPROVED.json`); obligations NB5, RC2_MINOR.
  RC4 normative files, ancestor grants and financial routine bodies FROZEN. No exported schema/authority change.
- Baseline: the root's repo copy (byte-identical to `/tmp/atlas-reval-rsa/baseline.json`, sha256
  `62328bcb05ee38d1784a111da72fbacc68ca4faca07fde6b68561d86bec64347`): HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`,
  branch `codex/reval-server-contracts-20261011`, 1540 exact files incl. dirty work. Every touched path re-verified
  before the first write; any difference stops work.
- Execution RC5 `5c6a7e521220b703ca78efd045376f7ac98e41c613e17e766b0eadc27b994d97`: none of its 120 files touched (incl.
  `package.json`, `tsconfig.json`, `AGENTS.md`, `docs/AI_CONTEXT_MAP.md`, `docs/DEVELOPMENT_WORKFLOW.md`,
  `tests/context-budget.test.ts`, `packages/ask/**`, `scripts/ask-remote-eval*/**`). Child delta 0, no reseal.
- Accepted R-A/R-B/R-C seals stay historical. Changed accepted files are listed with baseline→new sha256 in the RS-A
  manifest (child delta + RS-A reseal only): `prisma/roles.sql` (baseline `7a9419b37d1d575ad073abf0837850350879ae9b15c018cc6f0c19809b0d3f69`),
  `prisma/schema.prisma`, `prisma/askremote.prisma`, `packages/graph/runtime-role.ts`, `apps/api/src/main.ts`,
  `tests/support/roles-sql.ts`, `tests/support/pg-harness.ts`.
- Host (verified): macOS 26.6.2 arm64 / Darwin 25.6.0, Apple clang 21.0.0, Node v25.8.1 (engines `>=24`; node@22 unused).
  Docker PG17.11 `127.0.0.1:5432` = test-only TCP regression. Root supplied a disposable native Unix PG17.11 test
  cluster descriptor (`/tmp/atlas-reval-rsa/native-pg-fixture.json`, closed keys `{adminRole, adminSecretFile,
  dataDirectory, port, socketDir}`; no global install/service). It is test-fixture input only (§3, ACCEPTANCE_CHECKS.md).

## 1. Scope

IN: registration/binding metadata schema; ninth role (evidence definer) and tenth principal (evidence-reader LOGIN)
confinement; Darwin measured local identity channel (NB5); physical DB binding of EVERY RS-A DB connection; owner
SNAPSHOT atomic full-project census; PAUSE_EXPORT via existing owner `atlas_ask_remote_policy_revise(...,'PAUSED',...)`
with exact four-key closure; strict 06 protocol for these, every other operation fail-closed.
OUT: RS-B (materializer, source clock, FIXTURE_CHECK, binding population, production `register`); RS-C (browser, pair,
handoff, arm, ingress gate, terminal observer, instrument IPC, 30s GO); RS-D (complete image immutability,
process/egress/privacy proof, DRAIN); any financial routine/invariant change, Ask/UI feature, provider path, customer DB
or real key. Consequence (A3): in production, RS-A SNAPSHOT/PAUSE_EXPORT can only refuse until RS-B registers a sandbox.

## 2. NB5 — platform, topology, peer incarnation, launch/TTY/FD ownership

Mechanism (author probe on this host; reproduced by required darwin tests before any claim): `getsockopt(SOL_LOCAL,
LOCAL_PEERTOKEN)` → `audit_token_t`; `audit_token_to_pid/pidversion/euid`; `proc_pidpath_audittoken` (fails if that
incarnation is gone); `proc_pidinfo(PROC_PIDTBSDINFO)` (ppid, start, `e_tdev`). The token names the LAST process that
performed I/O on the peer socket (XNU `last_pid`): on a socketpair the creator until the peer writes, then the peer's
exact pid/pidversion; after reap it fails. Hence every child WRITES FIRST (§2e). Node `spawn` stdio `'pipe'` at fd 3 is
an AF_UNIX socketpair; a helper given a dup of the parent's end reads the child's identity.

Native helper `native/reval-peer/peer.c` (~120 lines, `-lbsm`), built by `scripts/reval-server/build-peer.ts` with fixed
`/usr/bin/clang -std=c11 -O2 -Wall -Wextra -Werror -o <dir>/reval-peer` (fixed basename: the arm64 ad-hoc signature
identifier derives from it) into gitignored `dist/native/reval-peer`; byte reproducibility across two clean builds is
checked and reported honestly. Expected sha256 is pinned in the owner-protected config (`nativePeerHelperSha256`), not
only in `dist/`. Invocation: argv `peer`; fd 3 = dup of channel end; fd 4 = pipe with the expected exe realpath;
stdin/stderr ignored, stdout pipe (inherited 0–4 per the §2c allowlist); killed if not exited within
500 ms. Output: one line, exact closed internal shape `{pid,pidversion,euid,ppid,startSec,startUsec,hasTty,exeMatch}`
(all required, integers, strict booleans), never exported; any error/extra key/malformed line = helper failure.
Race-free order: token1 → pidinfo → `proc_pidpath_audittoken(token1)` succeeds → token2 == token1. C checks before use:
realpath, owner uid, no group/world write, sha256 = config pin. TOCTOU between hash check and exec is not excluded → full
image UNVERIFIED.

Platform (fail closed): only `darwin`/`arm64` with the pinned helper; actual peer proof REQUIRED for every channel.
Otherwise C sends NO response frame (it cannot honestly emit a `databaseInstanceId`, 06:41–42) and exits with a fixed
local exit code (10 platform, 11 helper, 12 peer); O maps that exit code locally to a displayed `PLATFORM_UNVERIFIED`/
`IDENTITY_UNVERIFIED`, never as a C-authenticated response. No containment path inside RS-A on such hosts; owner tools
outside RS-A remain (not RS-A closures). No uid/path/inheritance-only authority. `loadedBinding` is constant
`'UNVERIFIED'`; actual peer verification is distinct from the full loaded-image binding (RS-D).

### 2a. Topology (one OS user; O is root)

- **O** owner CLI `scripts/reval-server/owner.ts`: the ONLY process with a TTY (refuses without one); closed-grammar REPL,
  readline history off/never persisted; one option `--config <abs path>`; generates O↔C connectionId and serverBootId
  (UUIDv4, OS CSPRNG); spawns C `detached:true` (setsid, no TTY), argv `[node, <controller entry>]`, stdio
  `['ignore','ignore','ignore','pipe']`, env EXACTLY `ATLAS_REVAL_CONFIG`, `ATLAS_REVAL_CONNECTION_ID`,
  `ATLAS_REVAL_SERVER_BOOT_ID`.
- **C** controller `scripts/reval-server/controller.ts` → `packages/reval/controller.ts` `createController(productionDeps())`:
  (1) platform/helper gate; (2) on O's first frame peer-proof fd 3 (token.pid===`process.ppid`, ppid unchanged after
  the query, euid equal, exeMatch, O hasTty, C has no TTY via `open('/dev/tty')` failing); (3) source/build check (§2d);
  (4) reader connection + physical binding (§3); (5) a successful snapshot wrapper (registration, binding, build
  comparison §2d) — so LAUNCH cannot start S without a registered sandbox (A3); (6) `server.mode` per §2b.
- **S** API `dist/apps/api/src/main.js`, bridge mode only (§3). **E** owner executor `scripts/reval-server/owner-exec.ts`,
  one per PAUSE_EXPORT (§6). S spawns no children (tested); E spawns none.

### 2b. Owner config — closed `RevalOwnerConfigV1`, 0600 file in 0700 dir, no symlinked components

```
{contractVersion:'RevalOwnerConfigV1', registrationId, databaseInstanceId, workspaceId, clientId, actorId, admissionId,
 approvedPriceRevision, nativePeerHelper:<abs path>, nativePeerHelperSha256,
 endpoint:{socketDir:<abs path>, port:<1024..65535>, database:<name>}, roles:{reader, runtime, owner},
 physical:{systemIdentifier, databaseOid, postmasterStartTime, postmasterPid, dataDirectory, socketDevice, socketInode},
 secretFiles:{reader, runtime, owner}, server:{mode:'LAUNCH'|'NONE', apiEntry, port}}
```
`server.mode` is exactly `LAUNCH` (spawn S) or `NONE` (no S; IDENTITY → `IDENTITY_UNVERIFIED`; SNAPSHOT/PAUSE_EXPORT do
not need S). No attach or other mode; no absent-server positive IDENTITY. No host field; no TCP alternative.
**Secret format (closed):** each secret file is a pure credential: one password matching `^[A-Za-z0-9._~-]{16,256}$`
plus optional final newline; anything else (URL, `:`/`/`/`@`/`=`/`?`, host, port, database, whitespace) is refused, so
a secret cannot substitute an endpoint. Usernames come from `roles`, endpoint from `endpoint` only. C never opens
`secretFiles.runtime/owner` and only forwards their paths after peer proof; the only credential value in C is the reader
password. No runtime/owner credential appears in any C frame, argv or env. Production precondition: the owner OS
user can read `<dataDirectory>/postmaster.pid`.

### 2c. Ownership and termination

O exit/EOF → C kills E (§6), SIGTERM S then SIGKILL after 5 s, reaps both, exits. C exit/death → S bridge EOF → S closes
HTTP and exits; E exits on parent EOF (§6). S death → LOST, no relaunch in that session. Peer-proof mismatch at any time →
kill S, `IDENTITY_UNVERIFIED`.
**Inheritance allowlist (exact).** Only descriptors intentionally passed across exec are constrained: O→C, C→S and C→E
inherit exactly fds 0–2 (`/dev/null` per `'ignore'`) and fd 3 (that child's private AF_UNIX socketpair end); the helper
additionally inherits fd 4 (expected-path pipe) and its stdout pipe. No other descriptor may be inherited: no DB socket,
secret/config file, listening socket, other child's channel or TTY (O's TTY is never passed; children get no
controlling terminal). Descriptors a process opens AFTER exec are legitimate and classified, not counted against the
allowlist: its own PostgreSQL client sockets (C reader; S runtime pool; E owner), Node/libuv internals (kqueue, wakeup/
signal pipes, worker/thread fds), S's HTTP listener and accepted loopback sockets, C's transient pipes/sockets to its
own children/helper, and bounded file reads (config, secret, pid file, build manifest) closed after use. Complete
process/destination proof stays RS-D.

### 2d. IDENTITY (CONTROLLER, exact 01 schema) and source/build binding

`buildManifestSha256` = canonical sorted `path\tsha256` over `dist/apps/api/**`, `dist/packages/**`, `package-lock.json`,
`prisma/migrations/**`, `prisma/roles.sql`, `prisma/roles/*.sql`; it MUST equal the registration's `buildManifestSha256`
(returned in the snapshot wrapper) before launch and before every export, else `REGISTRATION_MISMATCH`.
`server.apiEntry` must be an absolute realpath equal to the realpath of `dist/apps/api/src/main.js` that is itself an
entry of that manifest; otherwise refuse before launch.
`runtimeImageSha256` = sha256 of `{nodeBinarySha256,buildManifestSha256,packageLockSha256}` (DECLARED-set pre-launch
digest, not complete/immutable); `launcherManifestSha256` over `packages/reval/**`, `scripts/reval-server/**`, `peer.c`,
helper hash; `startedAt` from the peer proof; `platformEvidenceRef` exactly `rsa-peertoken-unixphys-v1` in production
(test-only `rsa-test-tcp-unverified-v1` lives in `tests/support/`, unreachable from production); `loadedBinding:
'UNVERIFIED'`. EVERY IDENTITY re-runs the peer proof on S (same pid AND pidversion as recorded, else kill S,
`IDENTITY_UNVERIFIED`) and the C-side physical recheck. S's inner IDENTITY (emitter SERVER) uses the same public schema;
its echoed fields are never evidence.

### 2e. Child handshake order (S and E; private closed frames, ≤4 KiB, separate decoder from 06)

1. Child starts with NO credential and NO DB connection; its FIRST action is writing
   `RevalChildHelloV1 {kind:'SERVER'|'EXECUTOR', helloNonce(UUID)}` on fd 3.
2. C runs the helper on its end: token.pid===child.pid, ppid===C, euid, exeMatch, no TTY, and `child.exitCode===null &&
   signalCode===null` checked AFTER the query (C is the reaping parent, so the pid was not reused at query time).
3. Only then C sends the child its private launch/request frame (§3/§6) carrying paths/expectations, never credentials.
4. Only after receiving it does the child read its secret file and open a DB connection. Unsolicited/early/duplicate
   frames, a missing HELLO within 1 s, or HELLO after another frame → child/C abort, no secret read.
S additionally serves HTTP only after verified seq2 (§3); E performs owner effects only after its verified request (§6).

## 3. Physical binding of every DB connection (reader, S runtime, E owner)

Shared `packages/reval/physical.ts` `verifyPhysicalEndpoint(expectation, connect)`, BEFORE any effecting query and
BEFORE S listens:
1. `lstat(socketDir)` directory, not a symlink, no attacker-writable ancestor;
2. `lstat(<socketDir>/.s.PGSQL.<port>)` socket with `dev/ino` = `socketDevice/socketInode`;
3. read `<dataDirectory>/postmaster.pid`: pid/datadir/start/port/socketdir lines equal `postmasterPid`, `dataDirectory`,
   `postmasterStartTime` (epoch), `port`, `socketDir`; pid live;
4. connect ONLY via unix socket: pg config `{host: socketDir, port, database, user: role, password,
   application_name}` with a fixed per-process name (`atlas-reval-c-reader`, `atlas-reval-s-runtime`,
   `atlas-reval-e-owner`; Unix-socket backends cannot be mapped to a client pid otherwise);
5. one fixed query `SELECT (pg_catalog.pg_control_system()).system_identifier::text, (SELECT oid FROM pg_catalog.pg_database
   WHERE datname = pg_catalog.current_database())::text, pg_catalog.pg_postmaster_start_time(), pg_catalog.current_database(),
   session_user, pg_catalog.inet_server_addr() IS NULL, pg_catalog.pg_backend_pid()`: equals the expectation (start time
   also cross-checked against postmaster.pid start), `inet_server_addr() IS NULL`, session_user = expected role;
6. repeat 1–3 after connect. Any failure → `REGISTRATION_MISMATCH`; connection destroyed before any further statement.
Copied UUIDs prove nothing; the physical tuple is the binding; `registrationId/databaseInstanceId` are checked against
DB rows by the reader (snapshot wrapper) and E (owner row read).

**S launch.** C spawns S non-detached, argv `[node, <apiEntry>]` (no execArgv), stdio `['ignore','ignore','ignore','pipe']`,
env EXACTLY `ATLAS_MODE=db`, `ATLAS_API_PORT`, `ATLAS_REVAL_BRIDGE_FD=3` (no URL, no secret, no NODE_OPTIONS/PATH/proxy).
After §2e, C sends `RevalServerLaunchV1 {registrationId, databaseInstanceId, serverBootId, connectionId,
launchChallenge, endpoint:{socketDir,port,database}, runtimeRole, runtimeSecretFile, physical:{...§2b tuple}}`.
Bridge-mode S: (a) refuses unless ATLAS_MODE=db, Ask OFF, ATLAS_OPERATOR_UI unset, ATLAS_RUNTIME_DATABASE_URL ABSENT, fd
3 is a socket, launch frame strict-valid within 2 s; (b) reads its password (closed format) and runs
`verifyPhysicalEndpoint` for `runtimeRole`; (c) composes the unix-socket runtime URL in memory (`?host=<socketDir>`) and
passes it to the existing `connectRuntimeDatabase(url)` argument (never writes env); readiness runs as today; (d) replies
`RevalServerBoundV1 {launchChallenge, serverBootId, observed:{systemIdentifier,databaseOid,postmasterStartTime,
backendPid,sessionUser,unixSocket:true}}` from its own query. C then (i) compares `observed` with its reader-observed
tuple; (ii) confirms on its reader connection that `pg_stat_activity` has `pid=backendPid`, `usename=runtimeRole`,
`application_name='atlas-reval-s-runtime'`,
`datname=current_database()` — if PG17 hides that row without extra grants, recorded unavailable (no grant weakening);
(iii) public 06 C→S IDENTITY seq1, then seq2. S calls `app.listen` only after answering verified seq2. Any mismatch → C
kills S before listen. Residual: later runtime pool connections reuse the fixed unix endpoint; a socket swap between
checks is detected only at the next IDENTITY physical recheck.

**E.** Request frame (§6) carries the same endpoint/physical expectation, owner role and owner secret path. E runs
`verifyPhysicalEndpoint`, then within its transaction clears `app.*` and sets `app.workspace_id` to the expected workspace
BEFORE the FORCE-RLS registration read, which must match `registrationId`, `databaseInstanceId`, `workspaceId`,
`clientId`, `actorId`, `admissionId` exactly — all before any lock. Mismatch → REFUSED `REGISTRATION_MISMATCH`, no call.

**Tests-only DI and fixtures.** `tests/support/reval-test-deps.ts` (Docker TCP connector + physical probe, ref
`rsa-test-tcp-unverified-v1`) and test entries `tests/support/reval-test-{owner,controller,server,exec}-entry.ts` import
`packages/reval/*`/bridge library with those deps; the O test entry runs under a real PTY via `/usr/bin/script`.
Production `scripts/reval-server/*`, `apps/api/src/main.ts` and the config schema have no flag/env/field selecting TCP or
relaxing TTY/peer checks; a static test enforces it. The physical comparator is always tested with a real AF_UNIX socket
and synthetic `postmaster.pid`/data dir (no PG needed). Docker results are regression evidence only, never MEASURED.
**Native Unix fixture (production chain).** With `ATLAS_REVAL_NATIVE_PG_FIXTURE` set to a root descriptor (read only by
`tests/support`), the native test drives the UNMODIFIED production chain with NO `tests/support` DI in any spawned process:
production `scripts/reval-server/owner.ts` under a real PTY via `/usr/bin/script` → production controller with
`productionDeps()` → built `dist/apps/api/src/main.js` in bridge mode → production `owner-exec.ts` → the built helper
pinned by sha256 — using a real 0600 owner config in a 0700 realpath directory with the recorded physical tuple and
test-provisioned roles/registration/binding/policy in a temporary database of that cluster. Required coverage and the
no-skip evidence rule are in ACCEPTANCE_CHECKS.md. Its result is test-fixture evidence: platform ref
`rsa-peertoken-unixphys-v1` with `loadedBinding:'UNVERIFIED'`, never MEASURED, never platform/image proof.

## 4. RC2_MINOR — reread wording (02 PAUSE_EXPORT)

After E reports `CONFIRMED_COMMIT`, C performs ONE atomic reread via `atlas_reval_snapshot()` and emits a closure only if
it shows ALL of: the same admissionId; PAUSED; policyVersion EXACTLY E's committed post-call version; fenceEpoch EXACTLY
E's committed post-call fence; both strictly above request floors. Any intervening revision, state change or fence
advance by any mechanism (revise, client_set, Stage 3 fence) refuses with `CONTAINMENT_UNCONFIRMED` + latch even if
still PAUSED. Any reread failure after a confirmed commit (any RV code, byte cap, timeout/budget exhaustion, physical or
build mismatch) → `CONTAINMENT_UNCONFIRMED` + latch, no closure. The closure certifies only policy/fence: the reread's
`consistent` flag and the pricing comparator are NOT closure gates and are not inserted into the closure (residual:
census limits/missing binding block confirmation). SNAPSHOT remains a factual read, never a closure.

## 5. Migration (new only) `prisma/migrations/202610131000_stage5_reval_registration/migration.sql`

- `RevalSandboxRegistration`: `registrationId` UUID PK; `databaseInstanceId` UUID UNIQUE; `workspaceId/clientId/actorId`
  (ScopeId CHECK); `admissionId` UUID; `evidenceReaderRoleOid` BIGINT UNIQUE >0; `datasetManifestSha256`,
  `buildManifestSha256` hex64; `syntheticOnly` CHECK true; `createdAt`. UNIQUE(`workspaceId`); UNIQUE(registrationId,
  ws, client, dataset). FKs RESTRICT: (ws,client)→Client; (ws,actor)→Actor; (ws,admission)→RemoteAskPolicy;
  (ws,admission,client)→RemoteAskClientAdmission.
- `RevalFixtureBinding`: `registrationId` PK; `workspaceId`, `clientId`; `fixtureId` CHECK `^FX(0[1-9]|1[01])$`;
  `generation` BIGINT >0; `syntheticFreshnessAt`; `datasetManifestSha256`; `installedAt`; composite FK (registrationId,
  ws, client, dataset) → registration.
- Guard `public.atlas_reval_guard()` (plain invoker trigger function, `SET search_path = pg_catalog, pg_temp`, every
  relation/function schema-qualified, ENABLE ALWAYS so it also fires under `session_replication_role=replica`, RV010):
  (a) WRITER IDENTITY: INSERT/UPDATE refused unless `current_user` is the owner of `public.atlas_reval_guard()` AND of the
  target table (`pg_class.relowner`, i.e. the migration/table owner) — so runtime DML through inherited/default grants
  between this migration and the roles.sql rerun is refused; (b) registration UPDATE/DELETE/TRUNCATE always refused,
  even for the owner; (c) binding: INSERT/UPDATE force `installedAt := date_trunc('milliseconds', clock_timestamp())`,
  UPDATE requires strictly increasing generation and unchanged registrationId/ws/client/dataset, DELETE/TRUNCATE refused.
- ENABLE + FORCE RLS; one PUBLIC policy `FOR ALL USING/WITH CHECK ("workspaceId" = public.atlas_app_workspace())`;
  `REVOKE ALL FROM PUBLIC` on both tables and both new functions.
- `public.atlas_reval_snapshot()`: no args, SECURITY DEFINER, VOLATILE, `SET search_path = pg_catalog, pg_temp`, every
  relation/function schema-qualified (a `pg_temp` shadow cannot redirect), returns jsonb, no writes, AccessShare only (§7).
- Prisma: the two models in a NEW `prisma/reval.prisma`. Only the virtual INVERSE relation list fields that the declared
  FKs actually require are added: `RemoteAskPolicy`, `RemoteAskClientAdmission` (`prisma/askremote.prisma`) and
  `Client`, `Actor` (their existing declaring file, `prisma/schema.prisma`); none on `Workspace` (no FK references it);
  no column/constraint/index/@@map/default/financial change; proven by
  `schema:validate`, `db:check:drift`, populated upgrade; both accepted-file deltas resealed in the RS-A manifest. No
  population; tests insert synthetic rows as table owner.

## 6. PAUSE_EXPORT executor: budget, phases, lifetime, confirmed commit

O→C `PAUSE_EXPORT {admissionId,expectedPolicyVersion,policyFloor,fenceFloor}`. C checks admission = registration's (else
`REGISTRATION_MISMATCH`) and the session latch (set → `CONTAINMENT_UNCONFIRMED`, no spawn).

**One C-side budget** (monotonic, from request receipt) `B = 1800 ms`, strictly under O's 2 s requester deadline (200 ms
wire/processing margin); every timeout is derived from the absolute deadline `D = t0 + B`, never a fresh 2 s:
spawn + HELLO + peer proof + request send must complete by `D − 1200`; E's absolute transaction deadline `DE = D − 400`
(E: connect timeout `min(300, DE − now)`, `SET LOCAL lock_timeout`/`statement_timeout`/
`idle_in_transaction_session_timeout` = `max(1, min(1400, DE − now − 50))` each, all monotonic); result frame by `DE`; reread from receipt to `D −
50` (statement_timeout = remaining − 50). C answers by `D`. Cleanup is bounded separately and runs after the response:
SIGKILL a live E, reap ≤1000 ms; the owner backend ends by its server-side timeouts ≤ `DE`; no E/owner session survives
`D + 1500 ms`. C spawns E EXACTLY ONCE: argv `[node, <owner-exec entry>]`, no execArgv, stdio `['ignore','ignore',
'ignore','pipe']`, env EMPTY. Handshake per §2e. Private frames (closed, never persisted/exported):
```
RevalOwnerExecRequestV1 {helloNonce, challenge, remainingMs, registrationId, databaseInstanceId, workspaceId,
  clientId, actorId, admissionId, expectedPolicyVersion, endpoint, ownerRole, physical, ownerSecretFile}
RevalOwnerExecResultV1 {challenge, outcome:'CONFIRMED_COMMIT'|'REFUSED'|'COMMIT_UNKNOWN',
  revisionApplied:boolean|null, policyVersion|null, fenceEpoch|null, code|null}
```
(`remainingMs` = `DE − now` on C's monotonic clock at send, integer 1..1400; E starts its own monotonic timer at
receipt with `remainingMs − 50`, never extending C's absolute deadline; wall-clock steps are irrelevant. C's hard
deadline, kill and parent-loss handling remain authoritative.)
**E lifetime.** Hard timer at its deadline; on fd 3 `end/close/error` (parent EOF/death) or deadline E destroys the pg
socket immediately (before COMMIT this aborts the transaction server-side; after COMMIT is sent nothing is claimed) and
`process.exit(fixed)`. `finally` always destroys the client. The owner password is read into a Buffer used for one
connect, then the Buffer is zero-filled; the JS string handed to the pg client cannot be erased and persists until GC/
process exit (residual; E is short-lived).
**Transaction (READ COMMITTED):** (1) `verifyPhysicalEndpoint`; (2) clear/set `app.*`, then exact registration read
(§3); (3) fence `FOR UPDATE` FIRST, then policy `FOR UPDATE`; admission check; expected version = current, else REFUSED;
(4) REVOKED/TOMBSTONE → ROLLBACK, REFUSED, no call;
(5) with the row locked, one fixed SQL statement returns only fingerprints and scalars of the PRE-CALL row:
`state`, `policyVersion`, fence `version`, `fullPre = sha256(convert_to(to_jsonb(p)::text, 'UTF8'))` and `restPre =
sha256(convert_to((to_jsonb(p) - ARRAY['policyVersion','state','stateReason','revisedAt'])::text, 'UTF8'))` (pre and
post computed in the same session/TimeZone; jsonb text is canonical with microseconds; no policy value, secretRef
or timestamp enters JS); then ALWAYS call the accepted routine in ONE SQL statement that passes every preserved argument
directly from the locked row, e.g. `SELECT public.atlas_ask_remote_policy_revise(p."workspaceId", p."admissionId",
p."policyVersion", 'PAUSED', p."secretRef", p."ownerApprovalRef", p."retentionAttestationRef", p."priceRevision",
p."promptSha256", p."schemaSha256", p."packageSha256", p."dayCapMicroUsd", p."monthCapMicroUsd", p."expiresAt") FROM
public."RemoteAskPolicy" p WHERE p."workspaceId" = $1 AND p."admissionId" = $2 AND p."policyVersion" = $3` — no policy
value round-trips through JS (`timestamptz(6)` microseconds preserved). The statement must return EXACTLY one row whose
value is `expected` (pre-state PAUSED, no-op) or `expected+1` (pre-state ACTIVE/INACTIVE, applied); zero rows, more rows
or any other value → ROLLBACK, REFUSED `POLICY_CHANGED` (never treated as a no-op). For an already-PAUSED row the accepted routine
returns the unchanged version without fence/version change (accepted no-op; a runtime `stateReason` such as
MODEL_MISMATCH stays unchanged);
(6) post-call read computes the same `fullPost`/`restPost` fingerprints plus state/stateReason/version/fence in SQL and
is bound to the PRE-CALL state:
- pre-state PAUSED → MUST be the no-op: `fullPost = fullPre`, same version, fence unchanged (`revisionApplied:false`);
  anything else → ROLLBACK, REFUSED `CONTAINMENT_UNCONFIRMED`;
- pre-state ACTIVE/INACTIVE → MUST be applied: `restPost = restPre` (only `policyVersion`, `state`, `stateReason`,
  `revisedAt` may differ), version = expected+1, state PAUSED, stateReason OWNER, fence = old+1
  (`revisionApplied:true`); anything else (incl. a no-op or version exhaustion → TOMBSTONE) → ROLLBACK, REFUSED;
(7) COMMIT; acknowledged → `CONFIRMED_COMMIT` (post-call tuple); error/loss after COMMIT sent →
`COMMIT_UNKNOWN`. REFUSED only for ROLLBACK issued BEFORE COMMIT was sent. **A closure is NEVER emitted after ROLLBACK.**

**Closed phase/outcome map (C).**
| Phase / condition | C result | Latch |
|---|---|---|
| Before request frame sent: spawn/HELLO/peer failure, budget | `IDENTITY_UNVERIFIED` (peer) / `DEADLINE` | no |
| Valid REFUSED: physical/registration mismatch, AR004 | `REGISTRATION_MISMATCH` | no |
| Valid REFUSED: expected version ≠ current, AR009 | `POLICY_CHANGED` | no |
| Valid REFUSED: REVOKED/TOMBSTONE, AR008, 22003 fence overflow, pre-state/whole-row postcondition violation | `CONTAINMENT_UNCONFIRMED` | no |
| Valid REFUSED: 28P01/28000 auth failure, 42501 not owner | `OWNER_REQUIRED` | no |
| Valid REFUSED: 55P03/57014 before COMMIT | `DEADLINE` | no |
| Valid REFUSED: secret file invalid | `UNAUTHORIZED` | no |
| Valid REFUSED: any other pre-COMMIT error | `INTERNAL_FAILURE` | no |
| After request sent: malformed/unauthenticated result, wrong challenge, no result by `DE`, EOF, exit, kill, `COMMIT_UNKNOWN` | `CONTAINMENT_UNCONFIRMED` (commit may have happened) | YES |
| `CONFIRMED_COMMIT`, reread ok, exact equality, strictly above floors | `CLOSURE` (four keys) | no |
| `CONFIRMED_COMMIT`, any reread failure/drift/floor not exceeded (incl. stale already-PAUSED) | `CONTAINMENT_UNCONFIRMED` | YES |
Killing E is NEVER treated as rollback proof. No retry ever; latched sessions refuse later PAUSE_EXPORT without spawning.

## 7. Snapshot routine and reader (02; bounds per 01)

Routine (all names schema-qualified; no argument, so no caller hint can scope it):
1. Require `transaction_isolation='repeatable read'`, `transaction_read_only='on'`, `current_setting('role')='none'`;
   else RV002.
2. FIRST clear `app.workspace_id`, `app.client_ids`, `app.actor_id`, `app.token_hash`, `app.poweroffice_connection_id`
   (caller-set values cannot widen visibility through OR-ed permissive policies).
3. Selection: EXPLICIT predicate `r."evidenceReaderRoleOid" = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname =
   session_user)`, exactly 1 row (else RV001); set `app.workspace_id` from it; re-select by registrationId AND the same
   predicate, require equality. The role-specific policy is defense in depth, never the selector.
4. Policy by (ws, admissionId) and the registered client's `RemoteAskClientAdmission` row must exist; else RV001.
5. Pricing, returned INTERNALLY only: policy tuple `(profile, priceRevision, reserveMicroUsd)` (policy has no rate
   columns; rates 275/825 are pinned by the accepted RemoteAskAttempt CHECK and compared as constants); attempt tuples
   DISTINCT `(profile, priceRevision, reservedMicroUsd, promptRate, completionRate)` over ALL project attempts; >8
   distinct → RV004.
6. Binding missing → RV005.
7. Bounds BEFORE output: all project attempts ≤1000; all project counter rows (referenced, current AND orphan rows that
   no attempt references) plus synthesized current periods ≤2000; else RV003.
8. Integrity: a missing counter for any attempt-referenced period → RV006 (refusal; never zero-filled, no partial
   census). A missing CURRENT period with no attempts → synthesized `"0"`/`"0"`. EVERY project counter row, including
   orphans, participates in counter = SUM(accounted of its period's attempts) (orphans must be 0); any mismatch →
   `consistent:false` with the complete census. Exported `chargedMicroUsd` is always the counter row's actual value.
9. Output: `dbObservedAt` = `to_char(date_trunc('milliseconds', clock_timestamp()) AT TIME ZONE 'UTC', ...)` (truncate,
   never round; same for every exported time); periods referenced+current with charged/attemptCount over ALL project
   attempts; attempts[] registered client+actor only, ordered (createdAt, id); foreignScopeAttemptCount (no IDs);
   bigints as text.
10. Return internal wrapper `{registrationId,databaseInstanceId,buildManifestSha256,systemIdentifier,databaseOid,
    postmasterStartTime,pricing:{policy,attempts[]},snapshot:{exact 02 keys except snapshotId}}`. C sets `snapshotId`
    (random v4) and exports ONLY the exact 02 payload; rates, priceRevision, secretRef, projectIdentity,
    approval/retention refs and tokens never exported.

**Approved expectation (A8).** Sources: accepted `ASK_REMOTE_PROFILE` (`packages/ask/remote/budget.ts`); reserve 300000
(accepted policy and attempt CHECKs) and rates 275/825 (accepted attempt CHECK; parity test pins literals against the
accepted migration text); owner config's
required immutable `approvedPriceRevision` (owner-local, read once, used ONLY to refuse, never exported/written/authorizing).
C requires `pricing.policy == (ASK_REMOTE_PROFILE, approvedPriceRevision, 300000)` and `pricing.attempts` empty or exactly
`[(ASK_REMOTE_PROFILE, approvedPriceRevision, 300000, 275, 825)]`; else `POLICY_CHANGED`, nothing exported.

**Reader.** Same 1800 ms C budget per SNAPSHOT (strictly under O's 2 s): fixed SQL `BEGIN ISOLATION LEVEL REPEATABLE READ
READ ONLY; SET LOCAL statement_timeout=<remaining−100 ms>; SET LOCAL lock_timeout=<min(1000, remaining−200) ms>; SELECT
public.atlas_reval_snapshot(); COMMIT` plus the fixed physical query only. Map: RV001→`REGISTRATION_MISMATCH`;
RV002/RV006/57014/55P03/connection loss/budget→`CENSUS_UNAVAILABLE`; RV003→`CENSUS_LIMIT_EXCEEDED`; RV004→`POLICY_CHANGED`;
RV005→`FIXTURE_MISMATCH`; else `INTERNAL_FAILURE`. Wrapper registration/instance/physical/build ≠ config/C digest →
`REGISTRATION_MISMATCH`. Envelope >256 KiB → `CENSUS_LIMIT_EXCEEDED`. Never a truncated success.

**C validation (checked BigInt).** Canonical Dec64/UUIDv4/Time(ms); reserve 300000; caps within bounds; policyVersion ≥1;
periods MONTH then DAY by date, unique, MONTH day 01, current and every referenced present; per attempt: admission =
snapshot's, policyVersion ≤ current, dayStart = UTC(createdAt), monthStart = month(dayStart), state/outcome/accounted/
settledAt per accepted CHECK (EGRESS_COMMITTED; SETTLED USAGE_VERIFIED ≤ reserve or NO_DISPATCH = 0; UNKNOWN 4 outcomes,
accounted = reserve). If `consistent:true`: projectAttemptCount = attempts.length + foreign; ΣDAY.attemptCount =
ΣMONTH.attemptCount = projectAttemptCount; per month ΣDAY.charged = MONTH.charged; registered accounted ≤ period charged
(equal when foreign = 0); violation → `CENSUS_UNAVAILABLE`. `consistent:false` exported schema-validated only.

## 8. Roles, readiness, EXECUTE confinement

`prisma/roles/reval.sql`: second `DO` block in the SAME psql transaction; `prisma/roles.sql` gains only `\ir
roles/reval.sql` before `COMMIT` plus ≤10 doc lines (650→≤662; under 700; 500 target pre-existing residual); accepted
main block unchanged. Status `SELECT` sets `atlas.reval_definer_role`='atlas_reval_evidence_definer',
`atlas.reval_reader_role`='atlas_reval_reader', `:'atlas_reval_reader_password'` (booleans printed only; RUNBOOK notes
the psql `-v` argv visibility during provisioning, as for accepted roles).

- Distinct from each other and the eight existing principals (runtime, definer, runner, fence, poDefiner, poRunner,
  remote, owner); no membership/alias/ownership/grantee path either way. Create or validate: NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT, `rolconfig` NULL, no `pg_parameter_acl`, no membership except the
  PG16+ owner ADMIN link. Definer NOLOGIN; reader LOGIN with its own password.
- Definer exact grants: USAGE on public; column SELECT only on RemoteAskPolicy(workspaceId, admissionId, projectIdentity,
  policyVersion, state, profile, priceRevision, reserveMicroUsd, dayCapMicroUsd, monthCapMicroUsd, expiresAt);
  RemoteAskClientAdmission(workspaceId, admissionId, clientId, state) (used by §7 step 4); RemoteAskPeriodCounter(
  workspaceId, projectIdentity, kind, periodStart, chargedMicroUsd); RemoteAskAttempt(workspaceId, id, clientId, actorId,
  admissionId, projectIdentity, policyVersion, profile, priceRevision, promptRate, completionRate, correlationId,
  dayStart, monthStart, reservedMicroUsd, accountedMicroUsd, state, outcome, createdAt, settledAt);
  ActionAuthorityFence(workspaceId, version); all columns of both Reval tables. Role-specific SELECT policy on
  registration (defense in depth).
- Reader: USAGE on public; explicit EXECUTE on `public.atlas_reval_snapshot()` only, no grant option. Snapshot owned by
  the definer (reset ACL); guard owned by the table owner, owner-only. Runtime: NO Reval privilege, no snapshot EXECUTE.
- EXECUTE confinement, evaluated for BOTH new roles over every user routine (OID ≥16384, any schema): (a) single new
  explicit export capability = reader EXECUTE on `public.atlas_reval_snapshot()` (SECURITY DEFINER, owner = definer; the
  definer's sole owned routine); (b) accepted PUBLIC helper exception = exact schema-qualified identity
  `quote_ident(schema).quote_ident(name)(identity args)` in existing `FENCE_SHARED_INVOKER_ROUTINES`
  (`packages/graph/fence-role.ts`, mirrored by `v_fence_shared`), `prosecdef = false`, reachable only via PUBLIC, no
  explicit grant/grant option to the new roles; (c) every other executable user routine fails closed (new PUBLIC
  function, same-name function in another schema, SECURITY DEFINER substitution, explicit grant, the guard, any
  `atlas_ask_remote_*`). Ancestor PUBLIC ACLs preserved; no REVOKE on existing helpers. `reval.sql` holds the list as
  `v_reval_shared`; parity test requires byte-equality with the TS constant and `v_fence_shared`.
- Postconditions (fail closed), retaining RC4's COMPLETE effective capability checks for both new roles (any schema,
  temporary objects included): no schema/database CREATE or TEMP beyond PUBLIC defaults already accepted for existing
  roles, no object/schema ownership except the definer's snapshot, no grant option anywhere, no explicit schema grant
  except USAGE on public, no nonstandard built-in escalation (pg_* predefined role membership, parameter ACLs); definer
  relation surface = exact allowlist; reader no table/sequence privilege;
  `atlas_reval_%` exactly 2 with exact owners/ACLs; `atlas_ask_remote_%` exactly 9 under the remote definer; no PUBLIC
  EXECUTE on new routines; existing definers' surfaces unchanged; guard trigger present, ENABLE ALWAYS.
- TS readiness `packages/graph/reval-role.ts` (≤450 lines) mirrors every rule for BOTH roles plus FORCE RLS, policies,
  FKs, ALWAYS triggers and runtime negatives; `runtime-role.ts` imports it and adds both tables to `PROTECTED_TABLES`
  (≤20 lines). Drift refuses runtime startup in every Ask mode.

## 9. Strict local protocol (06): implemented vs fail-closed

- Framing: u32 big-endian length; strict UTF-8; existing `parseStrictJson` (import only; duplicate keys at any depth
  rejected); `isWellFormed` strings; no JSON numbers where Dec64 required; declared >256 KiB → `FRAME_TOO_LARGE` + close;
  trailing/short frame → close. Private frames use the same framing, ≤4 KiB, separate decoders; cross-acceptance refused.
- Envelopes: exact `RevalOwnerCommandV1`/`RevalOwnerEvidenceV1`; per-direction sequences start at 1, exactly next;
  response echoes challenge and requestSequence; one outstanding (`OPERATION_BUSY`); requester deadline 2 s, C budget
  1800 ms; late response ignored + close. Registration → `REGISTRATION_MISMATCH`; boot/connection → `WRONG_BINDING`;
  sequence → `SEQUENCE_INVALID`; challenge → `CHALLENGE_INVALID`. A frame that parses and whose challenge/sequence are
  extractable but fails schema → `PROTOCOL_INVALID` response; otherwise close. Closing O↔C ends the session.
- Direction codes (exact): sender I with an O-only op (PAIR, FIXTURE_CHECK, PAUSE_EXPORT) → `OWNER_REQUIRED`; any
  other (sender, op) pair absent from the 06 table (incl. S→C requests, O/I sending C-only OBSERVATION_COLLECTED,
  responses sent as requests) → `WRONG_DIRECTION`; checked before ANY side effect. No live I principal in RS-A (pure
  authorizer unit-tested with I).
- Implemented: O→C IDENTITY, SNAPSHOT, PAUSE_EXPORT; C→S IDENTITY; FAILURE `{code}` with the exact 43-code enum.
- Fail-closed (no side effect, no forwarding): PROCESS_CENSUS, TERMINAL_OBSERVATION, DRAIN, OBSERVATION_COLLECTED →
  `OBSERVATION_UNAVAILABLE`; PLATFORM_PROOF → `PLATFORM_UNVERIFIED`; PRIVACY_PROOF → `PRIVACY_UNVERIFIED`; FIXTURE_CHECK →
  `FIXTURE_MISMATCH`; PAIR, END_PAIR → `PAIR_UNAVAILABLE`; ARM_CASE → `ARM_UNAVAILABLE`. S answers any non-IDENTITY C→S op
  the same way.
- O grammar: `identity`, `snapshot`, `pause-export <uuid> <dec64> <dec64> <dec64>`, fail-closed op names, `quit`; prints
  only validated safe payload JSON or a locally mapped exit code (§2).

## 10. Allowed paths

**New:** `packages/reval/{scalars,codes,frame,envelope,private-frames,payloads,closure,snapshot-reader,owner-exec,
secret-file,physical,peer,launch,controller,owner-cli}.ts` (each ≤500 lines); `apps/api/src/reval/bridge.ts`;
`scripts/reval-server/{owner,controller,owner-exec,build-peer}.ts`; `native/reval-peer/peer.c`; routing docs
`packages/reval/AGENTS.md`, `scripts/reval-server/AGENTS.md`, `native/reval-peer/AGENTS.md` (task-focused, ≤40 lines each,
pointing to the approved brief); the §5 migration; `prisma/reval.prisma`; `prisma/roles/reval.sql`;
`packages/graph/reval-role.ts`; tests per the checks file; `tests/support/reval-test-{deps,owner-entry,controller-entry,
server-entry,exec-entry}.ts`; `tests/support/roles-s5remote.sql` (byte-exact current roles.sql, pinned `7a9419b3…3f69`).
**Bounded modifications:** `prisma/roles.sql` (include + docs); `prisma/schema.prisma`, `prisma/askremote.prisma`
(virtual inverse relation fields ONLY); `packages/graph/runtime-role.ts` (≤20 lines); `apps/api/src/main.ts` (≤10-line
bridge hook; without `ATLAS_REVAL_BRIDGE_FD` behavior unchanged; in bridge mode the URL argument comes from
`bridge.ts`); `tests/support/roles-sql.ts` (exact `\ir roles/reval.sql` inlining once, 2 role settings, optional 4th
password, reval roles in `uniqueRoleNames`/`dropRolesSql`; historical renders unchanged); `tests/support/pg-harness.ts`
(new role fields); `scripts/pg17-check.ts` and existing parity/invariant tests only where needed; `docs/RUNBOOK.md`.
**Root-owned (implementer does NOT edit):** approved brief + checks and RS-A `AGENTS.md` at
`docs/stage5/ask/remote/reval-server/rs-a/`; DESIGN_STATUS, root `AGENTS.md`, AI_CONTEXT_MAP, status/evidence/history.
**Forbidden:** accepted migrations; R-A/B/C financial routines and dispatch; `packages/ask/**`; `apps/operator/**`;
browser; connectors; RC5 files; RC4 normative docs; historical verification; new dependencies.

## 11. Stage plan (one cohesive session; stop at RS-A)

1. Re-verify baseline; receive ownership. 2. Migration, Prisma, reval.sql, guard, readiness → roles/guard/upgrade tests.
3. Physical comparator + snapshot routine/reader/validation → snapshot tests. 4. Executor phases/budget/closure/latch →
closure/lifetime tests. 5. Frames, handshake, O/C/S launch, helper, bridge, PTY test entries → unit/launch tests.
6. Full suite, evidence, report; STOP for independent Sol6.1/xhigh + Opus5.5/xhigh code review; repairs in this session.

## 12. Decisions, pending, residuals

Decisions: A1 inherited O→C socketpair, O-assigned serverBootId bound by peer proof (the
0700 named socket stays mandatory for I in RS-C; C-lifetime-tied-to-O is not a precedent); A2 private closed frames and
wrapper internal, exported 01/02/06 unchanged; A3 production `register`/binding population → RS-B; A4 no runtime Reval
privileges; A5 S Ask OFF; A6 bridge-only closed password-file input, endpoint from config/launch frame; A7 per-session
latch; A8 `approvedPriceRevision` owner-local refusal-only expectation (becomes an architecture question if ever exported,
written to DB or used to permit/resume); A9 unsupported platform refusal, TCP test-only; A10 no attach/absent-server
positive IDENTITY.
Pending (not claimed): complete loaded-image/immutability proof (RS-D); native Unix fixture results are test-fixture
evidence only (never MEASURED/platform proof); `pg_stat_activity` cross-check
visibility; helper TOCTOU; same-UID/root/kernel trust limit; darwin x86_64 refused; S logs dropped (RS-D policy).
Residuals: A3 (production RS-A refuses until RS-B); socket swap between fstat and connect and between IDENTITY
rechecks; closure confirmation inherits snapshot limits/binding failures; RS-C must keep S's runtime binding before
any Ask path; timing on Docker is regression only; the reader password string resident in C, and the runtime (S) and owner (E) password strings, persist in JS
memory until GC/exit;
`prisma/roles.sql` ~660 lines.
