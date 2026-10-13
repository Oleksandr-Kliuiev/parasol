# Stage5 architecture RC3 — bounded re-review (Fable, same session)

Bounded re-review in the same native session (`8bfbe8a9-3a90-44e9-8d3a-322d940b5dcf`), effort retained at high, native claude.ai Max first-party, extra usage disabled. Scope: the two normative wording changes vs RC2 and nearby contradictions. No other reviewer's RC3 verdict was read. Read-only; no builds, database, tests, network or secrets. The RC1 and RC2 reports are unchanged.

## Verdict: APPROVE

No required findings remain. The RC2 → RC3 delta is exactly the two declared wording changes, and RC2 P1 is closed against source.

## Identity and preservation (all PASS)

| Check | Result |
|---|---|
| `verification/stage5/S5_DESIGN_RC3_MANIFEST.json` sha256 | `ac60ed42…e786` matches brief |
| `verification/stage5/S5_DESIGN_RC3_PACKAGE.zip` sha256 | `3b827f0b…e56d` matches brief and manifest `archiveSha256` |
| `packageHash` `b2fc0f89…72a7` | Recomputed under the stated path-sorted rule: match; `previousPackageHash` equals RC2 `45ae1eba…` |
| Eight per-file sha256 | All match the tree; archive entries byte-identical to the tree; entry names equal manifest paths |
| Baseline `bad263dc…` | Unchanged; 894 files, 891 preserved, 3 changed = the declared routing deltas (identical to RC2) with matching before/after hashes, 0 undeclared, 0 missing |
| Source changes | None under `apps/ packages/ connectors/ prisma/ scripts/ tests/`; head `916a4d6`, branch `planning/stage2-m365` |
| RC2 → RC3 text delta | Only `02_CONTRACTS.md:53-54` and `04_ARCHITECTURE_AND_UX.md:40-41`; `01`, `03`, `05`, `06`, `AGENTS.md`, `README.md` byte-identical to RC2 |

## Closure assessment

- **P1 closed.** `02:53-54` now whitelists `summary/sourceSeverity/occurredAt` for the fixture normalized alert/incident item and excludes `facts` and `externalDevice`. This matches `NormalizedEvent` exactly: `sourceSeverity` (`packages/core/contracts.ts:121`), `summary` (`:122`), `facts` (`:123`), `externalDevice` (`:117`), `occurredAt` (`:118`). The positive fixture Atera alert proof in `06` B3 is therefore implementable from the stated shape.
- **04 wording consistent with 02.** `04:40-41` now says unknown item shapes, invalid required or displayed fields, and unknown enum/status values fail validation, while undisplayed additive fields are ignored as stated in 02. That mirrors `02:57`. The RC2 phrase "unknown fields fail validation", which conflicted with ignoring additive fields, is gone.
- **No nearby contradiction.** The DB `SnapshotItem` whitelist at `02:52` is unchanged and still matches `contracts.ts:226-238`. Evidence allowlist, validation, security, checkpoint and acceptance text are unchanged from the approved RC2.

## Residual precision (non-blocking, for the S5-B brief)

- `SnapshotItem.status` is documented free source text, not an Atlas enum (`contracts.ts:229-230`). The phrase "unknown enum/status values fail validation" at `04:40` must be read as Atlas enums only (`ResourceStatus`, `ObservationStatus`, `Severity`, `Route`, `Priority`), with `SnapshotItem.status` validated as a bounded string. The S5-B validator brief should state this so valid DB snapshot items are not rejected.
- Earlier residuals stand: large-context clients are unusable beyond the console caps; fixture journeys cannot exercise ticket or Huntress evidence; S5-A baseline deltas (root tsconfig exclusion, new scripts, pinned E2E dev dependency and lockfile) must be declared at the checkpoint; browser extensions and compromised same-origin JS remain outside the credential boundary.

## Named-model qualification

Requested `claude-fable-5-1` / high, same session, native claude.ai Max first-party, extra usage disabled, no API, credits or fallback. The requested label is not proof; the root records the actual response model stream natively. This re-review approves only the exact RC3 package identity above as a design gate. It does not seal, edit status, change source, or accept any implementation. The same text is persisted after the RC1 and RC2 reports in `/Users/oleksandr/.claude/plans/fresh-initial-independent-architecture-drifting-crystal.md`.