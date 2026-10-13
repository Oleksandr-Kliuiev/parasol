# Independent brief acceptance review — S5ASKREMOTE-REVAL-RSA-BRIEF-rc1

**Verdict: CHANGES_REQUIRED**: 9 required findings (R1–R9) and 16 nonblocking notes. I classified all of A1–A9
as within accepted architecture RC4, so this brief needs no Astra/Fable return. Every required finding is a
bounded repair to the brief text inside RC4. None of them changes RC4.

## 1. Exact identity (I verified each item myself)

| Item | Result |
|---|---|
| Artifact | `S5ASKREMOTE-REVAL-RSA-BRIEF-rc1` |
| packageHash | `059cb977895fcc2cfc110afc3108ac1e6cb58fb2cb8bef007a5cb64b112036e2`. Recomputed with the stated algorithm (sha256 of compact JSON of path-sorted `{path,sha256}`). **MATCH** |
| Manifest | `verification/stage5/S5ASKREMOTE_REVAL_RSA_BRIEF_RC1_MANIFEST.json`, sha256 `848780da1e266858b841b225d67f16d43bbe766718dd7f85434b348b691b1528`. 43 entries, path-sorted. All 43 on-disk hashes **MATCH** |
| ZIP | `…_RSA_BRIEF_RC1_PACKAGE.zip`, sha256 `409dd0d11dcd4145bf078b14cba72985d5cb535cf8e5245998aca976652be0b7`. Read in memory without extraction: 43 entries, each byte-equal to the manifest, none extra or missing |
| CHECKS | sha256 `2721497589988a14566dd3c0e752ccbef3984959a13329a3d1790e98e238b7fa`. It claims only hashes, lines and fences, "no code or runtime proof", which is consistent |
| Brief | `docs/stage5/ask/remote/reval-server/rs-a/IMPLEMENTATION_BRIEF.md`, 491 lines, sha256 `2b9626467a694cab6e1b692e8f5385e4c74af09dff5037f84d8bf840ab396333`. RS-A `AGENTS.md`: `077136a0…00b3` |
| Baseline | `verification/stage5/S5ASKREMOTE_REVAL_RSA_IMPLEMENTATION_BASELINE.json`, sha256 `62328bcb…4347` (in the manifest). HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66` and branch `codex/reval-server-contracts-20261011` match the current checkout. All 1540 of 1540 entries are byte-equal on disk now. `/tmp/atlas-reval-rsa/baseline.json` is byte-identical |
| Parent architecture | RC4 `9fa16222d6c32c18d4d193b6666e078fd3624a4bdb2ccb8ab9fbd68113b08163`, recomputed from the RC4 manifest (sha256 `2bba30ce…26dd`, which equals the seal). RC4 CHECKS `496ab432…2c53` and ZIP `367fc692…5843` equal the seal. All 38 RC4 entries are unchanged on disk and all are included in the RS-A manifest |
| Parent execution RC5 | `5c6a7e52…4d97`, 120 files. None of the allowed modifications in brief §9 is an RC5 file. No RC5 `.ts` file references roles.sql, readiness, migrations or schema files (scan), so "RC5 delta 0" is feasible |
| Status | `S5ASKREMOTE_REVAL_RSA_STATUS.json` sha256 `4e47eda6…585c`: BRIEF_RC1_INDEPENDENT_REVIEW, paid calls 0, activation false |

## 2. Reviewer, effort, telemetry, conduct

- The root requested a native `claude-opus-5-5` session at effort `xhigh`, as a fresh session separate from the author's
  implementation session. This report does **not** offer self-identification as model evidence. The root verifies the model
  from assistant-message metadata.
- From inside this session I cannot observe the effective effort, billing route (included/Max), elapsed time or token use,
  so all four are **UNAVAILABLE**. I requested no fast mode, extra usage, API credits or fallback.
- No subagents, network, provider or account calls, DB connections, or code/test/build runs. I ran only read-only
  commands: reads, sha256, the in-memory ZIP read, `node -v`, `uname`, `sw_vers`, `clang --version` and SDK header greps.
  This report is my only write. The repo and its existing dirty work are untouched.
- I deliberately did **not** open `/tmp/atlas-reval-rsa/SOL_BRIEF_RC1_REVIEW.md`, `brief-opus-review*`,
  `RS_A_IMPLEMENTATION_BRIEF_DRAFT.md` or `docs/stage5/reviews/**`. I only hashed `baseline.json`.

**Inputs read:**
- Governance: `DEVELOPMENT_WORKFLOW.md` lines 1–85; root `AGENTS.md` lines 1–45; reval-server `AGENTS.md` and `DESIGN_STATUS.md`; RS-A `AGENTS.md`; the whole brief.
- RC4 architecture: 01, 02, 05 and 06 in full; 03 and README searched for registration and price.
- Code and schema, narrowly: `prisma/askremote.prisma`; migration `202610111010` (CHECKs, guard, RLS); migration `202610111020` (pause/create/revise); `prisma/roles.sql` lines 85–135, 183–236 and 558–650; `tests/support/roles-sql.ts`; `apps/api/src/main.ts`.
- Build and test config: both tsconfigs, `package.json` scripts and dependencies, `scripts/schema-drift-check.ts`, `tests/context-budget.test.ts`.
- Also: searches of `runtime-role.ts`, and macOS SDK headers.

## 3. Summary

**What is right.** The brief follows RC4 closely:

- **Scope:** RS-A only; RS-B, RS-C and RS-D are out.
- **Payloads and codes:** exact 02/06 payloads, and exactly 43 FailureCodes. I counted the 06 enum: 43 unique codes, and every code the brief uses is in it.
- **Directions:** the full 06 direction table is checked before any DB, spawn or slot effect.
- **Credentials:** owner, reader and runtime credentials are split by design.
- **Transport:** production allows only UNIX_SOCKET; the TCP adapter is test-only.
- **Identity claims:** `loadedBinding` is constant UNVERIFIED, pending items and residuals are honest, and there are no MEASURED or acceptance claims.
- **Finance:** financial routines are untouched, and there are no new dependencies.
- **Obligations:** NB5 and RC2_MINOR are substantively resolved. All Darwin primitives the helper needs exist in the public SDK.

**What needs fixing.** Several concrete specifications contradict the accepted schema, roles or build checks (R1, R2, R7).
Others are left open exactly where the owner asked for precision:
- the credential, physical-identity and peer-proof order in the executor (R4);
- the outcome codes for unknown commits and rereads, and the deadlines (R5);
- one exact payload value (R6).

A guard gap leaves a writable window during upgrades (R3). The launch test cannot run as specified (R8). Some
acceptance-matrix verifications are missing from §10 (R9).

## 4. Required findings

**R1 — The pricing tuple cannot be implemented as written (§5 L201–202; §6 L240–242, L270–271).**

Step 4 reads `promptRate` and `completionRate` "over the policy AND every project attempt". Three problems:
- (a) `RemoteAskPolicy` has no rate columns (`prisma/askremote.prisma:11–41`). Rates exist only on `RemoteAskAttempt`, fixed to 275/825 by CHECK (`202610111010/migration.sql:172`).
- (b) The exact definer column grant on `RemoteAskAttempt` (L201–202) leaves out both rate columns. The routine would fail with 42501 at runtime, unless the implementer widens the "exact" allowlist on their own.
- (c) As a result, the "exactly ONE tuple" rule (L270–271) has no defined policy-tuple shape. A policy tuple with no rates can never equal an attempt tuple, so every snapshot with at least one attempt would return POLICY_CHANGED.

Required:
- Define the tuple shapes exactly. For example: the policy contributes `(profile, priceRevision, reserveMicroUsd)`, with rates taken as the SQL-fixed constants; each attempt contributes `(profile, priceRevision, reservedMicroUsd, promptRate, completionRate)`.
- Then either add exactly `RemoteAskAttempt.promptRate, completionRate` to the definer allowlist and postconditions (allowed by 01:30–35, internal only), or drop rates from step 4, since CHECK already enforces them.
- Tests: the exact grant set; one tuple accepted with at least one attempt; mixed revisions rejected.

**R2 — The reader/definer EXECUTE postcondition contradicts the accepted surface pattern (§5 L210–214).**

L212 says the reader's "user-routine EXECUTE is the snapshot only". That cannot hold:
- About 30 accepted SECURITY INVOKER helpers, including `public.atlas_app_workspace()`, are executable through PUBLIC (`roles.sql:103–115`, `v_fence_shared`).
- The accepted remote-definer postcondition explicitly allows "the shared invoker helpers via PUBLIC" (`roles.sql:585`, also `:488`).
- The new definer *needs* `atlas_app_workspace()`, because every RLS policy it evaluates calls it (`202610111010:351–364`, `202610071200:144`).

As written, the fail-closed postcondition will abort provisioning. The alternatives are an unreviewed relaxation, or revoking
PUBLIC on accepted helpers, which would change accepted objects.

Required:
- State both roles' exact EXECUTE surface: the reader gets the snapshot; the definer owns exactly the snapshot; both may also execute the exact `v_fence_shared` invoker identities through PUBLIC only.
- Nothing SECURITY DEFINER and nothing granted directly beyond that.
- Reuse the same list in `reval-role.ts`.
- Add negative tests that an unlisted or SECURITY DEFINER PUBLIC-executable routine is detected for both new roles.

**R3 — The guard has no writer-identity check, and "owner-only DML" relies on grants that are missing during upgrade (§4 L166–169; §10).**

1. `roles.sql` gives the runtime `SELECT, INSERT, UPDATE ON ALL TABLES`, plus DEFAULT PRIVILEGES for tables the owner creates later (`roles.sql:187`, `:231`).
2. So after `202610131000` is deployed, and before roles.sql runs again, the runtime login can INSERT/UPDATE both Reval tables.
3. FORCE RLS with the PUBLIC workspace policy lets it insert a registration for any workspace it names in `app.workspace_id`.
4. The guard blocks UPDATE and DELETE, and `UNIQUE(workspaceId)` allows one row per workspace. Such a row is therefore permanent and blocks the legitimate registration.

RC4 01:110–115 and 05:156 require owner-only registration/binding DML. The accepted R-A guard enforces writer identity
regardless of grants (`202610111010:203–207`).

Required:
- The guard refuses INSERT/UPDATE unless `current_user` owns the guard function and the tables (the migration owner), with RV010.
- Tests for each of these:
  - a runtime INSERT in the window after migration and before roles.sql is refused;
  - registration UPDATE, DELETE and TRUNCATE are refused, even for the owner;
  - binding changes are refused for a non-increasing generation, an identity change, or DELETE/TRUNCATE;
  - `installedAt` is always forced to DB time;
  - ENABLE ALWAYS still fires under `session_replication_role=replica` (superuser, disposable DB).
- §10 currently lists **no** guard tests.

**R4 — The executor contract is underspecified at the credential, physical-identity and peer-proof boundaries (§2 L98–100; §7 L295–313).**

Missing pieces:
- **(a) Environment.** There is no env/argv allowlist for the executor (S has one at L85–88).
- **(b) Secret files.** The content format of the owner and reader secret files (password only, or a URL) is not specified. The connection target (socket dir, port, database name, user) must come from the owner config's UNIX_SOCKET physical section, never from a host or URL inside a secret file. Otherwise a TCP target can reach production through a secret.
- **(c) Physical facts.** The executor "verifies physical identity" (L302), but nothing says where it gets the expected facts. The request frame (L298) carries none, and its access to the config is not stated.
- **(d) Handshake order.**
  - Per L51–52, the peer token reports the socket's creator (C) until the child writes.
  - So the executor must first write a hello. C then peer-proves it with the same checks as L89–91: pid, ppid, euid, executable, no TTY, still running.
  - Only then may C send the request that contains `ownerSecretFile`.
  - The executor must not read the owner secret or connect before receiving that request. This is the owner's rule that actual Darwin peer verification comes before any DB access or privilege.
  - State the same for S: no runtime-secret read and no DB connection before seq2.
- **(e) Step order.** Under FORCE RLS the table owner sees no registration row until `app.workspace_id` is set. So "clear and set scope" (L304) must come before the registration read (L302); the current order is inverted. The read must explicitly match registrationId, databaseInstanceId, workspaceId and the admission.

Required:
- Specify items (a)–(e).
- Test that the executor:
  - does nothing before the request frame arrives;
  - rejects a secret file that contains a host or URL;
  - on a physical mismatch, returns REGISTRATION_MISMATCH without calling revise.

**R5 — The closure outcome map and deadlines are not closed (§3 L145–148; §6 L260–262; §7 L299–316; §8 L329).**

- **(a) No executor/SQL → FailureCode map.** The brief maps none of these conditions:
  - 42501 (non-owner login), AR004, AR008, AR009 and 22003 (fence Int overflow);
  - a postcondition violation, or 55P03/57014 before COMMIT;
  - an authentication failure or a physical mismatch.
  The `code` domain for REFUSED (L299) is left open.
- **(b) Reread failure after a CONFIRMED commit is unspecified.** The cases are RV001, RV003, RV004, RV005, the byte cap, `consistent:false`, a pricing mismatch or a timeout. Unspecified: the code to return, whether it latches, and which snapshot validations gate a closure. A closure certifies only the policy and fence (02:169).
- **(c) Malformed executor results.** A malformed or unauthenticated executor result, or a missing challenge echo, must count as COMMIT_UNKNOWN, because the commit may already have happened. It must not be INTERNAL_FAILURE.
- **(d) Budgets exceed the 2-second bound.** The 2s operation bound comes from 01:91 and 02:19–20.
  - PAUSE_EXPORT: executor lock 500ms + statement 1000ms + reread up to 2s wall (L262) is more than 2s.
  - SNAPSHOT: the reader's wall bound equals O's own 2s deadline (L262 vs L329).
  - Result: contended cases end as an O-side DEADLINE plus session teardown, possibly with the executor mid-COMMIT.
  - "The deadline passed" (L146) does not say which deadline.

Required:
- One C-side monotonic budget per operation, strictly under O's 2s, with explicit sub-budgets: spawn/handshake, transaction, reread.
- A phase → outcome table: before the request is sent, no commit is possible; after it is sent, the outcome is COMMIT_UNKNOWN plus the latch.
- C kills the executor when the budget expires or O reaches EOF. The executor rolls back on fd-3 EOF before COMMIT.
- Tests: each mapped code; a reread failure after commit (no closure, with the chosen code and latch); a malformed result latching; under lock contention, C answers before O's deadline.

**R6 — A missing counter has no defined `chargedMicroUsd` value in an exact closed payload (§6 L248–252).**

- `periods[]` requires a Dec64 `chargedMicroUsd` (02:39), and C requires every referenced period to be present (L279).
- Yet a missing counter for an existing attempt is "never zero-filled", and no other value is given. 02:17 calls this an integrity failure.

Required:
- Choose one and test it:
  - (i) RV-coded failure → CENSUS_UNAVAILABLE with no export. I recommend this; it avoids exporting an invented number.
  - (ii) Export a specified value (for example the attempts' SUM) with `consistent:false`.
- State that otherwise `chargedMicroUsd` is the counter row's actual value.
- Say whether orphan project counter rows (neither referenced nor current) take part in the counter = SUM check and count toward the 2000-row bound.
- The fixture planned at L408 can carry the test.

**R7 — The Prisma relations require editing `prisma/askremote.prisma`, which §9 does not allow (§4 L157, L177; §9 L363–375; §11 L443).**

- The drift check compares migrations with the whole `prisma/` datamodel (`migrate diff --to-schema-datamodel prisma` in `scripts/schema-drift-check.ts`). So the four registration FKs must also be Prisma relations.
- Prisma requires an opposite relation field on each side. `RemoteAskPolicy` and `RemoteAskClientAdmission` are defined in `prisma/askremote.prisma`, an accepted R-A source (not an RC5 file).
- §9's list is exhaustive, and L443 requires "changed/new file list equals §9". The plan therefore fails its own check by construction.

Required:
- Add `prisma/askremote.prisma` as a bounded modification: virtual back-relation fields on those two models only, with no column, constraint or map change.
- Declare its baseline → new hash as an accepted-file delta.
- `schema:validate` and `db:check:drift` then prove it causes no SQL change.
- (Placing the new models in a new `prisma/reval.prisma` is fine, but still needs the back-relations.)

**R8 — The launch test cannot run as specified (§2 L79–80; §5 L228–231; §10 L424–430).**

- **(a) No TTY in tests.** C requires O to hold a controlling TTY (L80). Under `npm run test:pg` from a non-interactive shell there is none. The "real O→C→S" test then depends on the environment, or pushes the implementer toward a TTY bypass.
- **(b) Cross-process injection.** The TCP adapter is "injected through the library DI seam". But O, C and S are separate processes started from `scripts/reval-server/*`, and the brief doesn't say how to inject across processes. That invites an env variable or flag in production entrypoints.

Required:
- Launch tests use test-only O and C entrypoints under `tests/support/` that import `packages/reval/*` with the injected adapter.
- O runs under a real PTY via macOS `/usr/bin/script` (present on this host; no new dependency).
- Add a test that O without a TTY is refused.
- Extend the static test to prove that no production entrypoint, config field or env variable can select TCP or relax the TTY/peer checks.

**R9 — §10 is missing verifications the acceptance matrix requires (05:156, 05:170, 05:172).**

Add these tests:
- **(a) Physical-binding comparator,** runnable on this host without a host-local PG:
  - use a real temporary AF_UNIX listening socket and a synthetic `postmaster.pid`/data directory;
  - mismatch each fact on its own: same `system_identifier` with a different socket dev/inode, data directory, postmaster pid/start, database OID, or `pg_postmaster_start_time`;
  - also a socket replaced after recording, and missing or partial facts;
  - expected result each time: REGISTRATION_MISMATCH, reader closed, no census.
- **(b) Credential absence.**
  - C never opens the owner or runtime secret files (spy on the resolver and on file opens inside C).
  - The owner credential never appears in C↔O or C↔S frames, or in C/S env or argv.
  - The executor closes its handle and exits after one operation; no executor is spawned after the latch.
- **(c) Same pid, different pidversion** → IDENTITY_UNVERIFIED, and S is killed.

## 5. Classification of brief decisions A1–A9 (none needs Astra/Fable)

| ID | Classification | Basis and conditions |
|---|---|---|
| A1 | Within RC4 | RC4 01:85–89 requires a private Unix-domain channel with verified peer PID and incarnation, and forbids pathname- or UID-only checks and loopback substitutes. It already allows inherited launch channels. 06:13 selects O from a verified peer plus the owner's explicit registration. A nameless inherited AF_UNIX socketpair meets all of this with a smaller attack surface. **Conditions:** the 0700 named socket stays mandatory for I in RS-C. Tying C's lifetime to O (O exiting kills C and S, L102–104) is an RS-A choice; RS-C must handle its run-continuity consequences, and it is not a precedent |
| A2 | Within RC4 | The frames are internal; exported schemas stay exactly 02/06. They must be closed, strictly parsed and never persisted. R4 and R5 define their contents |
| A3 | Within RC4 | RC4 03:12–21 and 05:142 put isolated registration and maintenance in RS-B. **Consequence to state as a residual:** in production, RS-A's SNAPSHOT and PAUSE_EXPORT can only refuse until RS-B exists |
| A4 | Within RC4 (stricter) | 01:37 grants the runtime only the columns it needs, and in RS-A it needs none. RS-B/RS-C must add the exact columns together with readiness checks |
| A5 | Within RC4 (stricter) | Ask stays OFF until the RS-C ingress gate exists |
| A6 | Within RC4 | 01:73 permits an approved secret resolver. The input exists only in bridge mode, and `ATLAS_RUNTIME_DATABASE_URL` is absent there. It still needs R4(b), the secret format. The main.ts hook fits within 8 lines (one URL read at L33, `listen` at L41) |
| A7 | Within RC4 (stricter) | Consistent with 02:139–141 (no relabelling, no automatic retry) and with CONTAINMENT_UNCONFIRMED being absorbing (02:155–156) |
| A8 | **Within RC4, not a material exception** | RC4 02:47 requires the price/profile to match the registration's approved policy, but does not say where the expectation is stored. The config field is owner-local, pattern-validated and read once. It is used only to refuse (existing POLICY_CHANGED code). It is never exported, never written to the DB, and never used to authorize anything. It adds no authority, isolation, data boundary, durability or public contract, and it strengthens the financial invariant. RC4 01:104 ("only these allowlisted identity metadata") limits which physical-binding and path facts go into the owner record; a non-secret `priceRevision` identifier that already exists in the DB does not breach that purpose. **It becomes an architecture change, and returns to Astra/Fable, if** the value is ever used to permit or resume something, exported, or added to the DB or registration schema. A8 works only once R1 is fixed |
| A9 | Within RC4 | RC4 01:86–88 forbids silent fallback. Production refuses, and TCP is test-only |

## 6. Obligation and owner-checklist verification

- **NB5:** satisfied, subject to R4(d) and R8.
  - Platform is pinned. I verified the host: macOS 26.6.2, Darwin arm64, Node v25.8.1, Apple clang 21.0.0.
  - The topology O/C/S/E is defined.
  - The mechanism:
    - `LOCAL_PEERTOKEN` gives an `audit_token_t`, from which pid, pidversion and euid are read;
    - `proc_pidpath_audittoken` proves the process is still alive;
    - the token is read again and must be unchanged.
    - All of these are declared in the SDK headers (`sys/un.h:93`, `bsm/libbsm.h`, `libproc.h:103`).
  - The pid-reuse argument holds: C is the reaping parent of S.
  - TTY and file-descriptor ownership are specified, and nothing is ever claimed MEASURED.
- **RC2_MINOR:** resolved explicitly at L133–143.
  - The reread's version and fence must exactly equal those of the committed operation.
  - Any fence advance, by any mechanism, refuses the closure even if the policy is still PAUSED.
  - A no-op on an already-PAUSED policy uses the locked tuple under the same rule.
  - Reread-failure codes are covered by R5.
- **Owner checklist:**

  | Item | Status |
  |---|---|
  | Exact closed envelopes | ✔ L326–332, L117–129, L255–257, L315–316 |
  | 43-code FailureCode enum | ✔ count verified |
  | Directions | ✔ L334–335 (code choice: N5) |
  | Credential split | ✔ by design; gaps in R4 and R9(b) |
  | Physical identity | ✔ production allows only UNIX_SOCKET; gaps in R4(b,c) and R9(a) |
  | Price/profile expectation from the approved owner binding | ✔ A8; defect in R1 |
  | No row scope chosen by the caller | ✔ The snapshot takes no arguments. Scope comes from the registration keyed by `session_user`. The executor's scope comes from C's registration; O's admission is checked against it |
  | Complete atomic REPEATABLE READ census plus foreign counts | ✔ `projectIdentity` is globally `@unique` and counters/attempts are FK-bound to (workspaceId, projectIdentity), so a workspace-scoped census covers the whole project. The routine verifies RR READ ONLY itself. Gap in R6 |
  | Version, fence, reread, unknown commit, floors | ✔ core rules; gaps in R5 |
  | Docker TCP unreachable from production | ✔ by design; gap in R8(b) |
  | Real host PG Unix socket unavailable | ✔ honestly declared as a residual (L483–485) |
  | `loadedBinding` UNVERIFIED pending RS-D | ✔ L114–115 |
  | Actual Darwin peer verification before DB access or privilege | ✔ for C (step 1 before step 2); gap in R4(d) for the executor and S |
  | No invented MEASURED or acceptance claims | ✔ L64–65, L125–127, L449, L481–489 |
  | Bounded checkpoint without unnecessary deferral | ✔ the deferrals in A3–A5 trace to RC4 and the 05 checkpoint table |
  | Required suite | ✔ see below |

  The required suite covers:
  - unit/PGlite tests, including context-budget;
  - `typecheck` and `ui:typecheck`;
  - schema validate, drift and pg17 checks;
  - `test:pg` for roles, snapshot, closure, upgrade, launch and concurrency;
  - `api:build`, plus the `test:ui` browser regression;
  - helper build, reproducible production-copy rebuild and baseline comparison.

  Existing globs already include the new paths: the root tsconfig `include`, `tests/*.test.ts`, `tests/pg/*.test.ts`, and the API tsconfig's `packages/**`. There are no new dependencies. `schema.prisma` has 459 lines, and `roles.sql` goes from 650 to at most 662, both under the 700-line cap.
- **Finance, private proof and refunds are unchanged** (L39–40, L374–375). The accepted `atlas_ask_remote_policy_revise`
  (`202610111020:281–343`) already sets fence+1, version+1 and `stateReason` OWNER, turns into TOMBSTONE at the version
  maximum, and never raises caps. That matches the postconditions at L311–312.

## 7. Nonblocking notes

- **N1 — Lookup order (L237–239).** Clear `app.*` before the registration lookup, and filter explicitly on `evidenceReaderRoleOid` = the `session_user` OID. Permissive RLS policies combine with OR, so a caller-set `app.workspace_id` currently makes a second row visible. That fails closed as "ambiguous", but it lets caller hints affect the path.
- **N2 — Schema qualification.** Schema-qualify every relation and function in the definer routine and the guard. The reader can create `pg_temp` objects, and `pg_temp` is on the routine's search_path. Add a negative test with a shadow table in `pg_temp`.
- **N3 — Millisecond times.** Specify truncation to milliseconds (`date_trunc('milliseconds', …)`), never rounding. Otherwise the C check `dayStart = UTC(createdAt)` can fail at 23:59:59.9995.
- **N4 — Failures before verification (L76–78).** These would carry an unverified `databaseInstanceId`, which 06:41–42 forbids. Prefer closing with a fixed exit code and letting O show PLATFORM_UNVERIFIED or IDENTITY_UNVERIFIED locally. Otherwise state where the value comes from.
- **N5 — Code choices.** Pin WRONG_DIRECTION versus OWNER_REQUIRED for each (sender, operation) pair. Also pin whether a frame that parses but fails the schema returns PROTOCOL_INVALID or closes the channel (L332).
- **N6 — Peer-token semantics.**
  - `LOCAL_PEERTOKEN` reports the last process that did I/O on the peer socket (XNU `last_pid`), which matches L51–52. Document this.
  - Re-prove the peer at every IDENTITY, kill the helper on timeout, and make sure no grandchild inherits S's fd 3.
  - Treat the author's probe (L44) as unverified until the darwin tests in §10 reproduce it.
- **N7 — Undefined mode.** `server.mode` values other than LAUNCH, and IDENTITY behaviour without S, are undefined (L84). Enumerate them in the closed config schema.
- **N8 — Build manifest.** Nothing compares the registration's `buildManifestSha256` (L155) to anything. Either compare C's pre-launch digest with it (through the internal wrapper) and refuse on mismatch, or state the deferral.
- **N9 — Unused grant.** Nothing in §6 uses the definer's `RemoteAskClientAdmission` grant (L199). Use it, for example to confirm the registered client's row exists, or drop it. RC4 01:13 allows only the SELECT columns actually needed.
- **N10 — Helper binary.**
  - Pin the helper's sha256 in the owner-protected config, not only in the gitignored `dist/`.
  - The Apple Silicon linker's ad-hoc signature identifier comes from the output basename; keep it identical for reproducibility.
  - If the binary is not byte-reproducible, report that.
- **N11 — Postmaster facts.**
  - Reading `postmaster.pid` requires the owner's OS user to read PGDATA; state that as a production precondition.
  - Cross-check its start time against `pg_postmaster_start_time()`.
  - A socket-path swap between `fstat` and connect remains possible. Either bind through the DB socket's own peer token (backend ppid = postmaster pid) or list it as a residual.
- **N12 — S's database.** S's runtime database is not physically bound in RS-A. RS-C must bind it before any Ask path.
- **N13 — Closure dependencies.** Closure confirmation inherits every snapshot failure mode: limits, missing binding, and pricing (depending on the R5 choice). That is acceptable at ≤200 cases; list it as a residual.
- **N14 — Reader password.** Passing the reader password through `psql -v` follows the accepted provisioning pattern, but it is visible in argv while provisioning runs. Note this in the RUNBOOK.
- **N15 — Timing evidence.** The timing runs at L431 use Docker TCP, so they are regression evidence only, never MEASURED.
- **N16 — Citations.** L12 cites the `/tmp` baseline; cite the repo copy, which is byte-identical. The "DRAFT" wording at L3–6 is fine as frozen text, because current status lives in the status JSON.

## 8. Residuals

The brief declares these correctly:
- the loaded image and its immutability are UNVERIFIED until RS-D;
- the real host Unix-socket PG17 physical-binding proof is UNAVAILABLE on this host;
- the helper hash check has a TOCTOU gap;
- a same-UID, root or kernel compromise is outside the trust boundary;
- darwin x86_64 is untested, so it is refused;
- S's logs are dropped;
- `roles.sql` exceeds the 500-line target but stays under the 700 cap.

Add: the A3 consequence (production RS-A can only refuse until RS-B), N11 and N13.

## 9. Re-review

If rc2 repairs only R1–R9 in the brief text, with no architecture change, this reviewer's own session can do a bounded
re-review at xhigh against the new exact package hash and delta. Any other scope change, or any change that stops A8
being refusal-only, needs fresh review under the workflow.
