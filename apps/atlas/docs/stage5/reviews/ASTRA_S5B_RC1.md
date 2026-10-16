# S5-B actual-code acceptance — S5B-rc1

**Verdict: APPROVE. Required findings: none.** This accepts the implemented local read-only context, queue, detail and stored-evidence checkpoint against approved Stage5 RC3 and brief RC2. It does not accept Ask Atlas, LIVE, pilot, deployment or production authentication.

Reviewer: fresh native Codex subagent explicitly assigned **GPT-6 Astra (`gpt-6-astra`), effective effort `xhigh`**, with no inherited reviewer verdict and no delegation. Model/effort are the native dispatch configuration; underlying provider response-model telemetry is not exposed to this reviewer. No API billing, credits, provider changes, real credentials/data or vendor/model calls were used. The checkout and `dist` were read-only throughout; all reviewer output and mutation copies are under `/tmp/atlas-stage5/astra-s5b-rc1/`.

## Artifact identity and preservation

Repository: `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`.
HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`; branch `planning/stage2-m365`.

| Bound item | SHA-256 / package identity |
|---|---|
| S5B-rc1 source package | `0346dc1293e06dfe04c58cda197eb276baedf0784df1aef08f6cd951692f0d6b` |
| `S5B_RC1_MANIFEST.json` | `b240149886391c12b686b43f8afbda1058456667e3757bb22116129b1ee27f4a` |
| `S5B_RC1_PACKAGE.zip` | `cc9fc18e726b2428ec803b1d0142173b03b62036606ce8c43d1cfb25b8a207b8` |
| Working inventory | `0e648d62cbaa2b8740d6946608b66f7053e3aaaa6422450cc9a6af7bb3c8a344` |
| Built inventory | `c459bb6e97ef42922511402c3f28da783731411572e7188807a2fd2c238e8887` |
| Operator asset manifest | `d8329d97c23662b2579c946b9e5eea6ed039ad18846ee7cad42695998ddf0b5a` |
| Implementation baseline | `a49c148445b01d694a29ac76bba2c952ce788fc43bd51adae14f4c6412549089` |
| Stage5 RC3 architecture package | `b2fc0f89605cc27039044ff6f934cb06ee3180f23f8372ab2f427388ce4e72a7` |
| Design approval seal | `bd6e49ac7f20692d242c744062f7ae780fedee413f41d5759e912108f6220c60` |
| S5-A approval seal | `93fe2b27aad04bdfc257ee920b566a81099370dbd5c75792b222d3675f998aa7` |
| Brief RC2 source | `24ba441d2ecf36fd83417ad57caec70a66e634bab3dfd8bcf4b072e0bae04732` |
| Brief approval seal | `e37497cdfcfc1f2bc960eb59972ffbc591556e67925afa6a60d125ab4dcb6173` |
| Implementation evidence | `814de2157dbc4acab212efedf224092a7129db76147d04a4e6f65c2f84fcbb89` |

Review-start verification matched all 1,026 working entries, 197 built entries and the archive. Independent verification after the checks recomputed inventory/package hashes, checked every archive entry and repeated the source/build checks; the final identity is unchanged (`identity-initial-record.json`, `identity-after-checks.json`, `identity-final.json`). The 971 archive-source entries match the package; archive exclusions remain covered by the working inventory. The only Git inventory entries outside that inventory are this package's manifest and archive. The actual `dist` file set exactly matches its 197-entry inventory.

Against the 997-file baseline: **25 changed, 29 added, 0 removed, 972 byte-unchanged**. `preservedBaselineFiles: 961` is the manifest's narrower protected/forbidden-write subset, not the total unchanged-file count. Changes are confined to the approved operator/test/routing/report/evidence scope. All eight frozen normative files, existing seals, accepted API/domain/schema/dependency/build-script bytes and all **164 nonoperator built files** are preserved. The largest changed active source/test/style file is 261 lines.

## Independent verification

| Check | Result |
|---|---|
| Direct Node operator suite, `tests/operator-*.test.ts` | **57 passed**, zero failures/skips; `operator-units.log` |
| Direct Playwright against frozen `dist`, silent disposable-PG17 wrapper, output outside checkout | **50 passed**, zero failures/skips, 35.2 s; `browser.log` |
| Browser identity independently queried | Chromium **141.0.7390.37**, Playwright **1.56.1**; `browser-version.json` |
| Browser TypeScript compile to external directory | Exit 0; all **32 JS/HTML/CSS served assets** byte-equal to the reviewed build; `external-compile.log`, `identity-final.json` |
| Independent controller race probe with `AbortController.abort` fully suppressed | **56 scenarios / 184 assertions passed**; late success/401/403/500 across context/queue/evidence, credential/client/filter/page/context-refresh changes and same-selection/same-page replacement; `no-abort-races.log` |
| External-copy generation mutations | Removing each of context, queue and evidence generation guards independently fails the new probe: **3/3 caught**; `independent-mutation-results.json` |
| Exact selected-tuple defense through controlled evidence-controller Kernel seam | **24 scenarios / 72 assertions passed**; ID/client/source/type/connection/source-ID changes cannot commit or process denial; removing only the tuple guard in an external copy fails: **1/1 caught**; `tuple-defense.log`, `tuple-mutation.json` |
| Durable implementer evidence verification | All **187 file hashes** and all **14 final check-log hashes** verified against the bound inventories |

The final implementer evidence records 280 unit/PGlite, 569 PG17 and 50 browser passes plus the remaining required checks. I inspected the relevant final summaries, production HTTP results and negative-control results; I did not repeat the unchanged full 569-test PG suite. Production evidence records fresh install/generate/build/prune and serving from `/`, default-off/Host/CSP behavior, 32 byte-equal assets and actual GET 200 / evidence POST 201. My independent compile and browser run corroborate the reviewed source-to-served-build correspondence.

Visual review of the bound final `s5b-320-detail.png`, `s5b-768-evidence.png` and `s5b-1440-db-states.png` found readable stacked/column layouts, wrapping IDs, text urgency, honest fixture Huntress unavailability and explicit STALE/truncated/unknown-time/absence states. The browser suite independently passed all three viewport sizes. No trace, video, HAR or failure screenshots were enabled; no new screenshots were captured in this review.

## Contract assessment

- **B1/B8:** context validation gates the first queue request; DB selection, limit, status/severity membership, unique IDs and cursor are validated; server ordering survives; one page replaces another; filter/refresh/client transitions clear selection/evidence synchronously. Fixture requests contain no query and unsupported controls/requests are absent or refused. Actual fixture and PG journeys pass.
- **B2/B4:** exact entity ID plus one current graph row and confirmed link controls selected-entity confirmation; unresolved/unavailable references remain explicit. HIGH/CRITICAL urgency survives low confidence, MONITOR and NORMAL priority. ERROR/MISSING null is unavailable; OK/STALE/FIXTURE arrays, independent timestamps and preserved truncation have distinct presentation. An absent selected item is only absent from this stored read.
- **B3/B7:** operations and tool parameters are closed; selected validated references determine the precise request. GET accepts only 200 and evidence POST only 201. Actual fixture Gateway and PG ToolExecution/AuditEvent positive/denial journeys pass; tested domain-table digests stay unchanged. Unsupported and fixture Huntress evidence send nothing. No additional source/provider/action/mapping/lifecycle/M365/finance routes or authority changes were introduced.
- **B5/B6:** whole-response explicit projections, scope/tuple/mode checks, caps and bounded opaque diagnostics are enforced before commit. Context excludes email and financial/M365 content; evidence excludes raw/facts/error payloads. DOM construction uses text nodes and fixed attributes. Injection/browser assertions pass. Current 401 disconnects, current 403 resets full scope and refreshes the picker once, and stale outcomes cannot commit, trigger denial, render, send requests or clear a newer spinner.
- **B9 and A1–A8:** the frozen-build browser run covers serving/headers/Host, credential privacy, replacement/disconnect/pagehide/bfcache, authorized picker and DB tokens, fixed origin/operations, invalid/capped/deadline responses, keyboard/focus and responsive layouts. Existing GET200-only, original total deadline including synchronous validation, and fixed-fixture-pagination regressions pass.

## Qualifications and residual limits

The implementer's ordinary-workflow selected-tuple mutant was not caught alone because selection changes also reset the generation. Some browser fetch-abort suppression can likewise mask a removed guard through transport's own local abort settlement. This does not invalidate the accepted implementation: the reviewer probe suppresses abort completely and independently catches all three generation removals. The separate Kernel-seam probe proves the tuple guard itself. That seam deliberately bypasses normal state orchestration; it does not claim a reachable production bypass. The implementer's phrase “not independently testable” should therefore be read as “not independently isolated by that ordinary-workflow mutation test.”

A timed-out/aborted browser read may still produce the accepted server audit/ledger outcome. Large permitted contexts can create a large DOM, including collapsed stored items. Memory-only credentials do not establish production login or erase information already seen by an authorized user. These are scoped residuals, not required findings.

Review evidence inventory: `/tmp/atlas-stage5/astra-s5b-rc1/INVENTORY.json`, **170 files**, SHA-256 `b157b10907b9e9e13f0d4e4e06633b0226b00aa283d65c9693a975b81aa9e487`. The report itself is excluded to avoid a circular hash. Durable implementer inventory SHA-256: `438295bf90cafb826d7558ee946d027172ea27418abe1453c97cf57565476c64`.

**S5B-rc1 is accepted at the exact identity above.** Later substantive changes require renewed review of affected scope; status/evidence administration must preserve this accepted identity.
