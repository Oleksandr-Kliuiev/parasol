# S5-A RC2 implementation report — repair of Astra S5A-rc1 R1/R2

**Status: repaired; independent Astra actual-code acceptance PENDING. Not self-accepted.** S5-B, Ask Atlas and LIVE not
started. The original S5-A report (`S5A_IMPLEMENTATION_REPORT.md`), the frozen S5A-rc1 artifact and the review are unchanged.

## Identity

| Item | Value |
|---|---|
| Implementer | same cohesive Claude Code session `428eec79-8ee5-454d-aacf-be79fd53317a`, native `claude-opus-5-5`, effort high, no subagents; native firstParty claude.ai Max, extra usage disabled (S5A_REPAIR1_PREFLIGHT.json). Attributable subscription usage unknown |
| Repair baseline | verification/stage5/S5A_REPAIR1_BASELINE.json: HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `planning/stage2-m365`; all 973 files matched before writing |
| Review | docs/stage5/reviews/ASTRA_S5A_RC1.md SHA-256 `c2acaafb87377b634adc95f60d347c353e7672a79be608a692de7325b1515116` (R1, R2 required; O1 optional) |
| Approved design | package `b2fc0f89605cc27039044ff6f934cb06ee3180f23f8372ab2f427388ce4e72a7` (8 files verified), seal `bd6e49ac…6220c60`, unchanged |
| Built console | dist/operator manifest SHA-256 `2c5faa6fa4f34648859053152dfc3cdc9b56be80d226aaf5fa38a7e3b0f58a25` (16 assets); RC1 was `091fe87c…6093` |

The original RC1 suites (29 operator unit + 4 HTTP/PG + 24 browser = 57 focused tests) all passed and did not catch R1
or R2; the RC1 report's claim of a deadline covering all phases was not true for synchronous work.

## Findings closure

**R1 — original deadline through decode/parse/validation.** `getValidated` now fixes one absolute expiry
(`performance.now()` + budget, default 10 000 ms) when the operation starts; it is never reset. `exchange` checks it after
the headers arrive (before status mapping), after every body chunk (cancelling the reader), after UTF-8 decode, after
JSON parsing, and after validation, for success and failure alike. A final check on the raced outcome runs before
the result reaches the caller. Any outcome reached at or after the expiry is `TIMEOUT`, never data. The timer is kept
(scheduled for the remaining budget) to settle blocked asynchronous work and abort the browser request locally; cleanup
still clears the timer, removes the caller-abort listener and aborts the local controller. JavaScript cannot preempt a
running parser: a synchronous phase that runs past the expiry is allowed to finish, but its result is rejected. No
worker/preemption or server-cancellation claim is made. Fixed codes, caller abort (`NETWORK`), status mapping before
the expiry, stale/401/403 handling in the controller (unchanged) and no-retry are unchanged.
An injectable monotonic `now` in `TransportOptions` exists for deterministic tests only; production uses the default.
Adjacent semantics: a 401/403/5xx whose headers arrive after the expiry is `TIMEOUT` (the request already exceeded its
budget), not a disconnect. O1 (awaited error-body cancel) is deliberately unchanged, since it was not required. Expired paths use
best-effort, non-awaited cancellation so they cannot delay the result.

**R2 — fixture paging metadata.** `observationPage` now receives the validated context mode. In fixture mode
`truncated` must be `false` and `nextCursor` must be `null`; either one alone, or both, is `RESPONSE_INVALID` before
anything is committed. DB keyset metadata is unchanged (cursor format only; no new count/snapshot consistency rule). No
S5-B query controls were added.

## Exact delta against the repair baseline

| File | Change |
|---|---|
| `apps/operator/src/transport.ts` | +47/−20; 108 lines |
| `apps/operator/src/validate-context.ts` | +8/−3; 136 lines |
| `tests/operator-transport.test.ts` | +4 tests (R1, controlled clock) |
| `tests/operator-validate.test.ts` | +1 test (R2 fixture flags separately/combined; fixture and DB near-cases) |
| `tests/ui/console-deadline-paging.spec.ts` | new, 7 browser tests (133 lines) |
| `docs/stage5/S5A_RC2_IMPLEMENTATION_REPORT.md` | this report |

No API, server, dependency, script, lockfile, authority, schema, migration, fixture, review, manifest, seal or status
change. RC1 copies of the two source files are preserved at /tmp/atlas-stage5/s5a-repair1-work/.

## New tests

- Unit R1 with a controlled monotonic clock advanced by the stubs, so no real 10 s waits are needed:
  - On the default 10 000 ms budget: arrival at 9 998 + 30 ms stall → `TIMEOUT`; +1 → OK; 9 999 + 1 → `TIMEOUT`;
    0 + 9 999 → OK; 0 + 10 000 → `TIMEOUT`.
  - Headers at 6 ms plus body at 6 ms of a 10 ms budget → `TIMEOUT` (the budget is not reset between phases).
  - Late 200/401/403/500 headers → `TIMEOUT`.
  - A queued-microtask stall after the body → `TIMEOUT`.
  - In-budget success and `RESPONSE_INVALID` are unchanged.
  - A validation failure past the expiry → `TIMEOUT`.
  - Status codes before the expiry are unchanged; caller abort stays `NETWORK` with one request.
  - Blocked work is settled by the timer, and the request signal is aborted after both timeout and success.
- Browser R1, built `transport.js` with real defaults under Playwright's controlled clock (fast-forward to 9 s, then
  real time): a valid 10 000-client body (≈3.86 MB) arrives before 10 s and the validator stalls synchronously past it →
  `TIMEOUT`; the same body validated before 10 s → 10 000 rows.
- Browser R1, full console flow: a synthetic synchronous stall in `JSON.parse` crossing the budget → `TIMEOUT`, no
  list, session stays "Connecting…", one request.
- Browser R2: the real compiled fixture overview with cursor+truncated, cursor-only and truncated-only →
  `RESPONSE_INVALID`, no "validated" text, no mode badge, no payload text. Near-cases: the unchanged fixture overview
  validates; a truncated DB page with a cursor validates.

**Negative controls** (logs /tmp/atlas-stage5/s5a-repair1-negative/). I swapped in the exact RC1 `transport.ts`:
- The 3 deadline unit tests failed.
- 2 of the 3 R1 browser tests failed; the in-budget positive near-case passed, as intended.
- Re-run after the final spec edit: same result.

I swapped in the exact RC1 `validate-context.ts`:
- The R2 unit test failed.
- All 3 R2 browser negatives failed; the near-case passed.

Afterwards both sources were restored and verified byte-identical (SHA-256 `4bcbbbae…62fb`, `d8bec759…532a`) and
rebuilt to manifest `2c5faa…a25`.

**Reviewer probe closure.** Unmodified scratch copies are in /tmp/atlas-stage5/s5a-repair1-probes/; the originals were
not touched.
- Built Node, default 10 s (body at 9 999.9 ms) → `TIMEOUT`.
- Built Chromium, default 10 s (body at 10 000.1 ms) → `TIMEOUT`.
- Source with a 1 ms budget → `TIMEOUT`.
- Fixture paging: rejected by the validator and in the Chromium UI.
- The O1 hanging-cancel probe (401/403 → `TIMEOUT`) and the two DB-metadata candidates are unchanged, since neither was
  required.

Probe timing is scheduler-sensitive; the deterministic tests above are the regression evidence.

## Required checks

`/tmp/atlas-stage5/checks.sh`:
- **First run `s5a-rc2-final` (preserved):** 13/14 passed. Root `typecheck` failed with exit 2 because of typing in the
  new spec: page-URL dynamic imports and an untyped `this`. It was fixed test-side only.
- **Final run `s5a-rc2-final2`** (2026-10-10T13:10:58Z–13:14:14Z, logs /tmp/atlas-stage5/s5a-checks/s5a-rc2-final2/): all 14 exit 0.

| Check | Result |
|---|---|
| `npm test` | 257/257 (was 252; +5) |
| schema validate, db generate, root typecheck, `ui:typecheck` | pass |
| `ui:build`, `api:build` | 16 assets, manifest `2c5faa6f…0f58a25` |
| `api:smoke` | PASS |
| `test:pg` (PG17 wrapper) | 569/569 in 149 s |
| `db:check:pg17`, `db:check:drift` | pass, no drift |
| `test:ui` | 31/31 (was 24; +7) in 24 s |
| `git diff --check`, untracked whitespace | clean |

The logs contain no connection URL or bearer value.

## Production staging and visual evidence

- **Staging:** /tmp/atlas-stage5/s5a-repair1-prod-staging.sh, a copy of the original with only the log/stage paths
  changed. Logs are in /tmp/atlas-stage5/s5a-repair1-prod-staging/; the original staging logs are preserved.
  - `npm ci`, generate, `api:build` and `prune --omit=dev` all pass, and the result is served from `/`.
  - Manifest `2c5faa…a25`; Playwright absent after the prune; `.prisma/client` present.
  - Console enabled: `/operator/` 200, an asset 200, `/operator` 404, `/clients` 200, alias Host 421, CSP present, and
    the served bytes equal the build.
  - Console disabled: `/operator/` 404, `/clients` 200.
- **Screenshots** (6, synthetic, taken after the token field was cleared): /tmp/atlas-stage5/s5a-repair1-visual/
  (hashes in `screenshots.sha256`). The UI itself is unchanged.
- **Browser:** Chromium 141.0.7390.37 via Playwright 1.56.1 (/tmp/atlas-stage5/s5a-repair1-browser-version.json).

## Residuals

- A synchronous phase that overruns cannot be interrupted; its result is discarded as `TIMEOUT` once it returns. The
  browser timeout is local and claims no server cancellation.
- O1 is not addressed: a never-settling error-body cancel turns 401/403 into `TIMEOUT`. A native browser stall was not
  demonstrated.
- All S5-A residuals in the original report stand. S5-B, Ask Atlas and LIVE remain separate gates.
