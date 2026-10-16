# Fable RC1 independent architecture review — S5ASKREMOTE-REVAL-SERVER-DESIGN-rc1

Reviewer role: native `claude-fable-5-1` / `xhigh`, NEW CLEAN session `f4220c8d-6265-4952-af25-83e37edde784`.
Date: 2026-10-11. Scope: proposed architecture amendment only. No source/doc writes, no repairs, no other
reviewer contacted or read, no network/provider/DB/account/key/deployment/activation, paid calls 0.

## Verdict

**CHANGES_REQUIRED** (two required findings, P2). Architecture direction and trust boundaries are sound;
the package is not approvable as written because one fixture family cannot be executed through the accepted
browser under the amendment's own procedure, and the sandbox Ask gating that the handoff design relies on is
underspecified at a public-contract point. Bounded same-context re-review at `xhigh` is acceptable for a
delta that fixes only R1/R2 and keeps every other invariant; new critical scope needs fresh reviews.

This verdict is not implementation/code acceptance, not owner data/budget admission, and does not accept or
reject the separately tracked execution RC5 candidate. `verifiedPass:false` / `liveAcceptanceEligible:false`
remain constants.

## Artifact identity verified

| Check | Result |
|---|---|
| Manifest `verification/stage5/S5ASKREMOTE_REVAL_SERVER_DESIGN_RC1_MANIFEST.json` | 30 entries; all 30 sha256 recomputed and match |
| packageHash | `b577cdfa30654a3e82675de985852053f8a442298136835a5b154983c04c3d3f` reproduced as sha256 of compact JSON of path-sorted entries |
| Package ZIP sha256 | `d6d5fb2d…72c9` matches `RC1_CHECKS.json` |
| Normative set | 7 markdown files (README, AGENTS, 01–05), max 178 lines, `DESIGN_STATUS.md` excluded as administrative |
| Dependency index | `DEPENDENCY_REFERENCES.json` 22 entries, every hash equals the manifest entry |
| Dependency seals cited in README lines 29–34 | DESIGN rc2 `9c92327f…`, REVAL RC6 `66dcc033…`, OFFLINE rc3 `d706a437…`, EXECUTION rc5 `5c6a7e52…` all equal the sealed/manifest `packageHash` values; R-A/R-B/R-C seals present with status ACCEPTED |

## Required findings

### R1 (P2) — FX10 missing-focus cases are not executable through the accepted browser under the stated procedure

- Where: `docs/stage5/ask/remote/reval-server/03_FIXTURES_AND_CLOCK.md:80-81` ("Manually refresh the browser
  context/queue/selection to the fixed requestedFocus"), `:122` ("fixed requestedFocus from the pinned fixture"),
  `:131` ("All eleven fixtures x all five intents require PG17 proof before admission"), and
  `05_PROOFS_AND_ACCEPTANCE.md:129,149` (RS-B 11x5 scope).
- Trigger: frozen FX10 declares `requestedFocus:"syn-obs-not-found"`, `focus.state:"MISSING"`. The accepted
  console derives the Ask focus only from a server-loaded selected observation
  (`apps/operator/src/controller-ask.ts:156`, `selectedObservation(state)?.id`), and every queue load clears the
  selection (`apps/operator/src/controller-queue.ts:3`). No fixture contains that ID, so the browser can never emit
  it. The current instrument and comparator require exact equality of the submitted `observationId` with the
  fixture's `requestedFocus` (`scripts/ask-remote-eval-execution/transient.ts:37`, `session.ts:157`;
  `scripts/ask-remote-eval/predicates.ts:49`). The handoff slot equality in `04_TRANSIENT_HANDOFF.md:91-96`
  correctly binds the browser's actual values, but it cannot make the fixed ID appear.
- Impact: 15 of the 200 frozen cases (FX10: 3 adversarial, 2 entity, 2 summary, 3 why-urgent, 5 unsupported,
  counted from case metadata only) cannot be run; RC6 completeness ("all 200 executed") then fails by
  construction, or an implementer is pushed into an unreviewed workaround (manual ID entry, stale-selection trick
  without refresh, or seeding/removing rows) that contradicts `03:58-60` and the browser generation guards.
- Repair (architecture-level, choose one and state it in 03 and 05): (a) specify the exact reviewed browser path
  that yields a MISSING focus without widening the console surface (none exists today; if a deliberate
  stale-selection path across a fixture switch is intended, it conflicts with the step-4 refresh and must be
  reconciled with the queue/selection generation rules and re-reviewed with R-C); or (b) declare FX10 browser-
  unexecutable in this slice, return it to dataset/architecture review (a corpus revision is a new offline
  artifact, not a silent relabel), and define how the 15 cases are treated in completeness/denominator; or
  (c) revise the instrument's focus predicate for MISSING fixtures to "any ID the installed fixture does not
  contain" and reseal — this is a change to accepted execution evidence rules and needs its own gate. Until one is
  chosen, the 11x5 claim in `03:131` is unimplementable for FX10.

### R2 (P2) — Sandbox Ask gating by pair/arm is underspecified at the public contract boundary

- Where: `04_TRANSIENT_HANDOFF.md:12-15` (header "ONLY in that registered sandbox"), `:56-57` ("atomically claims
  that arm for the FIRST authenticated Ask POST"), `:60-63` ("Inside the registered active evaluation interval, an
  absent/invalid/expired pair or arm denies Ask before reservation … Once any Ask submission claims an arm, the
  case is consumed even if parsing/auth/DB/provider later fails").
- Trigger/impact: (1) "registered active evaluation interval" is never defined; if it means "while a pair exists",
  an unpaired Ask POST against the registered sandbox outside a pair is admitted normally and can reserve and
  dispatch a paid call that no arm covers. The DB and guard census would still see it (`02:69-71`,
  `05:33-36`), but the design's own promise ("denies Ask before reservation") has no fixed trigger, and the
  "no provider duplicates/unmeasured attempts" requirement then rests on after-the-fact census only.
  (2) The denial has no named public result. Remote error codes are a closed list in the accepted
  `docs/stage5/ask/remote/02_CONTRACTS.md:45-48`; a new code or a silent reuse (e.g. `ASK_REMOTE_NOT_ADMITTED 503`)
  is a contract decision the browser must handle under its generation guards and must be stated here.
  (3) Behaviour when `X-Atlas-Evaluation-Session` is present outside the sandbox (reject 400 vs ignore) is not stated.
  (4) The claim point is ambiguous: "FIRST authenticated Ask POST" versus "consumed even if parsing/auth … later
  fails" cannot both hold unless the claim happens at ingress on a syntactically valid session header before
  bearer authentication. The pipeline position relative to parse → bearer auth → phase1 → egress must be fixed,
  because it decides which failures consume the arm and which increment `rejectedUnpairedCount`.
- Repair: define the interval as the entire lifetime of a `RevalSandboxRegistration` (every Ask POST to the
  registered sandbox requires a valid pair and a claimable arm; otherwise fixed denial before any DB authority or
  reservation work, counted in `rejectedUnpairedCount`); name the exact fixed AskErrorV1 code/status for that
  denial and record it as an explicit listed exception in README "Explicit amendments" if it is new; state the
  header rule outside the sandbox; and specify the claim point (recommend: claim at ingress after route/method/
  content-type/size checks and session-token validity, before bearer authentication, so every submission that
  reached the server is consumed and census-visible).

## Nonblocking findings (P3; resolve in the implementation briefs, no architecture change needed)

- N1 Snapshot caps are internally unreachable. `02_LEDGER_AND_CLOSURE.md:17` allows 1000 attempts and 2000
  period rows but caps the frame at 256 KiB; one attempt item is roughly 350–450 bytes, so ~600 attempts or
  ~2000 periods alone exceed the frame. Fail-closed is preserved (`CENSUS_LIMIT_EXCEEDED`), but state which limit
  governs, or size the row caps to fit (a 200-case run plus reruns fits comfortably).
- N2 Single-snapshot semantics need pinning. `02:5-6` allows "READ ONLY REPEATABLE READ transaction or one
  equivalent single SQL snapshot". A VOLATILE PL/pgSQL definer called under READ COMMITTED takes a new snapshot per
  statement; RS-A must require the caller to set REPEATABLE READ READ ONLY (or declare the routine STABLE and call
  it in one statement) and include the deliberate split-read counterexample already listed in the matrix.
- N3 Fixture-check verifier holds the operator's bearer. `03:120-121` runs the owner-side verifier "with the
  designated actor's existing private authentication". That puts the only remote-admitted actor's credential into
  a second principal/process on the owner host. A DB=fixture equality proof needs only a scoped runtime-role
  read-only transaction; recommend dropping the bearer requirement, or stating the exception and its handling
  (no argv/TTY/receipt exposure) explicitly in 01's principal table.
- N4 Arm window operability. `04:55` expires an arm within 5 s and `01:134` bounds PRE-snapshot freshness to 5 s,
  so PRE snapshot → arm → manual consent/click must complete in 5 s across two human roles. The real baseline
  guarantee is the complete PRE/POST census delta, not wall-clock proximity; consider a reviewed larger constant
  (e.g. 30 s) while keeping "no automatic re-arm".
- N5 Envelope emitter is implicit. `01:111-115` uses one envelope for controller-produced kinds (SNAPSHOT,
  FIXTURE_CHECK, PLATFORM_PROOF, PRIVACY_PROOF) and server self-reported kinds (PROCESS_CENSUS, DRAIN process
  counts, handoff). Add an `emitter` discriminator or state per kind which principal emits it, so consumers never
  treat a server self-report (`coverage:'COMPLETE'`) as independent evidence.
- N6 `databaseInstanceId` physical binding (`01:80-83`) should name its independent source (e.g.
  `pg_control_system().system_identifier` plus data directory/socket identity in the owner's off-DB record) so
  "actual DB instance, not a copied row" is testable.
- N7 Registration/binding creation path (`01:79,86`) is unstated: owner-only definer routine vs. direct owner
  DML; also the evidence definer is a ninth role and `prisma/roles.sql` distinct-role/validation loops
  (`roles.sql:127`) must be extended under RS-A.

## Verified properties (no finding)

- Project-wide census is feasible: remote-table RLS is workspace-only
  (`prisma/migrations/202610111010_stage5_ask_remote_state/migration.sql:349-364`), so a workspace-scoped evidence
  definer can count foreign-client attempts without exposing them (`02:32-34`).
- Owner pause uses the accepted routine correctly: `atlas_ask_remote_policy_revise` takes `p_expected_version`,
  accepts `'PAUSED'`, locks fence FOR UPDATE then policy, sets `stateReason='OWNER'`, and treats an identical
  revision as a no-op (`202610111020…/migration.sql:281-332`); runtime `atlas_ask_remote_pause` only accepts
  config-fault reasons (`:206-234`), matching `02:123-127,151`.
- Fence is `Int` (`prisma/actions.prisma:12`); the draft's signed-64 receipt floors with fail-closed overflow on the
  narrower SQL fence (`02:148-149`) are consistent with the instrument (`closure.ts:1-6`, TTY `paused:'true'` adapter
  acknowledged at `02:139-141`).
- Lock order: pause-export, fixture switch (fence → policy → binding → source rows, no counters) and the runtime
  binding re-check under fence FOR SHARE (`01:89`, `03:72-78`) add no cycle to the accepted
  fence → policy → MONTH → DAY → attempt order.
- Synthetic clock claim checked against all 22 declared snapshot states in `fixtures.json`: with
  alert/incident 15 min and ticket 30 min (`packages/graph/context-mapper.ts:33`) and the accepted predicate
  (`packages/ask/read.ts:169`, no lower bound), `2026-10-10T07:30:00.000Z` reproduces every declared OK/STALE;
  any reference in (2026-10-09T22:15Z, 2026-10-10T07:35Z] would; no reference at/after 07:58 can (FX08 07:20
  alert), so `03:111-116` is accurate. `now` flows only into `readResources` (`read.ts:193-202`), so the
  source-only confinement in `03:104-107` is implementable as stated.
- FX08 is the only truncated fixture (100 rows); the single overflow sentinel rule (`03:53-57`) is complete.
  Seed allowlist closes all required FKs (RawEvent→Connection, Observation→RawEvent/Entity, EntityLink→Entity/
  ExternalEntity, SyncState→Connection, ResourceSnapshot→SyncState; DecisionRun nullable); `severityRank`/priority
  are CHECK constraints the seed mapping must satisfy; Connection delete is permitted and fence-incrementing
  (`202610091000…:166`), as `03:76` expects.
- Private dispatch/no-dispatch proof stays in-process and non-reconstructible (`packages/ask/remote/dispatch.ts`);
  no exported flag mints authority (`02:86-98`, `05:30-31`). Unknown never becomes zero; pause ≠ drain; unknown
  liability yields no credit (`02:107-117,157-175`).
- Handoff provenance: one-use nonce minted only from a bound server publication, atomic claim before validation,
  structural equality against the server's private slot, same-origin Origin/Fetch-Metadata, bearer-only, no
  content hashes, no GET/poll/export of slot contents (`04:66-116`). Raw values confined to a 120 s memory slot in
  the sandbox only, explicitly listed as an exception to the accepted drop-at-settlement rule (README amendment 3).
- No new inference/proxy/activation route; owner CLI accepts no URL/SQL/key/question/body (`01:54-57`); owner
  tools never elevate the HTTP bearer or admit data/budget (except N3 hygiene). Attestation limits are honest:
  OFFLINE_SIMULATED always `countsAsVerifiedZero:false`, external retention stays a separate owner proof.
- Checkpoints RS-A..RS-D with dual Sol/Opus acceptance and a meaningful PG17/RLS/grants/scope/concurrency/
  browser/privacy negative matrix (`05:118-160`); future source/build/migration/transport changes require reseal.

## Residual risks (recorded, not findings)

- The host is darwin; effective per-process egress enforcement, peer-credential/process-incarnation verification
  and process coverage may be unavailable there. The design already leaves the platform gate pending in that case
  (`01:69-71`, `05:73`); the supported platform must be named in RS-D.
- A state escalation after an already-confirmed pause reopens a closure requirement that cannot be satisfied
  without an artificial revision (forbidden at `02:153`); this is conservative (absorbing containment) and matches
  the instrument (`session.ts:113`), but operators should know it.
- Frozen corpus labels remain DRAFT_MODEL_ASSISTED / human attestation PENDING; data/budget NOT_ADMITTED;
  execution RC5 acceptance separate; account EU/ZDR, price, operator identity unverified.

## Telemetry limits

Preflight recorded by the launcher: native claude.ai Max authentication, extra usage off, no provider overrides,
fast mode off, `settings.json` effort `xhigh`, interactive CLI 2.1.293, model picker "Fable … xHigh, no usage-credits
marker". Session init in `fable-rc1-stream.jsonl` reports `model:"claude-fable-5-1"`, `apiKeySource:"none"`.
These are launcher/self-identification signals; provider-side response-model and effort telemetry is not
available to this session and is not claimed. Subscription quota attribution unknown. Elapsed/attributable usage
not measured here.
