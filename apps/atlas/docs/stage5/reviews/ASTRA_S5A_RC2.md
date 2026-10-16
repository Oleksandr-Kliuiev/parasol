# Independent bounded re-review — S5A-rc2

**Verdict: ACCEPTED for S5-A only. R1 and R2 are CLOSED; no mandatory finding remains.**
Reviewed 2026-10-10 in the same independent reviewer session as S5A-rc1. Explicit native assignment remains `gpt-6-astra`, effective effort **xhigh**; no effort downgrade. Underlying response-model telemetry and attributable subscription usage are not exposed in this native session and are not asserted.

This is acceptance of the repaired opt-in serving/credential/client boundary against RC3 and A1–A8. It does not accept S5-B context rendering/queue/evidence, Ask Atlas, LIVE/pilot/deployment or production authentication. The prior review and its original findings remain preserved.

## Closure and nearby regressions

**R1 CLOSED — original deadline covers synchronous phases and final outcome.** `apps/operator/src/transport.ts` now captures one monotonic absolute expiration, checks it after headers and body reads, after decode/parse/validation, and on the raced outcome. The async timer remains. Results reached at or after expiration become fixed `TIMEOUT`; a running synchronous operation is not claimed to be preemptible. No retry or server cancellation claim was added. Header/status handling, network failures, caller abort, response caps and cleanup remain bounded by the original operation budget.

Independent evidence:
- The unmodified RC1 source probe now rejects the 3,858,891-byte/10,000-client response with `TIMEOUT` under its short budget.
- The unmodified built Node/default 10 s probe now returns `TIMEOUT` (body arrival 10,000.05 ms; settlement 10,004.15 ms). The unmodified built Chromium/default 10 s probe returns `TIMEOUT` (body arrival 10,000.20 ms; settlement 10,003.10 ms). These boundary-arrival timings are scheduler-sensitive; deterministic phase checks below establish the synchronous-overrun closure independently of timer ordering.
- My new probe imports the **actual built modules** and runs **42 scenarios / 62 assertions**, all passing: real decode/JSON parse/client validation, each succeeding or throwing before/at/after expiration; 200/401/403/500 headers before/at expiration; malformed content type and network rejection; expired body chunk cancellation; expiration between validation and result settlement; error cleanup crossing the deadline; caller abort without retry; and all fixture/DB paging combinations. No secret/raw error is printed.
- The built-browser regression suite independently passed cases where the body arrives before the default deadline but validation or the console's JSON.parse crosses it, plus the in-budget positive case. Existing abort-ignoring credential/scope/generation races, stale 401/403/error/finally behavior and current 401/403 handling remain passing. A status first observed after expiration returns `TIMEOUT`, consistent with the original request budget.

**R2 CLOSED — fixture overview cannot imply pagination.** `apps/operator/src/validate-context.ts` passes validated mode into observation-page validation and requires fixture `truncated===false` and `nextCursor===null`. Each forbidden flag separately and both together is rejected before context is committed. DB cursor shape and existing metadata behavior remain unchanged; no stronger DB count/snapshot consistency rule was introduced.

Independent direct/built-browser evidence rejects the original malformed fixture overview with no ready context or mode badge. The new negative browser cases for cursor-only, truncation-only and both pass, along with unchanged fixture and truncated DB positives. My built-module matrix additionally verifies all four flag/cursor combinations in each mode. This repair adds no S5-B controls or data operation.

## Verification and preservation

- Independently reran **34/34 operator unit tests**, **4/4 compiled HTTP/PG17 tests**, and **31/31 Chromium E2E**: **69 tests passed**, no failures/skips. Commands were direct read-only test invocations; no repository build/generate command was run.
- Recompiled the browser with pinned local TypeScript into `/tmp/atlas-stage5/astra-s5a-rc2/rebuilt-ui`: all **14 JS modules** match dist byte-for-byte. Against RC1, the **181-file built inventory changes only transport.js, validate-context.js and the asset manifest**; all API/runtime and other browser bytes are unchanged.
- Read the exact RC1→RC2 diff. Only four existing paths changed: the two repaired modules and their two unit-test files. Additions are the focused browser spec, repair report and declared review/evidence metadata. API/auth/controller/view/domain code, dependencies, schema, migrations and fixtures are unchanged.
- Before and after review, **978 working files**, **181 built files** and **926 archive entries** exactly match the RC2 manifest, with no unexplained extra/missing entry. All 8 approved normative files, design seal, S4C seal and historical artifacts are preserved. Before/after preservation records are identical. The RC1 manifest, archive, implementation report/evidence and review still have their original hashes.
- All **70 durable RC2 supplemental files** match their recorded hashes. The earlier failed root-typecheck run is preserved; final2 evidence reports all 14 required checks passing: 257 unit/PGlite, 569 PG17, 31 browser, schema/generation/type/build/smoke/drift/whitespace. These broad unchanged suites were not duplicated during this bounded review.
- Fresh production clean install/generate/build/prune/serve evidence is bound to the current UI manifest. It shows Playwright absent after prune, generated runtime client present, correct asset bytes/Host/CSP/default-off behavior and serving from another cwd. The prior baseline optional-peer classification of TypeScript/Prisma remains unchanged.
- Six fresh responsive PNGs are preserved. I inspected the new 320 px ready image; layout matches the previously inspected 320/768/1440 states, consistent with unchanged view/CSS and passing responsive/keyboard E2E. Chromium evidence records 141.0.7390.37 with Playwright 1.56.1.

## Exact accepted identity

| Item | SHA-256 / identity |
|---|---|
| Repository | `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1` |
| HEAD | `916a4d69853ff6da636e8609a2e0bd33aa787f66` |
| S5A-rc2 packageHash | `b5819716edad5fc7b8b91b63ebcd239f7e07f5243b2c9c351ea93861c7d767ef` |
| S5A_RC2_MANIFEST.json | `63a96f192a8c8fa21da79794a76ed9f17b4f4d49d8ec476417b11d9c0fc2b45f` |
| S5A_RC2_PACKAGE.zip | `7434937083cf6ccb02c023d6eea6a73d93be0201835056fb44185f34064c8037` |
| Working inventory | `1b16b1da47b8bc07f10d904282fc17b66d11f7eb543b4c7301b98017d9b16f5a` |
| Built inventory | `c621ace2398a4916695b6e953bef9143ef777fb21dc823b4bcb76ebc316f72c8` |
| dist/operator/manifest.json (16 assets) | `2c5faa6fa4f34648859053152dfc3cdc9b56be80d226aaf5fa38a7e3b0f58a25` |
| transport.ts | `4bcbbbae20097a31107d978e10b32d00e98627692a62664f9417752e9ab262fb` |
| validate-context.ts | `d8bec759eeb4eea972277c627a9cb9bff0354b7e4279ebe13f1792e10390532a` |
| Repair baseline | `3b9b4546da2842b8c98ca9adb7f070c2a4ab3fc70c10e0f816c54789df370a78` |
| Approved design packageHash (8 files) | `b2fc0f89605cc27039044ff6f934cb06ee3180f23f8372ab2f427388ce4e72a7` |
| S5_DESIGN_APPROVED.json | `bd6e49ac7f20692d242c744062f7ae780fedee413f41d5759e912108f6220c60` |
| S4C_APPROVED.json | `0a7f21f676edb3d3f07c921214254003d2625a478a9bc9c0a79f243860b1573b` |

## Reviewer evidence and qualifications

All reviewer writes are outside the repository in `/tmp/atlas-stage5/astra-s5a-rc2/`. `review-evidence-inventory.json` records the exact hashes of probe scripts/results, all 69-test logs and before/after preservation evidence. Original RC1 probe copies are byte-identical; the new phase probe is independent of the implementer's tests.

| File in that directory | SHA-256 |
|---|---|
| `phase-probes.mjs` | `adafad35426b9fe1dcb4f8cc8c134bf98052cf0b290032eb3ff447d0743d7cd0` |
| `phase-probes.log` | `a6654687ac9cf50d524ca28a0a6dd296bf6906766e67fa52f9907622b3974ebb` |
| `original-default-deadline.mjs` | `0008bc077a6edf3fbe3862b03fa549656628059620e4fec44effded81ef936a9` |
| `original-default-deadline.log` | `48dc790f73f028322ebdaf32d096414f6efce1aa9aba145f172ae18810a1841b` |
| `original-browser-probe.ts` | `2375247880a6820530442745f92040c7cbcad44f28a04bf7af7490d1c856bd28` |
| `original-browser-probe.log` | `6d9ed50848c65df3197736472dd5e5201afa836fbf6f07756b489a1b4bd3ef69` |

**Optional O1 remains non-blocking and unchanged:** a synthetic error-body stream whose `cancel()` never settles causes 401/403 to become `TIMEOUT`; a native browser-fetch cancellation stall has not been demonstrated. Both original synthetic O1 probes still show this disclosed behavior. It was not a required repair and no additional acceptance blocker is inferred.

Synchronous JavaScript is not preempted, so timeout settlement can occur after the nominal deadline, but late work cannot be returned as accepted data. Browser abort/timeout does not cancel or roll back accepted server work, disconnect does not revoke tokens, and already-seen data or compromised same-origin/browser-extension code remains outside this local boundary. Existing server authorization remains authoritative. Before dependent work starts, verify current code/build still matches this accepted artifact; subsequent affected-scope changes require review.
