# Bounded re-review — S5ASKREMOTE-REVAL-RSA-BRIEF-rc2 (continuing the Opus RC1 independent review session)

**Verdict: CHANGES_REQUIRED.** Two new required findings (RC2-R1, RC2-R2), both narrow. All of my RC1 findings
(R1–R9) and notes (N1–N16) are closed. The rc2 changes stay within RC4 and are a bounded repair: no new scope, no
exported DTO change, no finance or authority change. This brief does not need fresh Astra/Fable review.

## 1. Exact identity (verified by me)

| Item | Result |
|---|---|
| Artifact | `S5ASKREMOTE-REVAL-RSA-BRIEF-rc2`; parentBriefHash in the manifest = RC1 `059cb977…36e2` |
| packageHash | `c752398dea2c9eed10a2a9b0346e68011d4a085210487915885d16cf4893cfdb`, recomputed (sha256 of compact JSON of path-sorted entries). **MATCH** |
| Manifest | `…RSA_BRIEF_RC2_MANIFEST.json`, sha256 `43b3033b73ee7f5a2a19b97d0feaaa22ac24414a879b912ce8a84e57684a80d2`. 44 entries, sorted, all match on disk |
| ZIP | `…RC2_PACKAGE.zip`, sha256 `573968b5817337679c0e895e73863df07e9214b7a9c439199a06e253c5350127`. 44 entries read in memory; all byte-equal, none extra or missing |
| CHECKS | `…RC2_CHECKS.json`, sha256 `0f804d09a107a0eabf9f6e645f6fc467496391d560a8bf8c24afa5f4c0b531ad`. Claims only static checks plus native-fixture preflight; `candidateImplementationTested:false` |
| Delta vs RC1 manifest | changed: `rs-a/IMPLEMENTATION_BRIEF.md` (430 lines); added: `rs-a/ACCEPTANCE_CHECKS.md` (127 lines); removed: none. Exactly two document changes |
| Unchanged | RC4 `9fa16222…8163`: 38 of 38 entries on disk. RC5: 120 of 120. Baseline: 1540 of 1540. HEAD `916a4d69…f66` |
| Native fixture | Descriptor key set is exactly `{adminRole, adminSecretFile, dataDirectory, port, socketDir}`, matching the closed shape in checks L113–114. I inspected only key names and path classification (both paths are canonical realpaths with no world-writable ancestor). I read no values, secrets or credentials and opened no DB connection |

## 2. Session, effort, telemetry

- This bounded re-review continues **my own** independent RC1 reviewer session, as the workflow permits. Requested:
  native `claude-opus-5-5` at `xhigh`. I make no self-identification claim as model evidence; the root checks the
  assistant-message metadata.
- I cannot observe the effective effort, billing route (native Max/included), elapsed time or token use from inside
  the session, so all four are **UNAVAILABLE**. I requested no fast mode, extra usage, API credits or fallback.
- Read-only throughout. No subagents, network, provider calls, DB connections, code/test/build runs, or repo writes. Not opened:
  `SOL_*` reports, `RSA_STATUS`, private author files, review reports, secret files, fixture credentials.
  - Brief L5 and L8 mention the other reviewer's findings and classification. I neither relied on nor verified those
    statements. My attestation covers only my own classification.

## 3. Closure of my RC1 findings

| RC1 | rc2 location | Status |
|---|---|---|
| R1 pricing/rates | §7.5 L278–281 (policy tuple without rates; attempts with rates; >8 distinct tuples → RV004); C comparator L301–302; rate grants §8 L335; literal parity test (checks L53) | Closed |
| R2 EXECUTE surface | §8 L341–349: exact `FENCE_SHARED_INVOKER_ROUTINES`/`v_fence_shared` list via PUBLIC only, `prosecdef=false`, `v_reval_shared` parity; no REVOKE on accepted helpers; negatives (checks L61–63). Constant exists at `packages/graph/fence-role.ts:39` | Closed |
| R3 guard writer identity | §5 L202–206 (current_user must own the guard and the table; ENABLE ALWAYS); guard tests (checks L66–72), including the window after migration and before roles.sql | Closed |
| R4 executor contract | Closed password-only secret format with endpoint and roles from config (§2b L95–100); HELLO → peer proof → request → secret read/DB (§2e L121–130); E env EMPTY, argv fixed (§6 L229–230); scope set before the FORCE-RLS registration read, with an exact 6-field match (§3 L165–168) | Closed |
| R5 outcome/deadline | One 1800 ms budget with derived sub-deadlines; bounded kill/reap; closed phase→outcome map with latch (§6 L222–265); reread-failure semantics (§4 L185–188) | Closed (see note NB-b) |
| R6 missing counter | §7.7–8 L283–288: RV006 → `CENSUS_UNAVAILABLE`; orphan rows counted and checked; exported value = actual counter value | Closed |
| R7 Prisma | §5 L211–215: new `prisma/reval.prisma`, virtual inverses only; `askremote.prisma` in §10 L388–389 and §0 L24–26 | Closed (see NB-c) |
| R8 launch harness | §3 L170–177: test-only entries and DI, O under a real PTY via `/usr/bin/script`, static no-relaxation test; checks L104–111 | Closed |
| R9 verification gaps | Physical comparator (checks L45–49), credential absence (L35–36), pidversion case (L39–40) | Closed |
| N1–N16 | Mapped at §13 L429–430; each verified in place (e.g. N1 §7.2, N2 §5 L201/L209–210, N3 L205/L289, N4 L63–66, N5 L365–370, N6 L46–48/L117, N7 L93–94, N8 L111–112, N9 L277/L333, N10 L52–54, N11 L99–100/L418, N14 L324–325, N16 L16–17) | Closed |

The root's R6 core holds:
- an already-PAUSED row always goes through the accepted `policy_revise` no-op, then COMMIT;
- there is no closure after ROLLBACK (L249);
- the reread must match exactly and floors are strict (L181–188);
- an unknown acknowledgement latches (L262).

I checked this against the accepted routine (`202610111020:281–343`). With an unchanged row and `p_state='PAUSED'`, it
returns the current version with no fence or version change. One defect remains, RC2-R1.

## 4. Required findings

**RC2-R1 — The post-call check accepts an artificial revision of an already-PAUSED row (§6 L243–248).**

The postcondition is "PAUSED and *either* a no-op (version == expected, fence unchanged) *or* an applied revision
(version+1, stateReason OWNER, fence+1)". It does not tie the allowed branch to the state observed before the call.

The accepted routine treats the call as a no-op only if every argument is `IS NOT DISTINCT FROM` the locked row
(`202610111020:311–317`). If any preserved argument differs, an already-PAUSED row gets a real revision: version+1,
fence+1, an altered field, and stateReason forced to OWNER. The "either/or" check accepts that as
`revisionApplied:true`.

A concrete path to that difference exists: node-pg parses `timestamptz` into a JS `Date` with millisecond precision,
while `RemoteAskPolicy.expiresAt` is `Timestamptz(6)`. Reading the locked row into JS and passing `expiresAt` back
therefore truncates the microseconds. The result is exactly the "edit an unrelated field merely to manufacture a newer
receipt" that RC4 02:160–162 forbids, and that the root's R6 ("no artificial revision") excludes. For ACTIVE/INACTIVE
rows the same round-trip silently changes `expiresAt`.

The test "all other policy fields byte-equal" (checks L90) catches this only if the fixtures happen to have non-zero
microseconds.

Required:
- (a) Bind the branch to the locked pre-call state: PAUSED requires the no-op branch, and an applied revision → ROLLBACK, REFUSED `CONTAINMENT_UNCONFIRMED`; ACTIVE/INACTIVE requires the applied branch.
- (b) Pass every preserved argument straight from the locked row inside one SQL statement, e.g. `SELECT public.atlas_ask_remote_policy_revise(…, p."expiresAt") FROM public."RemoteAskPolicy" p WHERE …`. No JS round-trip.
- (c) Before COMMIT, E compares the whole post-call row with the pre-call row:
  - no-op: all columns equal;
  - applied: all columns except `policyVersion`, `state`, `stateReason`, `revisedAt` equal.
- (d) Tests with microsecond-precision `expiresAt` on both paths, plus an already-PAUSED row with a runtime `stateReason` (e.g. MODEL_MISMATCH) that the no-op path must keep unchanged.

**RC2-R2 — The native Unix PG fixture test does not pin the production end-to-end path (checks L112–117; §3 L175–177).**

The conditional test "runs the production UNIX_SOCKET path (reader, S bridge, E) end to end". It does not say that it
drives the production entrypoints with `productionDeps()` and no `tests/support` DI, under a real PTY and with the real
helper. A library-level, in-process variant would satisfy the current wording.

It also lets the test skip whenever `ATLAS_REVAL_NATIVE_PG_FIXTURE` is unset. The root has now supplied a fixture, and
its descriptor matches the closed shape. The root states that the candidate test must run the real PTY + C/S/E
production Unix path.

Required: when the descriptor is supplied, the native test must run the following production chain:
- the production `scripts/reval-server/owner.ts` under a real PTY via `/usr/bin/script`;
- the production controller with `productionDeps()`;
- the built API `main.js` in bridge mode;
- production `owner-exec.ts`;
- the built, pinned helper;
- a real 0600 owner config in a 0700 directory with realpath components and the recorded physical tuple.

It must cover:
- positive IDENTITY (`loadedBinding:'UNVERIFIED'`, ref `rsa-peertoken-unixphys-v1`);
- SNAPSHOT;
- PAUSE_EXPORT closure on both the applied and the already-PAUSED no-op paths;
- the socket, pid-file and OID mismatch negatives.

For the evidence run:
- set the env variable to the root's descriptor;
- treat a skip in that run as a failure;
- record the descriptor's sha256 and the PG version;
- label the result test-fixture evidence: never MEASURED, and not platform/image proof.

## 5. Nonblocking notes

- **NB-a — File names.** The cross-references don't match the repo: brief L6 names `RS_A_ACCEPTANCE_CHECKS_RC2.md` and checks L1 names `RS_A_IMPLEMENTATION_BRIEF_RC2.md`, but the repo files are `ACCEPTANCE_CHECKS.md` and `IMPLEMENTATION_BRIEF.md`. The unchanged RS-A `AGENTS.md` does not route to the checks file. The manifest binds the pair, so the root can resolve this in the ownership transfer or routing.
- **NB-b — Wall-clock deadline.** `deadlineEpochMs` (L232, L237) is a wall-clock value, and E's derived timeouts have no upper clamp (L225–226). Clamp them to ≤ the remaining C budget (≤ about 1400 ms), or send a relative remaining time. Otherwise a wall-clock step could leave an orphaned owner backend waiting on a lock beyond `D+1500 ms`.
- **NB-c — Workspace inverse.** §5 L212 lists `Workspace` among the models receiving inverse fields, but §5 declares no Workspace FK. Add only what drift actually requires.
- **NB-d — `apiEntry`.** The `server.apiEntry` config field (L91, L149) should be required to be the realpath of `dist/apps/api/src/main.js` inside the compared build manifest. Otherwise `buildManifestSha256` need not cover the launched entry.
- **NB-e — Password erasure.** "Owner password … zero-filled" (L240) covers only the Buffer; the string handed to node-pg stays until garbage collection (RC4 05:117). Don't imply erasure; record it as a residual.
- **NB-f — Rate wording.** At L279, the 275/825 rates are pinned by the *attempt* CHECK, not by any policy CHECK. Wording only.
- **NB-g — Launch depends on a snapshot.** Because of the build check (L111–112), LAUNCH requires a successful snapshot wrapper, so S cannot start without a registration and binding. That is consistent with A3; state it.
- **NB-h — Function stats.** `pg_stat_user_functions` (checks L91) needs `track_functions` enabled in the disposable DB; otherwise use the statement-capture seam.
- **NB-i — Test paths.** Test-created config and temp dirs must be realpaths: on macOS `/tmp` and `/var` are symlinks, which the "no symlinked components" rule refuses. The root fixture's paths already comply.

## 6. Classification and scope

- A1–A9 are unchanged and still within RC4.
- The new A10 (no attach mode, no positive IDENTITY without a server) is a stricter refusal and within RC4.
- Physically binding the S and E connections tightens RC4 01:105 and 06:42.
- The private frames and config are internal (A2).
- Always calling the accepted routine on an already-PAUSED row matches RC4 02:159 ("Already-PAUSED owner revision is a no-op").

Nothing here requires fresh Astra/Fable review. If RC2-R1/R2 are repaired as bounded text-only changes with a new exact
hash, this session can review the delta.
