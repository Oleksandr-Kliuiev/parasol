# Independent checkpoint review — S5ASKREMOTE-REVAL-SERVER-RSD-B rc1 (RS-D part B: S Seatbelt profile, DRAIN process inventory, PLATFORM_PROOF/PRIVACY_PROOF, instrument proofs + receipt v5)

Date 2026-10-13. Reviewer: native Claude `claude-opus-5-5`, launched through the Claude Code Agent tool with a fresh context at the
requested effort `max` (the effort setting cannot be confirmed from inside the session). Gate: owner instruction — ONE independent
Opus 5.5 `max` review per RS-D part (recorded deviation from the Sol/Opus `xhigh` and Astra/Fable gates; not re-judged here).
Disclosure: this session's scratchpad path carries the host session id `d0382327-…`, which also holds implementer files (I saw names
in a directory listing, e.g. `rsdb-notes.md`, `review-prompt-rsdb.md`, `rsdb-mutations.py`; I did not open them). My first two scratch
files (`current.sha256`, `ac1.json`) were written at the scratchpad top level before I moved them to `scratchpad/rsdb-review/` (had a
same-named implementer scratch file existed, it was overwritten). No implementer conversation, no other reviewer's verdict.

Verdict (rc1): CHANGES_REQUIRED

One Medium finding (PRIVACY_PROOF makes the resident controller read the owner and runtime password files — frozen 01 and the accepted
RS-A R9b rule broken, and the existing guard test is blind to it) and three Low findings (collectionState read from the wrong session;
privacy inventory narrower than the 05 minimum without saying so; a unit probe connects off-host without the profile). Everything else
checked holds: exact 05 payloads and the countsAsVerifiedZero rule in both decoders and producers; S is under the pinned profile from
exec and checked from outside before it listens; an unsandboxed, foreign-profile, exited or replaced S cannot yield `processCoverage
COMPLETE`, the server policy ref or a QUIESCENT DRAIN; DRAIN inventory semantics; emitters/directions; receipt v5 allowlist with constant
flags; identity chain (RS-D-A pinned, RS-D-B candidate layer); rc2-N1 test; rc2-N3 text.

## Identity (recomputed)

| Item | Result |
|---|---|
| Baseline `S5ASKREMOTE_REVAL_RSDB_BASELINE.sha256` | sha256 `ab83797a…f2a9` = manifest `baselineFileSha256` |
| Completeness (`git ls-files -co --exclude-standard` vs baseline) | exactly the 34 changed + 8 added manifest files (+ the excluded RSDB receipts); 0 removed; every per-file baseline/current hash matches |
| **packageHash** (manifest rule) | **`ae5068f99e2a91f8e56e689e18b0e76005e481ccd7050e15c1bae731422cb06b`** — recomputed from disk at start and again at the end (after my mutations) |
| Manifest / checks files | `abc183e9…aea6b` / `c19f0d47…18d3c`; all 16 evidence log hashes match `logs` |
| Evidence window 02:18:09Z–02:47:27Z | after the last source edit (`receipt.ts` 02:17:37Z); only the report was written later |
| `cli.ts artifact-check` (my runs, start and end) | ok, drift [], 2037 files; candidate RS-D-B **`71ff2cdd94aed72624a7e1c49f765ab13bbc4d149eb2284a7ea89582450c9ebf`**, accepted:false; anchors `rsdaManifest 38361d6b…` / `rsdaSeal 5e0de7a8…` equal the files |
| Drift probe (item 5) | appended a comment to `packages/reval/eval-census.ts` (RS-D-A-pinned, not a candidate path): `ok:false`, drift `[SOURCE_DRIFT]`, revision null; restored, sha `4065ed2a…` verified |

## Findings (required)

**F1 — Medium — PRIVACY_PROOF makes resident C open and read the owner (table-owner) and runtime password files.**
`packages/reval/privacy-scan.ts:78-101` reads every regular file under the config directory (`readFileSync`, :93; its own known set
:80 names `secrets/runtime` and `secrets/owner`), called by `eval-proofs.ts:48` on every O→C (`controller.ts:279-281`) and I→C
(`eval-controller.ts:187`) PRIVACY_PROOF. Frozen 01 (`01_CONTROL_AND_IDENTITY.md:47-50`): table-owner authentication "must never enter
C's process heap"; 05 Roles row: owner login "absent from resident C/I/S state"; accepted RS-A brief :97-98 "C never opens
`secretFiles.runtime/owner` … the only credential value in C is the reader password" (ACCEPTANCE_CHECKS R9b). Brief B §2.4 lists
"secrets" among scanned files without declaring a deviation (a part brief cannot relax 01). Scenario: the instrument — a lower
principal — or O runs `proofs`/`privacy-proof`; C loads the owner DB password into V8 strings that cannot be wiped, so a heap/core dump
or a later memory disclosure of C exposes the table-owner credential. Demonstrated with an fs spy around the exported scanner on a
synthetic config dir: it opened `owner.json, secrets/owner, secrets/reader, secrets/runtime`. Not detected today:
`tests/pg/reval-launch.pg.test.ts:56` issues `privacy-proof`, yet :124 ("C reads only the reader secret") passes because it logs only
the DI `readSecret` seam. **Required fix:** never open the configured `secretFiles` (match path and dev/ino; lstat only), count them as
a declared credential destination outside the scan, update the inventory digest/runbook, and add an fs-level detecting test that no
O- or I-initiated PRIVACY_PROOF opens `secretFiles.runtime/owner`.

**F2 — Low — `collectionState: DISABLED_AS_REQUIRED` is derived from C's reader session, not from what applies to S.**
`privacy-scan.ts:54-65,111` read `pg_settings` on the reader connection. PG applies per-role and per-role-in-database defaults
(`pg_db_role_setting`) at session start: `ALTER ROLE <runtime> SET log_statement='all'` makes every S statement plus parameters
(`log_parameter_max_length` default −1) reach the server log while the reader still sees none/−1/0, so the proof claims
DISABLED_AS_REQUIRED unmeasured. `log_parameter_max_length_on_error` is USERSET (context `user` on the Docker PG17) and can differ per
session. `pg_db_role_setting` is PUBLIC-readable (`=r` ACL observed), so C can check it independently. 05 also names DB "error" logs;
`log_min_error_statement` (default `error`) is neither checked nor declared. **Fix:** require no logging-enabling override of the checked
GUCs in `pg_db_role_setting` for (runtime role, this DB) and (runtime role, all DBs), else UNKNOWN; decide and declare the error-log
treatment; state in brief/runbook that collectionState covers PG statement/parameter logging only and that S's own session `SET` is
inside S's trust boundary.

**F3 — Low — the declared privacy destination inventory is narrower than the 05 minimum, undeclared.**
`privacy-scan.ts:22-27` (`OUTSIDE_INSPECTION`, `INSPECTED_SETTINGS`, `PRIVACY_INVENTORY_SHA256`); brief B §2.4/§4; report §4. 05
("Include at least", `05_PROOFS_AND_ACCEPTANCE.md:96-100`) lists DB "new attempt/counter/audit/security rows", process/host
"temp/spool files, session recorders", browser "clipboard managers", CLI "temporary/atomic-save leftovers": none is scanned, counted
unreadable or named in the residuals, so the inventory digest and coverage counts describe less than 05 requires. (No false verified
zero is possible — unreadable ≥ 6 — hence Low.) **Fix:** add them (outside inspection unless scanned) or justify each as N/A in the
brief; update digest, tests and the runbook residuals.

**F4 — Low — `tests/reval-platform.test.ts` connects to 192.0.2.1:443 without any profile.**
The PROBE's external connect (:29) also runs in the unsandboxed control run (:76). Here the route to 192.0.2.1 is the default gateway
(`route -n get`: en0 via 192.168.1.1), so every `npm test` emits real TCP SYNs off-host — contrary to the owner probe constraint
("192.0.2.1 (denied locally)") and the test's own header (:18-19). **Fix:** skip the external connect in the unsandboxed control
(assert exec/resolver only) or run the control under a remote-IP-deny profile; declare that the B01 mutation run necessarily leaves the
host once.

## Optional / non-blocking

- **N1** Profile surface is wider than the inventory: every loopback TCP port and every unix socket except the resolver are reachable
  (my probe: another loopback port and another unix socket CONNECTED), plus Mach services. On this host Docker Desktop's API socket
  (`/var/run/docker.sock` → `~/.docker/run/docker.sock`, user-owned) is reachable from S and can start a container with full network.
  Report §4 names only "other local IPC (e.g. Mach services)"; name loopback services and unix sockets too. Hardening: allow outbound
  unix sockets only to the PG socket dir and the two owner sockets; loopback only to the registered DB port (TCP seam) or no IP at all
  for the unix-socket production endpoint. `sandbox-exec` is deprecated by Apple (works; a removal fails closed).
- **N2** `allow default` leaves S's files unrestricted: S can read `secrets/owner`/`secrets/reader` and write the pinned helper binary,
  C's sources and the journal. Inside S's trust boundary today; a small `file-read*`/`file-write*` deny set would close it cheaply.
- **N3** The outside check is not profile-specific — demonstrated: a profile that only denies the resolver socket answers
  `{"sandboxed":true,"resolverDenied":true}` (declared residual). Optional: a per-launch random literal deny checked with
  SANDBOX_FILTER_PATH would bind the answer to C's own launch.
- **N4** `unexpected/unknownDestinationCount '0'` under `destinationCoverage UNKNOWN` (`platform.ts:89`) are not measurements (declared
  in brief §2.3), but O output and receipts carry bare zeros and the RU runbook does not say so; part C consumers must treat them as
  void. `unmeasuredProcessCount` counts unenforced components (4); S's destinations are not measured either (05 word "unmeasured").
- **N5** The privacy proof is one scan at `intervalEnd` although it reports an interval from S's verification; 05 asks for before/after
  scans. INSTRUMENT_RUNBOOK step 10 should add a `proofs` before the first GO and say each is point-in-time.
- **N6** Canaries: 2 of 200 questions are shorter than 12 characters (no canary); `\uXXXX`-escaped forms of the 102 questions with
  non-ASCII characters (e.g. ensure_ascii writers) are not needles.
- **N7** Untested fail-closed branches (my survivors): R2 non-regular/symlink entries read instead of unreadable
  (`privacy-scan.ts:91`); R3 the post-check READY guard (`server-link.ts:156`); R4 controller-level inventory failure/timeout →
  INCOMPLETE (`controller.ts:137-139`; B14 covers only the eval-drain hook). The B08/B15 qualifications are accepted.
- **N8** `readPgLogging` (`privacy-scan.ts:56-61`) is not bounded by the operation deadline (other reader awaits are); a stalled reader
  would hold C's serialized queue for O and I. The scan runs synchronously on C's event loop (fine at current sizes).
- **N9** Docs: brief B §2.1 (:39) and REVAL_RUNBOOK RS-D-B (:144 "После IDENTITY") place the helper check after IDENTITY; the code
  checks earlier — right after the peer proof, before the launch frame (`server-link.ts:64-67`), as report §1 says. The native chain
  test title still says "receipt v4" (`tests/pg/reval-native-instrument.pg.test.ts:39`) while asserting v5. No receipt-dir location
  guidance: a receipt dir inside the config dir is scanned (newUnclassified) and also counted outside.
- **N10** `takeProofs` (`run.ts:171-186`) and `assertReceiptV5` (`receipt.ts:94-98`) do not bind `environmentId`/`serverBootId` of a
  proof to the run's connection; a proof spliced from another boot validates (only the segments test checks equality).

## What I checked and how

- Contracts: 05 census/egress/privacy/acceptance, 02 "Pause is not drain", 06 roles/emitters/command table, 01 resident credential;
  brief B, report B, REVAL_RUNBOOK RS-D-B and INSTRUMENT_RUNBOOK (Russian, steps 8-11); RS-D-A seal `carriedToRSDB`.
- Code read in full: `platform.ts`, `privacy-scan.ts`, `proof-payloads.ts`, `eval-proofs.ts`, `eval-drain.ts`, `server-link.ts`,
  `launch.ts`, `deps.ts`, `controller.ts`, `owner-cli.ts`, `codes.ts`, `peer.c`, instrument `run.ts` (proofs/finish), `receipt.ts`,
  `ipc.ts`, `identity.ts`, `candidate.ts`; new/changed tests and the test controller entry (production launcher, `noSandbox` seam only
  in `tests/support`).
- Payloads: both key lists equal 05 exactly; decoders enforce `countsAsVerifiedZero` by equality with the 05 rule (platform true needs
  MEASURED, both COMPLETE, three zero counts, the server policy ref; privacy true needs MEASURED, covered>0, four zeros, DISABLED,
  non-null external ref; OFFLINE_SIMULATED never true); producers compute the same rule; neither can be true here.
- Platform probe (own script, production `serverSandboxArgv`; external connects only inside the profile): TCP 192.0.2.1:443 EPERM,
  UDP 192.0.2.1:53 EPERM, resolver EPERM, `/bin/echo` and `sandbox-exec` exec EPERM, node exec OK, the helper inside answers
  sandboxed+resolverDenied, a child node inherits; outside check boxed `{true,true}`, plain `{false,false}`.
- Helper `sandbox` mode: pid 1, root daemons and a missing pid → exit 68; `0`, `-1`, `abc`, `012`, `2147483648` → 64; own pid → one line.
- Pid/incarnation: the check runs after the peer proof with a channel-closed guard; READY only for a live child; `enforcedNow` needs
  READY, `facts.pid === child.pid`, exitCode null, the helper answer, READY again; no relaunch exists; a pid is reusable only after the
  reap that sets LOST — no path to COMPLETE/QUIESCENT for an exited or replaced S.
- DRAIN: `composeDrain` is UNKNOWN unless inventory COMPLETE; inventory = `enforcedNow` ∧ `dbInventory`; a foreign role, the owner/E,
  the verifier (runtime role, verifier name) and swapped names count; the NULL-usesysid exclusion matches autovacuum for a
  non-privileged reader.
- Commands (all pass): focused units `reval-{proofs,census,instrument-run,instrument-census,eval-controller,protocol}` 41/41;
  `reval-platform` two non-network tests 2/2 (darwin probe test not run: F4 — replaced by my probe); `reval-instrument-identity` 2/2;
  `context-budget` 1/1; `tsc --noEmit` exit 0; PG `reval-census.pg` 3/3, `reval-launch.pg` 7/7, `reval-segments.pg` 1/1 (186 s:
  13 FX07 + 2 FX05, boundary DRAIN QUIESCENT INTACT with the inventory, PROOFS line, receipt v5). No throwaway DB left.
- Mutations (one at a time, restored and sha-verified; `scratchpad/rsdb-review/mut.py`): R1 rc2-N1 immediate-POST continuity stop
  removed → DETECTED; R2, R3, R4 → SURVIVED (N7). Restores changed only mtimes of `run.ts`, `privacy-scan.ts`, `server-link.ts`,
  `controller.ts`.
- Evidence: unit failing set identical to RS-D-A rc2 (the 8 RC5 identity-only tests); test-pg 780/780; test-ui 90 passed incl. 200
  COMMITTED / FX10 MISSING 15; mutations 40/42. Not re-run: full `test:pg`, `test:ui`, full unit suite.
- Files: all 42 package files ≤ 500 lines (hard cap 700).

## Residuals I accept

- No complete destination measurement and no verified zero on darwin (Seatbelt denials uncountable; O/C/I/browser unenforced);
  provider egress needs a host-level layer on the target platform, tied to the PENDING key decision. Honestly stated.
- The outside check proves "sandboxed + resolver denied" for S's pid, not the exact profile; C applies the pinned profile itself (N3).
- DB inventory attribution is role + application_name; the role secrets are files any same-uid process (and S under `allow default`)
  can read, so attribution is to the uid, not the process — carried RS-D-A residual.
- `processCoverage COMPLETE` rests on Seatbelt inheritance, not on observing S's process starts/exits; work a daemon does on S's behalf
  is outside it (N1).
- DRAIN is transiently UNKNOWN while any owner/executor/verifier backend is still visible (fail-closed; operators close and retry).
- Privacy stays incomplete (PG logs, receipts, browser, TTY, swap/core, provider retention, plus the F3 items once declared).
- Part C items (integrated rehearsal, final revision, build-inventory seal, swept-vs-expired, F_FULLFSYNC, T2, buildManifestSha256
  binding, RS-C-C N2/N5). Owner constraints held: D1/D2 in force, key PENDING, no provider/paid call, no root/pf/logging change.

Process note: while counting canary coverage, one of my checks printed the two corpus questions shorter than 12 characters into this
review session's tool output; no other corpus text was displayed, and none appears in this report.

---

## rc2 re-review (bounded, same reviewer session)

Date 2026-10-13 (04:30–04:50Z). Same reviewer and session as rc1; bounded to the rc1→rc2 delta, the findings F1–F4 and the
implementer's N items. Only this section was added to this file.

Verdict (rc2): APPROVE_RS_D_B

F1–F4 are closed, each with a detecting test that I re-ran myself (F1 also by a real-chain mutation). The profile hardening (rc1 N1/N2)
holds under my own probes and breaks nothing S needs: Docker PG over TCP, the native unix-socket chain, the handoff socket and the
helper all still work. The remaining observations are optional (rc2-N1…N6 below).

### Identity (recomputed)

| Item | Result |
|---|---|
| Manifest `S5ASKREMOTE_REVAL_RSDB_RC2_MANIFEST.json` / checks | sha256 `45d5df36…14e0` (as stated) / `5975f4e8…9b3e9b`; all 16 evidence log hashes match |
| **packageHash** | **`93eb7e0fbb1a7db0893202d78bc05451af8f7157eb884fdeea8287e634843e26`** — recomputed from disk at start and after my mutations; 35 changed + 8 added files exactly vs the baseline, 0 removed |
| rc1→rc2 delta | exactly the 22 files stated (no frozen 01–06 file, no other file) |
| Evidence window 04:00:03Z–04:29:27Z | after the last source edit (`candidate.ts` 03:59:57Z); the unit failing set is identical to RS-D-A rc2 (8 RC5 identity-only tests); test-pg 780/780; test-ui 90 passed, 200 COMMITTED |
| `cli.ts artifact-check` (my runs, start and end) | ok, drift [], candidate RS-D-B **`98cf9bb206f57e7c747b1b299880e9db297bd957cd2ec4c4274f0ba6e5568b30`**, accepted:false |

### rc1 findings

- **F1 — CLOSED.** `scanConfigDirectory(configPath, canaries, credentialFiles)` (`privacy-scan.ts:99-135`) identifies the configured
  credential files by raw path, realpath and dev/ino using `lstat`/`realpath` only, skips them before any open, and counts them as the
  declared destination `OWNER_CREDENTIAL_FILES_NOT_OPENED`. Symlinks and other non-regular entries are counted unreadable and never
  followed. Detecting tests:
  - unit fs spies (scanner, including a canary planted in the owner file and in a hard link to it; ProofLink);
  - the test C entry's fs/fs.promises spy, asserted for an O-initiated proof (`reval-launch.pg.test.ts:126`) and I-initiated proofs
    (`reval-segments.pg.test.ts:134`).
  My mutation R5 (ProofLink passes no credential files) is DETECTED by the real-PTY launch test with exactly "C never opens
  secretFiles.owner/runtime".
- **F2 — CLOSED.** `readPgLogging(reader, roles)` (`:71-81`) checks nine GUCs, adding `log_min_error_statement` (must be `panic`) and
  `debug_print_*`. It counts `pg_db_role_setting` rows that give the runtime or reader role its own value of any of them, in this
  database or all; any such row → UNKNOWN. The read is bounded by the operation deadline (`eval-proofs.ts:50`). The PG test shows the
  confined reader sees `ALTER ROLE <runtime> IN DATABASE … SET log_statement`. A default PG is honestly UNKNOWN; my segments run shows
  `privacy=UNKNOWN`. The declared scope (statement/parameter/error-statement logging; extension loggers live in the PG log files,
  outside the scan) matches the code.
- **F3 — CLOSED.** `OUTSIDE_INSPECTION` (`:24-31`) has 16 entries covering every 05 "Include at least" area. The inventory digest,
  tests, brief §2.4 and the RU runbook are updated.
- **F4 — CLOSED.** Only the profiled probe run tries 192.0.2.1, where Seatbelt refuses it locally; the unsandboxed, foreign-profile and
  near-profile control runs report `NOT_TRIED`. I ran `tests/reval-platform.test.ts` in full this time. The B01 mutation's one
  off-host attempt is declared.
- **rc1 N items:**
  - N7: my rc1 survivors R2 (symlink read), R3 (post-check READY) and R4 (inventory failure → COMPLETE, now in `processInventory`) are
    all DETECTED now.
  - N8: the PG logging read is bounded (C08).
  - N9: docs and the native test title are fixed.
  - N10: proof binding is checked at `takeProofs` and in `assertReceiptV5` (C14/C15 detected).
  - N6: the `\uXXXX` canary forms are added.
  - N3/N4/N5 and the short questions are stated as residuals (report §4, brief §2.3/§2.4, INSTRUMENT_RUNBOOK step 10 "ПЕРЕД первым
    GO", receipt dir outside the config dir).

### Profile hardening (rc1 N1/N2) — regression check

My own probe used the production `serverSandboxPaths`/`serverSandboxArgv` on a synthetic layout, with relative socket paths.

What S still has:
- a PG-dir socket and a socket in its subdirectory: CONNECTED;
- runtime secret read: OK;
- a unix socket bound in a directory outside the tree: BOUND.

What is denied (EPERM):
- another unix socket;
- reading the owner or reader secret, including `stat`;
- a hard link to the owner secret, and a clone/copy or rename of it;
- reading through a symlink to it (the symlink itself may be created);
- write or mkdir in the project tree;
- binding a socket inside the tree;
- `/bin/echo` exec.

Every S path the PG tests exercise still works under the profile: `reval-launch.pg` 7/7, `reval-census.pg` 3/3, `reval-segments.pg`
1/1 (QUIESCENT boundary DRAIN, proofs, fs spy), and the native unix-socket production chain
`reval-native-instrument.pg` 1/1 (receipt v5). No privilege was needed and no system setting changed.

### Optional / non-blocking (rc2)

- **rc2-N1** The PG allow is a `subpath` (`platform.ts:44`). With a shared socket directory — Homebrew PG's default `/tmp` →
  `/private/tmp` — every socket under it, e.g. a tmux server's, is reachable from S, so the runbook's "сокет … других локальных служб
  недоступен" holds only for a dedicated directory (the native fixture uses one). Probed on this host:
  `(remote unix-socket (path-literal "<socketDir>/.s.PGSQL.<port>"))` admits exactly the PG socket (a sibling-subdirectory socket is
  EPERM). Either use it, or require a dedicated socket directory in the runbook.
- **rc2-N2** The owner config directory must lie outside the project tree: S binds `reval-handoff.sock` there, and a bind under the
  write-denied tree is EPERM (probed). This fails closed — S never listens — but the runbook does not say it.
- **rc2-N3** S can still write elsewhere in the owner config directory (C's journal, the `reval-instrument.sock` path). This is inside
  S's trust boundary; optionally limit those writes to the handoff socket.
- **rc2-N4** `SERVER_POLICY_REF` is still `…-v1` (`proof-payloads.ts:9`) although the pinned profile text changed in rc2. A ref per
  profile revision would let a proof name its policy revision (05 "policy revision").
- **rc2-N5** `privacy-scan.ts:68` and brief §2.4 (:77) call the checked settings "superuser-set". On PG17
  `log_parameter_max_length_on_error` and `debug_print_*` have context `user`. The conclusion stands (S's own `SET` is inside S's
  boundary; persisted role overrides are counted), but the parenthetical is inaccurate.
- **rc2-N6** The (role, all databases) override branch has no detecting test: my mutation R6 (only `setdatabase = this DB`) SURVIVED
  `reval-proofs` and the PG inventory/override test. The code is right; add an `ALTER ROLE <runtime> SET …` case (no `IN DATABASE`).

### Commands and mutations (rc2)

- Commands I ran:
  - unit `reval-{proofs,platform,census,instrument-run,instrument-census,eval-controller,protocol,instrument-identity}` +
    `context-budget`: 48/48;
  - PG: `reval-census.pg` 3/3, `reval-launch.pg` 7/7, `reval-segments.pg` 1/1 (186 s), `reval-native-instrument.pg` 1/1 (native
    fixture);
  - `artifact-check` at start and end.
- No throwaway DB was left on the Docker PG.
- Not re-run: the full `test:pg`, `test:ui` and full unit suite (they are in the evidence).
- Mutations (one at a time, restored and sha-verified; `scratchpad/rsdb-review/mut.py`):
  - R5 — DETECTED (fs-spy assertion);
  - R6 — SURVIVED (rc2-N6);
  - R2/R3/R4 re-run — DETECTED.
- Restores touched mtimes only; the final packageHash and candidate digest are unchanged.
- Residuals accepted: as rc1, with report §4 rc2 wording (loopback TCP ports and Mach services still reachable; unix-socket,
  credential-read and tree-write paths closed; outside check not profile-specific; uid-level DB attribution; void zeros; point-in-time
  privacy scan; short questions not canaries).
