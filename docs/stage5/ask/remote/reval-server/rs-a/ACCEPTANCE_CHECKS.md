# RS-A acceptance checks — BRIEF rc4 (`ACCEPTANCE_CHECKS.md`, companion to `IMPLEMENTATION_BRIEF.md`; frozen together)

Meaningful, offline, synthetic only. PG tests use temporary DBs/roles (Docker PG17.11, dropped after). Docker/TCP results
come only from the test DI seam (`rsa-test-tcp-unverified-v1`) and are regression evidence, never MEASURED. § refers to
`IMPLEMENTATION_BRIEF.md`. Every listed check is required. All test-created config/temp/socket directories are created
from realpaths (macOS `/tmp` and `/var` are symlinks; the owner-config no-symlink rule must not be bypassed).

## Unit / PGlite (`tests/reval-*.test.ts`)

- Framing: oversize declared length rejected before buffering; partial frames; trailing bytes; invalid UTF-8; lone
  surrogate escapes; private frames ≤4 KiB; private/06 decoders reject each other's frames.
- Strict schema for EVERY contractVersion (06 envelopes, `RevalChildHelloV1`, `RevalServerLaunchV1/BoundV1`,
  `RevalOwnerExec*`, `RevalOwnerConfigV1`): duplicate keys at any depth, unknown/missing keys, JSON number where Dec64
  required, exponent, leading zeros, `+`, 2^63, non-v4/uppercase UUID.
- Sequencing: start/gap/replay/wrap; challenge mismatch/reuse; `OPERATION_BUSY`; C budget 1800 ms answers before O's 2 s;
  late response ignored + close; outstanding lost on close; schema-invalid-but-addressable → `PROTOCOL_INVALID`,
  unaddressable → close.
- Direction table: every operation × sender (O/I/C/S) via the pure authorizer; I with PAIR/FIXTURE_CHECK/
  PAUSE_EXPORT → `OWNER_REQUIRED`; all other absent pairs → `WRONG_DIRECTION`; side-effect spies prove no DB/spawn on
  refusal; every fail-closed op returns its exact code.
- Payloads: exact IDENTITY/SNAPSHOT/FAILURE; §7 Dec64 relationships; `consistent:false` schema-only; times truncated to
  ms (23:59:59.9995 stays on the same UTC day).
- Closure: exactly four keys; `paused:"true"`, extra and missing keys rejected; floors equal/stale/above at BigInt
  boundaries; `revisionApplied:false` above vs ≤ floors.
- Phase/outcome map (§6): every row of the table, using a fake E: each REFUSED code mapping (AR004, AR008, AR009, 22003,
  42501, 28P01, 55P03, 57014, postcondition, invalid secret, other) without latch; malformed result, wrong challenge,
  missing result, EOF, exit, `COMMIT_UNKNOWN` → `CONTAINMENT_UNCONFIRMED` + latch; latched session never spawns again;
  `CONFIRMED_COMMIT` + reread failure (each RV code, byte cap, timeout, physical/build mismatch) → latch, no closure;
  `consistent:false` and pricing comparator are not closure gates.
- Budget: sub-deadlines derived from `D`; no timeout exceeds the remaining budget; no fresh 2 s anywhere;
  `remainingMs` clamped to 1..1400, E timer relative and monotonic; a simulated wall-clock jump does not extend E or
  leave an owner backend past `D + 1500 ms`.
- Pricing comparator: policy tuple or any attempt tuple ≠ approved → `POLICY_CHANGED`; mixed tuples; no attempts passes;
  rates/priceRevision absent from every exported payload.
- Owner config: rejects host/TCP field, missing `approvedPriceRevision` or `nativePeerHelperSha256`, relative paths,
  unknown `server.mode`. Secret files: symlink, 0644, foreign owner, FIFO, oversize, missing, and any content outside
  `^[A-Za-z0-9._~-]{16,256}\n?$` (URL, `host=`, `:`, `/`, `@`, whitespace) rejected.
- Credential absence (R9b): with DI fs spies C never opens `secretFiles.runtime/owner`; captured C↔O, C↔S, C↔E frames,
  and C/S/E argv/env (from the launch builders and live `ps -o args=`/`ps eww` where readable) contain no secret sentinel.
- Peer helper: parser requires exactly 8 keys; darwin builds the helper in tmp and checks real socketpair children
  (pid/pidversion); grandchild/unrelated process rejected; helper killed after 500 ms hang; token before child write names
  the creator, so proof before HELLO is rejected; synthetic same pid + different pidversion → `IDENTITY_UNVERIFIED` and
  S kill path invoked (R9c).
- Platform/helper gate: injected non-darwin, missing helper or sha ≠ config pin → C exits with the fixed code BEFORE DB
  connect / S / E spawn spies fire; O displays the locally mapped code; no response frame carries a `databaseInstanceId`.
- Handshake order (§2e): child that receives any frame before its HELLO, or no HELLO in 1 s, aborts; the secret-read and
  DB-connect spies are not called before the verified launch/request frame.
- Physical comparator (R9a; no PG needed): real temporary AF_UNIX listening socket + synthetic data dir/`postmaster.pid`;
  each fact mismatched alone (same system_identifier with different socket dev/inode, data directory, postmaster pid,
  start, port, socketdir, database OID, `pg_postmaster_start_time`), socket replaced after recording, symlinked socket dir,
  missing/partial pid file, `inet_server_addr()` non-null, wrong session_user → `REGISTRATION_MISMATCH`, connection
  destroyed, no further statement.
- Build binding: C digest ≠ registration `buildManifestSha256` → refusal before launch and before export.
- Static checks: no production module imports `tests/support/reval-test-*`; production entries/config schema/env readers
  contain no TCP, TTY or peer relaxation selector; `v_reval_shared` byte-equals `FENCE_SHARED_INVOKER_ROUTINES` and
  `v_fence_shared`; literals 275/825/300000 match the accepted migration CHECK text; every relation/function in the new
  SQL routines is schema-qualified.
- Existing PGlite roles/migration tests pass with the include.

## PG17 (`tests/pg/reval-*.pg.test.ts`)

**Owner principal for every test where E runs (closure, executor lifetime, E physical binding, native chain):** the
owner config's owner credential is a dedicated `NOSUPERUSER NOBYPASSRLS` LOGIN (CREATEDB+CREATEROLE as in the
documented non-superuser path) that ran `prisma migrate deploy` and `prisma/roles.sql` (its non-superuser branch) and
therefore owns the tables. The compose superuser / fixture admin only bootstraps that owner, the temporary database and
roles, and drops them afterwards; it never appears in any owner config or spawned process. Evidence records
`rolsuper=false` and `rolbypassrls=false` for the owner, runtime and reader roles actually used. A positive closure under
this owner proves the scope was set before the FORCE-RLS registration read; a test-only seam that skips setting the
scope yields zero rows → REFUSED `REGISTRATION_MISMATCH` before any lock and no revise call.

- **roles:** nonsuperuser owner provisioning on a stock migrated DB (accepted PUBLIC helpers tolerated); ninth/tenth
  distinctness and alias negatives; exact column grants incl. both attempt rates; runtime denied Reval SELECT/DML and
  snapshot EXECUTE; reader denied every table; EXECUTE negatives (each fails readiness and makes roles.sql refuse or
  remove): new PUBLIC user function, listed helper replaced by SECURITY DEFINER, same-name helper in another schema,
  explicit helper grant, grant option, guard EXECUTE; SET ROLE/membership injection; `rolconfig`; parameter grants;
  default-privilege regrant; ownership drift; idempotent reprovision (catalog dump equal); readiness negatives for BOTH
  roles; remote 9 / reval 2.
- **guard**, all with real roles: runtime INSERT/UPDATE of both Reval tables after the new migration but BEFORE the
  roles.sql rerun (default/inherited grants present) → RV010; a non-owner role granted INSERT explicitly → RV010;
  registration UPDATE/DELETE/TRUNCATE refused even as the actual table owner; binding non-increasing generation, changed
  registrationId/ws/client/dataset, DELETE, TRUNCATE refused as owner; supplied `installedAt` replaced by DB time
  (ms-truncated); FK negatives (foreign client/actor/admission, mismatched dataset); all of the above still refused with
  `session_replication_role=replica` (superuser, disposable DB) proving ENABLE ALWAYS; `pg_temp` shadow table/function
  named like a referenced object cannot redirect the guard or snapshot.
- **snapshot:** two workspaces/registrations/readers, no cross-read; stale `app.workspace_id`/`client_ids` of another
  registration set before the call ignored; dropped/recreated reader OID → RV001; missing registered client
  admission row → RV001; SET ROLE → RV002; READ COMMITTED and READ WRITE refused incl. VOLATILE split-read
  counterexample; foreign client/actor counts without IDs; original periods and late settlement; current-period zero
  synthesized; missing referenced counter → `CENSUS_UNAVAILABLE` (ledger trigger disabled only in the disposable DB, as
  superuser); orphan nonzero counter → `consistent:false`; orphan rows count toward 2000; counter ≠ sum with all present →
  `consistent:false` complete census with actual counter values; 1001 attempts; byte cap (synthetic NO_DISPATCH ledger
  built as remote definer via superuser SET ROLE, test-only); timeout under ACCESS EXCLUSIVE lock answered within C
  budget; two-session reserve/settle/pause schedules keep one-tx snapshot stable; pricing as actual confined definer:
  positive, policy priceRevision ≠ approved, historical attempt priceRevision, >8 tuples (RV004); planted secretRef/
  projectIdentity/approval sentinels absent from output; missing binding → RV005.
- **physical binding (DI, UNVERIFIED):** reader correct but S runtime pointed at another otherwise-ready DB → S refuses
  before listen, no `RevalServerBoundV1`; observed ≠ reader tuple → S killed before listen; copied registration/instance
  UUIDs with a different physical tuple → `REGISTRATION_MISMATCH`; production config/bridge rejects TCP runtime target
  and secret-supplied endpoint; E against wrong owner DB → REFUSED `REGISTRATION_MISMATCH` before any lock (no write
  observed).
- **closure (RC2_MINOR reread, confirmed no-op):** revise statement returning zero rows (test-only seam) → ROLLBACK,
  REFUSED `POLICY_CHANGED`, no closure; fingerprints use `sha256(convert_to(...,'UTF8'))`; lock order fence before policy (pg_locks/blocking); all other policy fields
  byte-equal; expected-version mismatch → `POLICY_CHANGED`; concurrent reserve/revoke/settle; policy `expiresAt` with
  NONZERO microseconds on both paths: applied path changes exactly policyVersion/state/stateReason/revisedAt and keeps
  `expiresAt` to the microsecond; already-PAUSED path keeps the whole row identical; already-PAUSED with runtime
  `stateReason` MODEL_MISMATCH stays MODEL_MISMATCH (no-op, no artificial revision); an injected argument difference on
  an already-PAUSED row (DI seam producing a real revision) → ROLLBACK, REFUSED, no closure; ACTIVE row whose call
  returns no-op → REFUSED; E's frames/memory spy shows no policy value or secretRef crossing into JS (fingerprints only); already-PAUSED: routine IS called (test-only statement-capture seam, or
  `pg_stat_user_functions` after the superuser test setup sets `track_functions='pl'` on the disposable DB), returns
  no-op, `CONFIRMED_COMMIT` `revisionApplied:false` →
  closure only strictly above both floors, equal/stale floor → `CONTAINMENT_UNCONFIRMED` + latch; injected ROLLBACK before
  COMMIT → REFUSED, never closure; ack lost after COMMIT (DI seam) → latch, no closure; REVOKED/TOMBSTONE refused without
  call; version max−1 and fence Int max roll back (existing R-A boundary technique); intervening revision/client_set/
  Stage 3 fence bump between commit and reread → refused + latch; exactly four keys; exactly one E spawn, no retry.
- **executor lifetime:** real children; each case asserts no E process and no E owner backend (admin
  `pg_stat_activity` by fixed application_name `atlas-reval-e-owner`, or by phase window) within `D + 1500 ms`, single spawn, no closure, and kill ≠ rollback claim:
  E blocked before connect (unreachable socket stub); E blocked on a policy lock held by another session (server
  timeouts fire before `DE`; C answers before O's 2 s); E killed after COMMIT sent (DI seam) → latch; C SIGKILLed while E
  mid-transaction → E exits on parent EOF and its transaction is aborted.
- **upgrade:** deploy through `202610121000` + `roles-s5remote.sql` with populated remote data; runtime Reval DML refused
  by the guard in the window; readiness fails closed before RS-A roles; after new migration + Prisma inverses + roles:
  readiness passes, remote data/models unchanged, `db:check:drift` clean.
- **launch (darwin; test entries; elsewhere assert refusal):** O test entry under a real PTY via `/usr/bin/script`; O
  without a TTY refused; real O→C→S with built API bridge library and Docker DI; IDENTITY `loadedBinding:'UNVERIFIED'`,
  ref `rsa-test-tcp-unverified-v1`; every IDENTITY re-proves pid AND pidversion; S killed → `IDENTITY_UNVERIFIED`, no
  relaunch; `NONE` mode → `IDENTITY_UNVERIFIED` while SNAPSHOT works; O exit → C, S, E gone within bound; C/S no TTY;
  inheritance leak test (brief §2c): at spawn time the parent deliberately holds sentinel handles — an opened
  secret file, an opened config file, a parent DB socket, an extra listening socket and another child's channel — and
  records each one's stable identity (`fstat` dev/ino/mode; for sockets also the local/peer address or path). C, S and E
  (test-entry probe at first JS entry; Node/libuv already initialized) enumerate and classify every descriptor visible
  then: inherited application handles must be exactly fd 0–2 (`/dev/null`) and fd 3 (that child's socketpair end);
  descriptors the runtime itself created before JS (libuv kqueue, wakeup/signal pipes, worker fds) are allowed and
  classified; NO visible descriptor may match any parent sentinel identity. No assertion is made about the total fd
  count/range at any JS point. The production helper is NOT modified for this: its fds are inspected externally (a
  test-only paused invocation, e.g. fd 4 held open by the test before writing the expected path, while `lsof -p` lists
  them): 0–2 per its stdio, 3 = the channel dup, 4 = the expected-path pipe, none matching a sentinel. Detector
  self-test: a test-only spawn wrapper (never production launch code) that deliberately passes one extra sentinel handle
  as an additional inherited stdio entry MUST make the leak detector fail, proving the absence check is meaningful.
  Later live fds are
  classified (own PG sockets, libuv internals, S HTTP listener), not forbidden; no PG backend authenticated as
  owner/runtime exists for C (admin `pg_stat_activity` by usename + fixed application_name) and no
  `atlas-reval-e-owner` backend exists outside E's lifetime phase window;
  S has no child processes; `ps` argv/env and O output contain no secret sentinel;
  bridge refuses Ask remote/mock, env URL, missing launch frame, frame before HELLO; `pg_stat_activity` cross-check
  recorded available/unavailable honestly. Timing: 20× IDENTITY and PAUSE_EXPORT, p50/max reported; any C answer after
  1800 ms or O-side DEADLINE is a finding (Docker timing = regression only).
- **native Unix PG17 — production chain (fixture-driven):** `tests/pg/reval-native-unix.pg.test.ts`. `tests/support`
  reads `ATLAS_REVAL_NATIVE_PG_FIXTURE` (closed JSON `{adminRole, adminSecretFile, dataDirectory, port, socketDir}`;
  test-only, never read by production code). Setup (admin bootstrap only, test-only): temporary database on that
  cluster and the dedicated non-superuser owner above, which then runs migrations + roles.sql (non-superuser branch)
  and creates synthetic policy/admission/attempts, registration (recorded physical tuple, reader OID, build manifest of
  the built artifacts) and binding; a real 0600 `RevalOwnerConfigV1` in a 0700 realpath directory with three closed
  password files. Then it drives the UNMODIFIED production chain, no `tests/support` DI in any spawned process:
  production `scripts/reval-server/owner.ts` under a real PTY via `/usr/bin/script` → production controller
  (`productionDeps()`) → built `dist/apps/api/src/main.js` in bridge mode → production `owner-exec.ts` → built helper
  pinned by sha256. Required positives: IDENTITY `loadedBinding:'UNVERIFIED'`, ref `rsa-peertoken-unixphys-v1`; SNAPSHOT
  exact payload; PAUSE_EXPORT closure on the APPLIED path (ACTIVE→PAUSED) and on the already-PAUSED NO-OP path (floors
  below the tuple), each with exact four keys. Required negatives (each fresh config/session): socket dev/inode mismatch
  (socket replaced/other path), `postmaster.pid` pid/start mismatch, database OID mismatch → refusal before S listens /
  before E effects / no census. Evidence run: the env variable MUST be set to the root descriptor; a skip, missing
  descriptor or unreachable cluster is a FAILURE of the evidence run (only ad-hoc developer runs may skip with reason
  `NATIVE_UNIX_PG_FIXTURE_ABSENT`). Evidence records the descriptor sha256 and PG version, labels results
  test-fixture evidence (never MEASURED, not platform/image proof), and never includes secret contents. The temporary
  database and roles are dropped afterwards.

## Required suite (after changes; exact outputs in CHECKS evidence)

`node --experimental-strip-types --test tests/*.test.ts` (incl. context-budget); `npm run typecheck`;
`npm run ui:typecheck`; `npm run schema:validate`; `npm run db:check:drift`; `npm run db:check:pg17`; `npm run test:pg`
(all PG17; evidence run with the native fixture set, no skip); `npm run api:build`; `npm run test:ui` (regression; browser
unchanged); helper build twice (byte reproducibility reported); `git diff --check`; clean production-copy rebuild
reproducing dist/helper hashes; changed/new file list equals brief §10 with baseline→new hashes for accepted files and
RC5 delta 0. `verifiedPass`/`liveAcceptanceEligible` stay false. Failures, repairs, timing, model/effort/session and
native-fixture identity reported honestly.
