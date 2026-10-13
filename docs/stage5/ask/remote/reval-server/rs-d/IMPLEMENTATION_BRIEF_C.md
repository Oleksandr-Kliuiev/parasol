# RS-D implementation brief — part C (integration, final instrument revision, offline rehearsal/runbook), rc1 (S5ASKREMOTE-REVAL-SERVER-RSD-C)

Status: written by the implementer (native `claude-opus-5-5`, Claude Code session) on 2026-10-13. This brief is NOT an approval.
Gate: ONE independent native Opus 5.5 `max` review in a clean session (owner instruction), bounded re-reviews in that session; the
project policy's Sol/Opus `xhigh` and Astra/Fable gates are not run — recorded deviation. Owner go-ahead for part C: 2026-10-13.
Out of bounds: any paid/provider call, activation, account, customer data, deployment; the key pass-through (PENDING); root/admin
host changes; edits to the frozen 01–06 or to any accepted seal/manifest/migration.

## 0. Identity and parents
- Architecture SERVER-DESIGN-rc4 (frozen); 05 row RS-D: "Complete process/egress/privacy proof adapters and integrated offline
  rehearsal/runbook — actual supported-platform preparation proof or explicit pending limitations; no simulated verified zeros".
- Parents: RS-D-B rc2 (seal `S5ASKREMOTE_REVAL_RSDB_APPROVED.json`, `carriedToRSDC`, `knownPostSealTestState`), RS-D-A rc2, RS-C-C rc2
  (`carriedToRSD`) and the earlier accepted parts. Owner decisions D1/D2 (`OWNER_DECISIONS.md`) stay in force.
- Baseline `verification/stage5/S5ASKREMOTE_REVAL_RSDC_BASELINE.sha256` (after the RS-D-B seal, before any RS-D-C edit).

## 1. Scope (IN)
1. **Final instrument revision.** `identity.ts` pins the RS-D-B manifest + seal (`ACCEPTED_RS_D_B_RC2`); RS-D-B joins the accepted
   chain (expected map, administrative deltas, rebuilt set, accepted-later overlay rule); candidate layer `RS-D-C`. FIRST: the identity
   test becomes seal-aware (RS-D-B `knownPostSealTestState`): before the part's seal it expects `accepted:false`, with a seal whose
   digest matches it expects `accepted:true` — never a test that fails by design after acceptance.
2. **Sealed build inventory** (RS-C-B/RS-C-C/RS-D-A carried item). `verification/stage5/S5ASKREMOTE_REVAL_RSD_BUILD_INVENTORY.json`
   lists every `dist/` output rebuilt from the accepted RS-B … RS-D-B `apps/api|packages` sources (minus outputs of RS-D-C candidate
   sources) plus the sealed measured console manifest, each with its sha256, generated from `npm run api:build` by a closed
   generator. The identity PINS these outputs (`BUILD_DRIFT` on any byte difference) instead of only recording a digest. The
   inventory file is an RS-D-C candidate path, so the RS-D-C seal seals it.
3. **Receipt v6** = v5 + `build` (`{ buildManifestSha256 }`, RS-C-C optional item): C's registered build digest from C's IDENTITY,
   asked ONCE per run (first GO or first `proofs`; rc2 — C computes it once at startup, and every IDENTITY re-proves S); every recorded
   PLATFORM_PROOF must carry the same digest (refused at take time; receipt unsafe otherwise). C's continuity-loss answers to that
   IDENTITY (and to the previous-terminal re-collection) are the persisted CENSUS_CONTINUITY_LOST stop (rc2 F1). Flags never upgraded.
4. **Swept vs expired-uncollected** (carried since RS-C-B; 06 frozen, so no new failure code): after a collected FINAL record, S's
   OBSERVATION_UNAVAILABLE is "swept"; an expired-uncollected record grows S's sticky `uncollectedTerminalCount`, which the RS-D-A PRE
   census gap check sees BEFORE any consumption. The run then stops with the distinct reason `TERMINAL_EXPIRED_UNCOLLECTED` (recorded in
   the receipt) instead of the generic census stop; tests for both paths.
5. **macOS F_FULLFSYNC** (carried): measured, not assumed — a darwin test interposes `fcntl`/`fsync` (DYLD interposer built at test
   time, Homebrew node is ad-hoc signed) and shows that C's journal append and the instrument's receipt write reach
   `fcntl(F_FULLFSYNC)` (libuv 1.52 uses it for `fsync`/`fdatasync` on Apple). No code change unless a path misses it.
6. **RS-D-B rc2 carried items.** N1: the PG socket rule allows exactly `<socketDir>/.s.PGSQL.<port>` (path literal), not the directory;
   N2: runbook — the owner config directory must be outside the project tree; N3: S can no longer write C's journal, the owner config
   file or C's instrument socket path (write-deny literals), nor rename/remove any directory above one of the named files or the project
   root (rc2 F4, rc3 F5; hard links to them are refused too — measured); the profile stays an egress floor plus direct-path denies under
   `(allow default)`, not the containment of a compromised same-uid S (declared limit, owner decision, §2); N4: policy ref `rsd-seatbelt-s-v2` (the profile text changed); N5: the
   logging-scope wording; N6: a detecting test for the (role, all databases) override branch.
7. **RS-C-C review N2.** The evaluation-header refusal on `/operator` paths carries the console's security headers (CSP, nosniff,
   frame denial) as well. RS-C-C N5 (receipt schema versioning) is closed by v4/v5/v6 naming.
8. **Integrated offline rehearsal** (05 RS-D). `tests/pg/reval-rehearsal.pg.test.ts` + driver: the real O (PTY) → C → S (pinned
   profile) chain and the real instrument code follow the WHOLE fixture-grouped order — all 200 frozen cases (incl. the 15 FX10
   MISSING), 11 segments, 10 boundaries — on the accepted OFFLINE scripted provider seam (no key, no network): `proofs` before the first
   GO and after every segment; at each boundary pause → owner closure → DRAIN QUIESCENT (with the inventory) → owner switch with S/C up
   (D2) → FIXTURE_CHECK → manual resume → re-PAIR; every case census MATCH, one guard epoch, receipt v6 checked. Paced by the accepted
   per-actor limit, so it runs only with `ATLAS_REVAL_REHEARSAL=1` (evidence run recorded separately in the checks).
9. **Operator runbook (final).** `rs-d/REVAL_RUNBOOK.md` gains the end-to-end R-EVAL procedure (preconditions, start, per case, per
   boundary, proofs, end, receipts, failure handling, cleanup) in Russian, plus the list of pending limitations; INSTRUMENT_RUNBOOK
   updated (receipt v6, expired-uncollected stop).
10. **Pair refresh inside a segment** (found by the integrated rehearsal, added in rc1 before review): S ends a browser pair at most 10
   minutes after the browser PAIR (04), a manual segment lasts longer. rc2 (F3/N3): the operator pastes the owner's PAIR_ACK
   (`pair-ack`); the pair lives at least until its `expiresAt` − 2 min + 10 min whatever the typing delay, and a GO is refused
   (`BLOCKED_PAIR_REFRESH_REQUIRED`, before consumption) once less than 200 s of that remain; the runbook describes the in-segment re-pair;
   the rehearsal exercises it.

## 2. Pending limitations (declared, not implemented here)
- **T2** (two instrument sockets not tied to one I process): binding them needs C's instrument peer identity at S (or S's at C), i.e.
  an extension of the frozen 06 PAIR/private-channel frames — an architecture change outside this part. Mitigation stays: both peers
  are proven same-euid, the pinned node executable, a TTY, never C or S.
- No verified zero on darwin (Seatbelt denials not countable; O/C/I/browser unenforced); provider egress needs a host-level layer on
  the target platform, tied to the PENDING key decision. Privacy proof incomplete by design (declared outside destinations, external
  retention evidence absent). Human attestation of labels and the owner data/budget admissions remain separate gates.
- D1 evaluation-validity residual (fixture confounded with order position).
- S profile limit (rc3): no containment of a compromised S against same-uid writes to files that unsandboxed components execute later
  (node toolchain, startup files); an allow-list write profile, protected toolchain prefixes or a separate uid is an owner decision.

## 3. Required checks
Typecheck, ui:typecheck, schema, api:build, `artifact-check` (candidate RS-D-C, build inventory pinned), api:smoke, unit (the 8
pre-existing RC5 failures only — the RS-D-B post-seal identity failure must be gone), pg17, drift, `test:pg` (Docker PG17 + native
fixture), `test:ui` with the 200-path E2E, the integrated rehearsal (`ATLAS_REVAL_REHEARSAL=1`), context budget, mutations of every
new rule. Each changed behaviour has a detecting test.

## 4. Allowed files
`scripts/reval-instrument/*`, `packages/reval/*`, `apps/api/src/{ask-http.ts,reval/*,operator/*}` (N2 only), `native/reval-peer/*`
(none expected), tests and test support, the rs-d/rs-c docs and routing files, the new verification receipts. Accepted
manifests/seals and frozen docs are never edited; the RC5 instrument is imported unchanged.
