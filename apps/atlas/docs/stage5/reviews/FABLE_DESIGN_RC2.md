# Stage5 architecture RC2 — bounded re-review (Fable, same session)

Bounded re-review in the same native session (`8bfbe8a9-3a90-44e9-8d3a-322d940b5dcf`), effort retained at high, native claude.ai Max first-party, extra usage disabled. Scope: closure of RC1 findings R1, R2, N1–N9 plus the second fixture contradiction, and nearby regressions. No other reviewer's RC2 verdict was read. Read-only; no builds, database, tests, network or secrets. The RC1 report is unchanged.

## Verdict: APPROVE

All required findings are closed by source-backed package text. One nonblocking precision (P1) for the S5-B brief; residual risks listed. Design gate only; not implementation acceptance.

## Identity and preservation (all PASS)

| Check | Result |
|---|---|
| `verification/stage5/S5_DESIGN_RC2_MANIFEST.json` sha256 | `fee9b7d0…fca2` matches brief |
| `verification/stage5/S5_DESIGN_RC2_PACKAGE.zip` sha256 | `937f9d4b…4893` matches brief and manifest `archiveSha256` |
| `packageHash` `45ae1eba…bccf1` | Recomputed under the stated rule (path-sorted `<sha256>  <path>\n`): match; `previousPackageHash` equals RC1 `eb2ca966…` |
| Eight per-file sha256 | All match the tree; archive entries byte-identical to the tree; entry names equal manifest paths |
| Baseline `bad263dc…` | Unchanged; 894 files, 891 preserved, 3 changed = exactly the declared routing deltas with matching before/after hashes, 0 undeclared, 0 missing |
| Source changes | None under `apps/ packages/ connectors/ prisma/ scripts/ tests/` |
| RC1→RC2 text delta | Confined to `01:8-11`, `02:23-25,35-41,49-57,64-79`, `03:14-15,35-36`, `04:13-14,16-22`, `05:9,22-25`, `06:A4,B1,B3,B8`, `README:8-9`; `docs/stage5/AGENTS.md` unchanged |

## Closure assessment

- **R1 closed.** `01_SPEC.md:8-11` makes filters, page size and pagination DB-only, with fixture controls omitted or disabled. `02_CONTRACTS.md:23-25` defines the fixture fixed-demo queue (no query, active statuses, ≤100 items, no pagination claim) and rejects unsupported fixture filter requests locally. `02:36-38` adds DB item-membership and `items.length ≤ limit` validation plus the fixture active/no-cursor rule; `06` B1/B8 split proofs by mode. Source basis holds: the fixture endpoint ignores the query (`apps/api/src/atlas.module.ts:63-65`), the fixture page is `nextCursor:null, truncated:false` (`fixtures/run-demo.ts:30`), items are OPEN (`contracts.ts:158`), and `mode` is known from the context fetched before any queue request (`03:31-32`, `contracts.ts:255`). The RC1 counterexample no longer applies.
- **R2 closed, with a correction to my RC1 basis.** Root `tsconfig.json` has no `lib` key; for target ES2023 the default lib is `lib.es2023.full.d.ts`, which references `dom` (`node_modules/typescript/lib/lib.es2023.full.d.ts:20`). DOM types are therefore already present at root, and my RC1 clause "DOM types fail" was wrong. The real defect was the partition: browser modules checked with Node ambient types, and server typecheck including browser code. `04_ARCHITECTURE_AND_UX.md:16-22` now states exactly that (root gains only an `apps/operator` exclusion; browser modules checked solely by `apps/operator/tsconfig.json` with explicit libs, `types: []`, `rewriteRelativeImportExtensions`, no Node types; both commands required; declared S5-A baseline delta), and `05:24-25` names the command. Feasible: `apps/api/tsconfig.json` already combines `allowImportingTsExtensions` with `rewriteRelativeImportExtensions` under TS 5.9.3.
- **Second fixture contradiction correctly resolved.** Fixture resource items are the normalized events themselves (`run-demo.ts:19-22,36,38`): they carry `externalEventId`, not `id` or `externalId`. The accepted `one()` matcher uses `externalId ?? id` (`packages/tools/registry.ts:77`), so a fixture `huntress.incident.get` would return an empty FIXTURE list that reads as "not in stored read". `02:67,75-76` forbids that call in fixture context with no absence claim; `02:72-74` filters the fixture Atera alert list by validated `NormalizedEvent.externalEventId` and the DB list by `SnapshotItem.externalId`; `06` B3/B8 bind the positive fixture Atera proof and DB get proofs. No fixture or registry change, no broad fallback. Correct.
- **N1–N9 incorporated** (`README:8-9`; `03:14-15`; `02:78-79`; `02:70-76`; `02:35-36`; `03:35-36`; `05:9` with `06:A4`; `04:13-14`; `05:23-25`). The picker's local search (`02:40-41`) is bounded and local-only and needs no endpoint. Nested-row scope and link-status checks (`02:38-39`) are feasible because `Person`, `Device` and `ExternalLink` extend `Scope` and links carry `status` (`contracts.ts:101-107`). `Person.email` is excluded (`02:56`).

## Nonblocking precision

- **P1 Field name in the fixture item whitelist.** `02:53-54` lists `severity` for the FIXTURE normalized alert/incident shape; `NormalizedEvent` has `sourceSeverity` (`contracts.ts:121`) and no `severity`. A validator written literally would reject the fixture Atera alert item and fail the positive B3 fixture proof visibly as RESPONSE_INVALID, not silently. `02:50-51` already defers exact validators to the S5-B brief; that brief must name `sourceSeverity` and keep `facts` and `externalDevice` undisplayed. No package text change is needed for the design gate.

## Nearby regression check

- `02:12` still lists status/severity/limit/cursor for GET observations; `02:23` qualifies it as DB-only. Consistent.
- The fixture `ATLAS_DEMO_TOKEN` pattern rule (`03:14-15`) applies to console journeys only; the existing fixture equality guard and tests are unchanged.
- Full-scope reset on every 403 (`03:35-36`) is now explicit; an evidence tool denial (`gateway.ts:54-55`) therefore resets client selection. Deliberate and safe.
- No change to authority, Gateway, DTOs, migrations, audit semantics or baseline source. Scope remains the local read-only console; Ask Atlas and LIVE excluded.

## Remaining risks (non-blocking)

- Large-context clients exceed the console caps and become unusable in the console, now stated explicitly at `02:49-50`.
- Fixture journeys cannot exercise ticket evidence (no ticket observation in `run-demo.ts`) or Huntress evidence; DB journeys carry those proofs.
- S5-A baseline deltas (root tsconfig exclusion, new scripts, pinned E2E dev dependency and lockfile) must be declared at the checkpoint as `04:21-22` requires.
- Browser extensions and compromised same-origin JS remain outside the credential boundary.

## Named-model qualification

Requested `claude-fable-5-1` / high, same session, native claude.ai Max first-party, extra usage disabled, no API, credits or fallback. The self-label is not proof; the root records the actual response model stream separately. This re-review approves only the RC2 design package identity above. It does not seal, edit status, or accept any implementation. The same text is persisted after the RC1 report in `/Users/oleksandr/.claude/plans/fresh-initial-independent-architecture-drifting-crystal.md`.