# R-EVAL RS-A server library routing

Normative: `docs/stage5/ask/remote/reval-server/rs-a/IMPLEMENTATION_BRIEF.md`, `ACCEPTANCE_CHECKS.md`, `VERIFICATION_ADDENDUM.md`
(root-owned; do not edit). Architecture parent: SERVER-DESIGN-rc4 (frozen).

- `controller.ts` (C) + `deps.ts` (productionDeps only), `server-link.ts` (S launch/IDENTITY), `pause.ts` (PAUSE_EXPORT), `owner-exec.ts` (E).
- `owner-cli.ts` (O, TTY only), `launch.ts` (exact child env/argv, declared-set digests).
- Protocol: `frame.ts`, `envelope.ts`, `private-frames.ts`, `codes.ts`, `scalars.ts`, `channel.ts` (strict private phases).
- Deadlines: `deadline.ts` — ONE absolute per-operation instant bounds every await; abandoned work never acts again.
- Evidence: `payloads.ts`, `snapshot-reader.ts`, `closure.ts`; binding: `physical.ts`, `peer.ts`, `secret-file.ts`, `config.ts`.

Rules: no TCP/TTY/peer relaxation, no test imports (tests/reval-static.test.ts); loadedBinding stays UNVERIFIED; the owner
credential never enters C; no retry after commit uncertainty. Tests: `tests/reval-*.test.ts`, `tests/pg/reval-*.pg.test.ts`.

RS-B (`docs/stage5/ask/remote/reval-server/rs-b/IMPLEMENTATION_BRIEF.md`): fixture sandbox and DB = fixture proof.
- Data: `dataset.ts` (pinned frozen digests, reference time), `seed-mapping.json` + `seed-plan.ts` (deterministic rows; FX04 refused).
- Owner maintenance (offline, never 06): `inventory.ts` (exact isolation checks), `materialize.ts` (fence-first switch, post-check),
  `register.ts`, `maintain-cli.ts` + `maintain-deps.ts` (production unix deps), entry `scripts/reval-server/maintain.ts`.
- Proof: `source-clock.ts` (pinned reference only for the matching binding), `pg-tx.ts` (pg → `$queryRaw` view, UTC timestamps),
  `fixture-verify.ts` (V's read-only transaction), `verifier-exec.ts` (V process), `fixture-check.ts` (C composition, 1800 ms).
Tests: `tests/reval-seed.test.ts`, `tests/pg/reval-{fixtures,materialize,maintain-cli,fixture-check}.pg.test.ts`.

RS-C-A (`docs/stage5/ask/remote/reval-server/rs-c/IMPLEMENTATION_BRIEF.md`; report `rs-c/IMPLEMENTATION_REPORT.md`): bridge server S
serves Ask REMOTE for the registered sandbox; C pairs/arms; I is a test client until part B.
- Wire/schemas: `eval-wire.ts` (Token, hellos, launch V2, pair secret, ACK payloads, Binding, terminal observation),
  `eval-transient.ts` (S<->I READY/TRANSFER/ACK/COMMIT, never persistable), `eval-handoff-dto.ts` (browser PAIR/RESPONSE/errors).
- S: `eval-state.ts` (pair/arm/claim/slot, pure clock), `eval-observer.ts` (terminal latches/revisions/retention), `eval-gate.ts`
  (ingress gate before body/bearer/DB + claimed task hooks), `eval-db.ts` (registration/facts/handoff authority/phase hooks,
  read-only), `eval-runtime.ts` (hub, RESPONSE transfer), `eval-handoff-socket.ts` (S's measured I socket),
  `eval-handoff-route.ts` (browser handoff route); composition `apps/api/src/reval/evaluation.ts` (main.ts and test entries;
  `bridgeRemoteSeams()` = no key ever resolves in bridge mode, rc2 F1).
- C: `eval-controller.ts` (PAIR/END_PAIR/ARM/terminal journaling, PRE checks), `eval-instrument-link.ts` (C's measured I socket),
  `eval-journal.ts` (0600 append-only safe journal), `eval-cases.ts` (frozen case → fixture map only).
- Accepted Ask hook points (optional, null outside bridge mode): `packages/ask/remote/evaluation.ts`, `service.ts`, `db.ts`,
  `packages/ask/budget.ts` (`onRelease`), `apps/api/src/ask-http.ts` (gate + publishing headers).
Tests: `tests/reval-eval-{wire,state,gate}.test.ts`, `tests/reval-verifier-events.test.ts`,
`tests/pg/reval-eval-{server,handoff,e2e}.pg.test.ts`, `tests/pg/reval-native-rsc.pg.test.ts`; support `tests/support/reval-eval-*.ts`.

RS-D-A (`docs/stage5/ask/remote/reval-server/rs-d/IMPLEMENTATION_BRIEF_A.md`): process census, DRAIN, segments (owner decisions D1/D2).
- `census-payloads.ts` (exact PROCESS_CENSUS/DRAIN), `eval-census.ts` (S guard census: gate/handoff entry, task hooks, census-wrapped
  seams, AskBudget owners, observer records), `eval-drain.ts` (C: PROCESS_CENSUS forwarding with the epoch rule, DRAIN composition).
- Switch with S/C up: `inventory.ts` `checkRegisteredIdle` (idle registered runtime/reader sessions only), `materialize.ts`, `maintain-cli.ts`.
Tests: `tests/reval-census.test.ts`, `tests/pg/reval-census.pg.test.ts`, `tests/pg/reval-segments.pg.test.ts`.

RS-D-B (`docs/stage5/ask/remote/reval-server/rs-d/IMPLEMENTATION_BRIEF_B.md`): S sandbox, DRAIN process inventory, proofs.
- `platform.ts` (pinned Seatbelt profile + argv for S, helper `sandbox <pid>` facts, DB inventory, destination inventory, PLATFORM_PROOF),
  `proof-payloads.ts` (exact 05 decoders, countsAsVerifiedZero rule), `privacy-scan.ts` (closed local scanner, counts only),
  `eval-proofs.ts` (C's ProofLink); wiring `launch.ts` `spawnServer`, `server-link.ts` (enforcedNow), `controller.ts`, `eval-drain.ts`.
Tests: `tests/reval-{platform,proofs}.test.ts`, `tests/pg/reval-launch.pg.test.ts`, `tests/pg/reval-segments.pg.test.ts`.

RS-D-C (`docs/stage5/ask/remote/reval-server/rs-d/IMPLEMENTATION_BRIEF_C.md`): `platform.ts` `serverSandboxPaths(config, configPath, …)` (exact PG
socket literal; config/journal/instrument-socket write deny; policy ref v2) and `processInventory` (DRAIN inventory, every failure
INCOMPLETE); `server-link.ts` takes the config path; `privacy-scan.ts` wording. Tests: `tests/reval-{platform,fsync}.test.ts`,
`tests/pg/reval-census.pg.test.ts`, `tests/pg/reval-rehearsal.pg.test.ts`.
