# RS-D implementation report — part B (platform/egress/privacy proof adapters), rc1

Implementer: native `claude-opus-5-5` (Claude Code session), 2026-10-13. Brief: `IMPLEMENTATION_BRIEF_B.md` (rc1). Not an approval.
Gate: ONE independent native Opus 5.5 `max` review in a clean session (owner instruction); the project's Sol/Opus `xhigh` and
Astra/Fable gates are NOT run (recorded deviation). No paid/provider call, activation, account, customer data or deployment; the key
pass-through stays PENDING. No root/admin operation on the host (no pf, NetworkExtension or logging changes).

## 1. What changed
- **S under a pinned Seatbelt profile** (`packages/reval/platform.ts`, `launch.ts`, `deps.ts`, `server-link.ts`): C spawns S as
  `/usr/bin/sandbox-exec -p <profile> <node realpath> <entry>` (env/stdio unchanged; the exec keeps S's pid). Profile: allow default;
  deny IP network-outbound except localhost; deny network-outbound to the DNS resolver socket `/private/var/run/mDNSResponder`; deny
  process-exec except the node realpath and the pinned helper realpath (both validated, no quotes/whitespace/traversal). Seatbelt is
  inherited, so every descendant of S is under it. After S's peer proof and BEFORE the launch frame (S has not listened yet) C asks the
  helper's new closed mode `sandbox <pid>` and requires `sandboxed` and `resolverDenied` for S's verified pid; otherwise launch fails and
  S is killed. `ServerLink.enforcedNow()` re-checks (READY, same live child as the verified incarnation, helper answer now).
- **Native helper** (`native/reval-peer/peer.c`): `sandbox <pid>` (strict decimal pid, no fd) → one line
  `{"pid":N,"sandboxed":B,"resolverDenied":B}` from `sandbox_check(pid, NULL, 0)` and
  `sandbox_check(pid, "network-outbound", SANDBOX_FILTER_PATH, resolver socket)`; a missing process or an error answer is a nonzero
  exit, never "false". The `peer` mode is unchanged.
- **DRAIN process inventory** (carried RS-D-A F2; `eval-drain.ts`, `controller.ts`, `platform.ts` `dbInventory`): after census₂ C
  takes its own inventory — S enforced now AND every backend of the registered DB (autovacuum excluded) is the runtime role named
  `atlas-reval-s-runtime` or the reader role named `atlas-reval-c-reader`. Anything else or a failed read → DRAIN `UNKNOWN`.
- **PLATFORM_PROOF / PRIVACY_PROOF** (`proof-payloads.ts`, `privacy-scan.ts`, `eval-proofs.ts`; O→C and I→C, CONTROLLER): exact 05
  payloads, decoders enforce the 05 `countsAsVerifiedZero` rule (OFFLINE_SIMULATED never true). Platform: environmentId =
  registrationId, C's build digest, serverBootId, policy ref `rsd-seatbelt-s-loopback-nodns-execpin-v1` when enforced now (else
  `rsd-platform-policy-absent-v1`, processCoverage UNKNOWN), destination inventory digest (loopback API listener, DB endpoint, the two
  owner sockets, `dns: NONE`, provider `NONE_KEY_PENDING`), interval = C's verification of S → now, destinationCoverage UNKNOWN,
  unmeasuredProcessCount 4 (O, C, I, browser). Privacy: closed local scanner over every regular file of the owner config directory
  (canaries = every frozen question/rationale ≥12 chars, raw + JSON-escaped, from the pinned dataset files with digest checks, memory
  only), S's stdio (`ignore`), PG statement/parameter logging via `pg_settings`; six declared destinations outside C counted
  unreadable; counts only. Neither proof can be a verified zero on this platform.
- **Instrument**: identity pins RS-D-A rc2 (manifest + seal; acceptedLater overlay rule for the context map); candidate layer
  `RS-D-B`; `run.ts` `takeProofs` (command `proofs`, between cases only, max 64); receipt v5 = v4 + `proofs` (decoded again by
  `assertReceiptV5`; flags never upgraded); `ipc.ts` tables. RS-D-A rc2-N1: test for the immediate-POST continuity stop; rc2-N3: brief
  B §2.5 text (brief A is sealed).
- **Tests**: `tests/reval-platform.test.ts` (pinned profile text; on darwin a real probe under the profile: external IP, resolver and
  foreign exec EPERM, loopback allowed, the helper runs inside and agrees; unsandboxed and another profile → not enforced;
  `enforcedNow`), `tests/reval-proofs.test.ts` (05 rule, honest composition, scanner, canary digests, PG logging rule, ProofLink),
  `tests/reval-census.test.ts` (inventory INCOMPLETE/failed → UNKNOWN), `tests/pg/reval-census.pg.test.ts` (dbInventory on a throwaway
  DB: S/C only COMPLETE; other name, swapped roles, owner → INCOMPLETE), `tests/pg/reval-launch.pg.test.ts` (the production launcher
  via the test controller entry; unsandboxed S refused), `tests/pg/reval-segments.pg.test.ts` (owner connections short-lived so DRAIN
  can be QUIESCENT; a drain while an owner session is open is UNKNOWN; proofs + receipt v5), `tests/reval-instrument-run.test.ts`
  (proofs, receipt v5 tampering, in-flight block, rc2-N1), identity test (RS-D-A pinned, RS-D-B candidates).
- **Docs**: brief B, `rs-d/REVAL_RUNBOOK.md` RS-D-B section, `rs-c/INSTRUMENT_RUNBOOK.md` (DRAIN inventory, `proofs`, receipt v5),
  routing files.

## 2. Correction during implementation (measured, before any review)
The first rc1 draft denied `process-fork` and used it as the outside fingerprint. The segment E2E then failed at the handoff welcome:
S proves every handoff peer by spawning the pinned native helper (RS-C), so S must fork. `sandbox_check` cannot check `process-exec`
(−1 even unsandboxed), but it answers path-filtered `network-outbound`: the profile now denies the DNS resolver socket (meaningful —
the inventory has no DNS) and the helper checks that deny. Probed: under the profile the resolver socket gives EPERM, `localhost`
still resolves, `/bin/sh` exec gives EPERM, the helper runs (and is itself sandboxed); unsandboxed / another profile → `resolverDenied`
false. Brief B §1–§3 corrected accordingly.

## 3. Checks
Evidence `verification/stage5/S5ASKREMOTE_REVAL_RSDB_RC1_EVIDENCE/`, summary `…_RSDB_RC1_CHECKS.json` (2026-10-13T02:18–02:47Z).
| Check | Result |
|---|---|
| typecheck, ui:typecheck, schema:validate, api:build (both consoles), api:smoke, db:check:pg17, db:check:drift | pass |
| `cli.ts artifact-check` | ok, drift [], candidate RS-D-B `71ff2cdd…` accepted:false |
| unit (`tests/*.test.ts`) | 612: 603 pass, 8 fail (exactly the pre-existing RC5 identity-only set, diffed against RS-D-A rc2), 1 skipped |
| `test:pg` (Docker PG17 + native unix PG17 fixture) | 780/780 — incl. reval-launch (sandboxed S, unsandboxed S refused, both proofs via O), reval-census (dbInventory), reval-segments (QUIESCENT drains with the inventory across the boundary, proofs in receipt v5), NB7, native chain; no throwaway DB left |
| `test:ui` with `ATLAS_REVAL_E2E_200=1` | 90 passed (21.8 min); 200 COMMITTED, semantic MATCH, FX10 MISSING 15 |
| mutations (`mutations.txt`, harness `mutations-harness.py`) | 40/42 detected |

Mutation survivors (qualified):
- **B08** (helper reports an error answer of `sandbox_check` as false): an error for a LIVE pid cannot be provoked on this host; the
  fail-closed branch (exit 72) is code-reviewable only. A missing pid (exit 68) is tested.
- **B15** (C's DRAIN inventory without the `enforcedNow` re-check): a redundant layer — an S without the profile is refused before it
  listens (B09/B10 detected), Seatbelt cannot be removed from a running process, and DRAIN already needs both censuses from the same S
  incarnation (another S cannot answer on C's private channel). `enforcedNow` itself is unit-tested (B11/B12 detected).

During the mutation run the first harness invocation timed out at B07: the mutated helper did not compile and the platform test built
it after opening its loopback listener, so the failed test left the process alive. Fixed in the test (build first); the helper
mutations were made compilable (B07, B07b). The orphan unit-test process (no DB connection) was terminated.

## 4. Residuals
- No complete destination measurement and no verified zero here: Seatbelt denials are not countable, O/C/I/browser are unenforced, and
  a hostname-restricted provider allow is not expressible — provider egress needs a host-level layer on the target platform (tied to
  the PENDING key decision). Privacy stays incomplete (PG server logs, receipts, browser, TTY/history, swap/core, provider retention).
- `allow default` profile: S can still reach every loopback TCP port (other local services) and Mach services; a daemon reachable that
  way could act on S's behalf — part of why destination coverage is UNKNOWN. rc2 closed the unix-socket path (only the PG socket
  directory; Docker's API socket is unreachable) and the credential-read/tree-write paths. `sandbox-exec` is deprecated by Apple
  (it works; a removal fails closed: S would not launch).
- The helper's outside check proves "sandboxed + resolver denied" for S's pid, not the exact profile text (a profile denying only the
  resolver socket also passes — review N3); C applies the pinned text itself through argv. `application_name` in the DB inventory is
  self-declared by the client; the strong part is the role, whose secret files any same-uid process outside S can read (attribution is
  to the uid, carried RS-D-A residual).
- Zero destination counts under destinationCoverage UNKNOWN are void, not measurements (N4). The privacy scan is point-in-time (N5).
  Two frozen questions are shorter than 12 characters and are not canaries (N6: short strings would match unrelated text).
- DRAIN `UNKNOWN` whenever any other DB session is open (owner psql/maintenance) — operators must close them (runbook).
- Part C: integrated offline rehearsal over all segments, final instrument revision, build-inventory seal, swept-vs-expired,
  F_FULLFSYNC, T2, buildManifestSha256 binding, RS-C-C N2/N5.

## 5. rc2 repairs (review `docs/stage5/reviews/OPUS_S5ASKREMOTE_REVAL_RSDB_RC1.md`, CHANGES_REQUIRED: F1 Medium, F2–F4 Low)
- **F1** (C read the owner/runtime password files): `scanConfigDirectory(configPath, canaries, credentialFiles)` never opens the
  configured credential files — skipped by path (raw and realpath) and by dev/ino (hard links) using lstat/realpath only; they are one
  declared destination outside the scan (`OWNER_CREDENTIAL_FILES_NOT_OPENED`); symlinks stay unreadable, never followed. Detecting
  tests at the fs level: a spy on `fs`/`fs.promises` (ESM bindings re-synced) in the unit test (scanner and ProofLink) and in the
  test C entry (`fsSecretLog`) — the real chain's O-initiated (`reval-launch.pg`) and I-initiated (`reval-segments.pg`) privacy
  proofs open the reader file only.
- **F2** (collectionState from the reader's view): `readPgLogging(reader, roles)` adds `log_min_error_statement` (must be `panic`) and
  `debug_print_*` (off), and counts `pg_db_role_setting` rows that give the runtime or reader role (this DB or all) its own value of a
  checked setting; any → UNKNOWN. Declared scope: statement/parameter/error-statement logging; extension loggers are in the PG log
  files (outside); S's own session `SET` is inside its trust boundary. PG test: `ALTER ROLE <runtime> IN DATABASE … SET log_statement`
  is seen by the confined reader (throwaway DB). On a default PG (`log_min_error_statement = error`) the state is UNKNOWN.
- **F3** (05 minimum): `OUTSIDE_INSPECTION` now lists the 05 areas (16 destinations incl. DB rows, temp/spool, session recorders,
  clipboard managers, atomic-save leftovers, credential files); digest, tests and the runbook updated.
- **F4** (off-host packets): the unsandboxed and foreign-profile control runs of the platform probe never try 192.0.2.1; only the
  profiled run does (refused locally by Seatbelt). The B01 mutation run (profile without the IP deny) necessarily left the host once.
- **N1/N2** (profile surface): outbound unix sockets only under the registered PG socket directory; S cannot read the owner/reader
  credential files nor write the project tree, the helper or the credential files. Paths are realpaths (`serverSandboxPaths`; /var →
  /private/var), so the rules cannot silently miss. Probed on darwin (`reval-platform.test.ts`): PG-dir socket CONNECTED, another
  socket EPERM, credential read EPERM, tree write EPERM; the native unix-socket chain still works.
- **N7**: tests for the post-check READY guard of `enforcedNow`, for symlinks (unreadable), and `processInventory` moved from the
  controller to `platform.ts` with every failure/stall branch tested. **N8**: the PG logging read is bounded by the operation deadline.
  **N9**: brief/runbook place the helper check right after the peer proof (before the launch frame); native test title says v5;
  receipt directory outside the config directory. **N10**: `takeProofs` and `assertReceiptV5` require the run's own registrationId
  and serverBootId. **N6**: ASCII-only (`\uXXXX`) JSON forms are needles. **N3/N4/N5** stated as residuals above.

rc2 checks (evidence `verification/stage5/S5ASKREMOTE_REVAL_RSDB_RC2_EVIDENCE/`, summary `…_RSDB_RC2_CHECKS.json`, 04:00–04:29Z): typecheck,
ui:typecheck, schema, api:build, api:smoke, pg17, drift pass; `artifact-check` ok, drift [], candidate RS-D-B `98cf9bb2…`; unit 613: 604
pass, the same 8 RC5 identity-only failures, 1 skipped; `test:pg` 780/780 (fs-level credential spy in launch and segments, role-override
and inventory PG test, native unix-socket chain under the hardened profile); `test:ui` 90 passed, 200 COMMITTED; mutations 58/59 (the rc1
B-set adapted to the rc2 code + C01–C17 for the repairs; B07b and B33 survived the first run and are now detected by an added control
profile — denies other unix sockets but allows the resolver — and a mixed non-ASCII/escaped canary assertion; B08 stays qualified).
