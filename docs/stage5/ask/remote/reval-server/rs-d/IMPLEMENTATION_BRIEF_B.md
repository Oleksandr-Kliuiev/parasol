# RS-D implementation brief — part B (platform/egress/privacy proof adapters), rc1 (S5ASKREMOTE-REVAL-SERVER-RSD-B)

rc1 text corrected during implementation (before any review): the profile cannot deny fork (§1), so the outside check is the DNS
resolver deny; recorded in `IMPLEMENTATION_REPORT_B.md`. rc2 (after the independent review, `docs/stage5/reviews/OPUS_S5ASKREMOTE_REVAL_RSDB_RC1.md`):
§2.1 profile hardening (N1/N2) and check placement (N9), §2.3 zeros void (N4), §2.4 credential files never opened (F1), PG logging
rule (F2), the 05 destination minimum (F3), canary forms (N6), point-in-time scan (N5), §2.5 proof binding (N10).

Status: written by the implementer (native `claude-opus-5-5`, Claude Code session) on 2026-10-13. This brief is NOT an approval.
Gate: ONE independent native Opus 5.5 `max` review in a clean session (owner instruction), bounded re-reviews in that session; the
project policy's Sol/Opus `xhigh` (and Astra/Fable for architecture) gates are not run — recorded deviation.
Out of bounds: any paid/provider call, activation, account, customer data, deployment; the key pass-through (PENDING); root/admin
privileges on this host (no pf, no NetworkExtension, no system logging changes).

## 0. Identity and parents
- Architecture SERVER-DESIGN-rc4: 05 "Egress proof interface" (exact PLATFORM_PROOF), "Privacy proof and destination completeness"
  (exact PRIVACY_PROOF), "Independent process/ingress census"; 02 "Pause is not drain" (DRAIN process inventory); 06 rows
  PLATFORM_PROOF / PRIVACY_PROOF (O→C, I→C, CONTROLLER; closed local evidence adapters).
- Parents: RS-D-A rc2 (seal `S5ASKREMOTE_REVAL_RSDA_APPROVED.json`, `carriedToRSDB`) and the earlier accepted parts.
- Baseline `verification/stage5/S5ASKREMOTE_REVAL_RSDB_BASELINE.sha256` (after the RS-D-A seal, before any RS-D-B edit).

## 1. Findings on this platform (darwin/arm64, probes in the implementer session)
- `/usr/bin/sandbox-exec` (Seatbelt) applies a profile to a process and all its descendants; `(deny network-outbound (remote ip))
  (allow network-outbound (remote ip "localhost:*"))` gives EPERM for 192.0.2.1:443 and allows 127.0.0.1 (PG, local listeners);
  `(deny process-exec)` + `(allow process-exec (literal …))` limits what S and every descendant (the profile is inherited) may exec.
  The exec keeps the PID, so C's peer/PID binding of S is unchanged. S itself must fork: it spawns the pinned native helper for every
  handoff peer proof (RS-C), so a fork deny is NOT possible (measured: the first rc1 draft with `(deny process-fork)` broke the handoff
  welcome in the segment E2E). The helper runs under the inherited profile and works.
- The private `sandbox_check(pid, op, type, …)` answers from outside: `(pid, NULL, 0)` = sandboxed; with SANDBOX_FILTER_PATH (1),
  `("network-outbound", "/private/var/run/mDNSResponder")` = 1 under a profile that denies the DNS resolver socket, 0 unsandboxed.
  `process-exec` cannot be checked this way (−1 even unsandboxed). Under the profile the resolver socket gives EPERM, `localhost`
  still resolves (hosts file), `/bin/sh` exec gives EPERM.
- Seatbelt network denials were NOT found in the unified log (`log show`, no root): denied attempts cannot be counted, so destination
  coverage stays UNKNOWN. A hostname-restricted allow (`eu.api.openai.com:443`) is not expressible (only `*:port` or localhost); the
  provider path needs another layer (Azure NSG/Linux nftables/egress proxy) — tied to the PENDING key decision.

## 2. Scope
IN:
1. **S under a pinned Seatbelt profile.** C launches S as `/usr/bin/sandbox-exec -p <SERVER_SANDBOX_PROFILE> <node realpath> <entry>`
   (env and stdio unchanged). Profile (pinned text in `packages/reval/platform.ts`, the registration's realpaths substituted — a path
   outside `[A-Za-z0-9._/@+-]` refuses the launch): allow default; deny network-outbound to any IP except localhost; deny outbound unix
   sockets except under the registered PG socket directory (rc2, review N1: no Docker or other local daemon socket); deny the DNS
   resolver socket (the inventory has no DNS); deny reading the owner and reader credential files and writing the project tree, the
   helper and the three credential files (rc2, review N2); deny process-exec except the node realpath and the pinned helper realpath.
   Right after C's peer proof of S and before the launch frame (S has not listened yet) C asks the native helper (new closed mode
   `sandbox`, fd-less, argv `sandbox <pid>`) and requires `sandboxed` and `resolverDenied` for S's verified pid; otherwise launch fails
   and S is killed (rc2, review N9: not "after IDENTITY").
2. **DRAIN process inventory (carried F2).** DRAIN may be `QUIESCENT` only with C's independent inventory: S verified sandboxed with
   the profile's resolver deny (inherited by every descendant), the same S incarnation, and EVERY backend of the registered database attributable to a registered
   process — S (runtime role, `atlas-reval-s-runtime`) or C's own reader — with no other session (C's reader sees usename,
   application_name and pid of every session). Anything else, or an unreadable inventory → `UNKNOWN`.
3. **PLATFORM_PROOF (C, exact 05 payload).** environmentId = registrationId (the registered environment); buildManifestSha256 = C's
   digest; serverBootId; policyEvidenceRef `rsd-seatbelt-s-loopback-nodns-execpin-v1` when (1) is verified, else `rsd-platform-policy-absent-v1`;
   destinationInventorySha256 = sha256 of the canonical approved inventory (loopback API listener, the registered DB endpoint, the two
   owner unix sockets, provider `NONE_KEY_PENDING`); interval = S's verified start → proof time; processCoverage `COMPLETE` only when
   (1) holds for the whole interval (same incarnation), else `UNKNOWN`; destinationCoverage `UNKNOWN` (denials uncountable, other
   components unenforced); unexpected/unknown destination counts `0` (no destination measurement exists — a zero under UNKNOWN coverage is
   not a measurement, and every consumer — O output, receipts, part C — must treat it as void, rc2 N4); unmeasuredProcessCount = the network-capable registered components without platform enforcement (O, C, I, browser
   = 4); mode `MEASURED`; countsAsVerifiedZero by the 05 rule only (here always false). The decoder enforces: true requires MEASURED,
   both coverages COMPLETE, all counts 0 and the accepted policy ref; OFFLINE_SIMULATED is always false.
4. **PRIVACY_PROOF (C, exact 05 payload).** A closed local scanner (`packages/reval/privacy-scan.ts`): canaries = every frozen question
   and rationale (≥12 chars), raw, JSON-escaped and ASCII-only JSON-escaped (`\uXXXX`), loaded into memory from the pinned dataset
   files with digest checks (never argv/env/output); destinations C can inspect — every regular file in the config directory (config,
   journal; anything else new/unclassified), S's stdio (spawned `ignore`: no sink), the PG logging that applies to S's and C's sessions;
   the configured credential files are NEVER opened (frozen 01 / RS-A R9b; rc2, review F1) — skipped by path and dev/ino with lstat
   only and declared as one destination outside the scan; symlinks and other non-regular entries are unreadable, never followed.
   Declared destinations outside C's inspection, by the 05 minimum (rc2, review F3): DB attempt/counter/audit/security rows, PG server
   log files, PG backups/replicas, service/proxy/APM/diagnostics, crash/core/heap dumps, temp/spool files, session recorders, swap and
   hibernation, browser profile/storage/devtools, browser extensions/telemetry/recording, clipboard managers, TTY capture/shell
   history/argv, instrument receipts/replay/export, atomic-save leftovers outside the config directory, provider retention, the
   credential files — each counted unreadable. Counts only: covered, unreadable, newUnclassified (a config-dir file outside the closed
   name set), forbidden matches, metadata violations (journal lines that are not exact safe records); collectionState
   `DISABLED_AS_REQUIRED` only when (rc2, review F2) `log_statement` none/ddl, `log_min_duration_statement`/`_sample` −1,
   `log_transaction_sample_rate` 0, `log_parameter_max_length_on_error` 0, `log_min_error_statement` `panic` (the error-statement log
   is off — a default PG has `error`, so it is UNKNOWN there), `debug_print_parse/rewritten/plan` off, AND no `pg_db_role_setting` row
   gives S's runtime role or C's reader role (in this DB or all) its own value of any of them; it covers PG statement/parameter/
   error-statement logging only (extension loggers such as auto_explain are in the PG server log files, outside), and a session-level
   `SET` by S is inside S's trust boundary (superuser-set settings). The read is bounded by the operation deadline (rc2 N8). The
   scan is ONE point-in-time scan at the proof instant, reported over the platform interval (rc2 N5).
   externalRetentionEvidenceRef null; mode `MEASURED`; countsAsVerifiedZero by the 05 rule (here false).
   scannerManifestSha256 = sha256 of the scanner source + the canary-set digest. Nothing matched is ever copied or printed.
5. **Instrument.** Identity revision pins RS-D-A (manifest + seal; `rs-d/REVAL_RUNBOOK.md` becomes pinned, rc2-N2); candidate layer
   `RS-D-B`. Command `proofs` takes PLATFORM_PROOF and PRIVACY_PROOF (I→C) and records them; receipt v5 = v4 + `proofs` (exact
   payloads, the case after which they were taken; bound to the run's own registration and S boot, at take time and in the receipt —
   rc2 N10); flags never upgraded. rc2-N1 of RS-D-A: a test for the immediate-POST continuity
   stop. rc2-N3 of RS-D-A (brief A is sealed, so the text lives here): every receipt `drains` entry (v4 and v5) carries
   `closurePolicyVersion` and `closureFenceEpoch` of the confirmed closure it was taken for (null outside a boundary); the segment
   boundary rule requires a QUIESCENT drain bound to BOTH.
6. O prints both proofs (decoders); `codes.ts` enables PLATFORM_PROOF/PRIVACY_PROOF.
OUT (part C): integrated offline rehearsal over all segments, final instrument revision, build-inventory seal, swept-vs-expired,
F_FULLFSYNC, T2, buildManifestSha256 binding of the receipt.

## 3. Required checks
Unit/PGlite, typecheck, builds, `test:pg` (Docker PG17 + native fixture), `test:ui` with the 200-path E2E, context budget, mutations.
New proofs: decoders (every countsAsVerifiedZero rule); scanner (a canary planted in a config-dir file is counted, never echoed; an
unknown file is unclassified; a malformed journal line is a metadata violation); DRAIN UNKNOWN with a foreign DB session / an unsandboxed
S; the helper `sandbox` mode (darwin); the real chain (launch test) shows S sandboxed (external IP, resolver and foreign exec denied)
and both proofs via O; the segment E2E still crosses the boundary (DRAIN with the inventory); receipts carry proofs.

## 4. Residuals
- No complete destination measurement or verified zero on this platform (denials uncountable; browser/O/C/I unenforced); provider egress
  needs a host-level layer on the target platform. Privacy proof stays incomplete (external retention, PG logs, browser, TTY outside C).
- The sandbox binds S's process tree; a compromised kernel/root/owner remains outside the trust boundary (05).
