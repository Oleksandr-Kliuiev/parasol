# Independent actual-code acceptance — S5A-rc1

**Verdict: CHANGES_REQUIRED.** Two required findings remain in S5-A. S5-B must not advance on this artifact.
Reviewed 2026-10-10 against the approved RC3 contracts and A1–A8 only. No source, dist, configuration or repository evidence was changed by this reviewer.
Native reviewer assignment: explicit `gpt-6-astra`, effective effort **xhigh**, fresh first acceptance session. Underlying response-model telemetry is not exposed in this native session; no independent response-model or attributable subscription-usage claim is made.

## Required findings

**R1 — P2: enforce the original deadline through synchronous decode/parse/validation.**
Location: `apps/operator/src/transport.ts:52–54,69–77` (especially success return at line 53 and timer-only race at line 76).
The deadline exists only as a `setTimeout` promise. After a body read resolves, its microtasks and synchronous UTF-8 decode, JSON.parse and validator can finish past the deadline before the timer callback runs; success wins and the timer is cleared. This violates the original 10 s request deadline in RC3 `02_CONTRACTS.md:17` and the transport's explicit all-phases contract, affecting A5/A6.

Independent reproduction imports the **actual built** modules in Chromium under the real console's CSP, uses the real client validator, and changes no source: a valid 3,858,891-byte list of 10,000 clients arrives at 9,998.4 ms; the transport returns `{ok:true}` at 10,018.2 ms with the default 10,000 ms budget. A separate built-module Node reproduction returned success at 10,016.5 ms, after the body arrived at 10,001.4 ms. A scaled source probe (1 ms budget) likewise accepted after 26.9 ms. This is a measurable late success, not a claim that JavaScript can preempt an executing parser.

Required correction: capture one monotonic absolute expiration when the operation starts, preserve the timer for local settlement of blocked async work, and reject elapsed operations at phase/result boundaries before returning a success. Do not reset the budget between headers/body/decode/parse/validation. Keep credential/scope/generation guards, fixed errors, abort semantics and no-retry behavior unchanged.
Regression boundary: normal completion before expiration; delayed headers/body using the same budget; expiration during synchronous decode/parse/validation or delayed timer dispatch; pre-/post-expiration results; late success/error after timeout; caller abort and stale 401/403/finally must remain inert. Use a deterministic short-budget unit case plus a real built-browser case. No server cancellation/rollback claim is warranted.

**R2 — P2: reject pagination metadata in a fixture overview before marking context validated.**
Location: `apps/operator/src/validate-context.ts:53–63,128`.
`observationPage` has no mode argument and accepts any syntactically valid cursor and either boolean truncation value. Thus a fixture `ClientContextV1` carrying `observations.truncated=true` and `observations.nextCursor='cursor'` passes the whole-context validator. RC3 `02_CONTRACTS.md:37–38` explicitly requires fixture items to be active, ≤100, and have no cursor/truncation implying pagination. This is already part of S5-A's fetched-context validation (A4/A6), not a request to implement S5-B queue controls.

Independent Chromium reproduction intercepted the existing `/clients/demo-gasta/overview` response, changed only those two observation-page fields, selected the fixture client normally, and observed the built UI announce “Client context received and validated” with the fixture-mode badge. The direct validator probe also accepts it.

Required correction: pass the validated context mode into observation-page validation and require `nextCursor===null` and `truncated===false` for fixture mode. Preserve accepted DB cursor/truncation behavior and avoid introducing stronger DB snapshot/count-consistency promises.
Regression boundary: unchanged positive fixture overview; fixture non-null cursor with either truncation value; fixture `truncated=true` with null cursor; error panel contains only `RESPONSE_INVALID`, no retained ready context/badge or raw payload; valid truncated DB overview remains accepted. Add a built-browser negative response test and focused validator tests.

## Independent checks and evidence

- **29/29** operator unit tests passed: `node --experimental-strip-types --test tests/operator-*.test.ts`.
- **4/4** compiled HTTP/PG17 tests passed through the supplied PG wrapper, exercising default-off behavior, invalid flags, missing/tampered assets, exact Host/CSP/security headers, asset bytes, other cwd, server auth and existing denial audits.
- **24/24** Chromium E2E passed through the direct Playwright CLI with output outside the repo. Tests use the real built console/CSP, fixture and disposable PG17 journeys, token/DOM/storage/network checks and abort-ignoring races. Existing tests do not catch R1/R2.
- Independently recompiled browser and API with the pinned local compiler to **outside-repo** output directories. All **14 browser JS files** and **164 API/runtime files** match current dist byte-for-byte. No repo build command was run.
- **9 targeted probe cases** across source, built Node and built Chromium: the three deadline cases and two fixture-pagination cases substantiate R1/R2; two cancellation probes are qualified below; two DB-metadata candidates were not promoted into requirements, preserving the existing consistency contract.
- Visually inspected durable 320 px disconnected/ready, 768 px ready and 1440 px ready PNGs. Labels, keyboard paths from browser checks, readable status, stacking and lack of horizontal page overflow fit S5-A. No queue/content/evidence acceptance is implied.
- All 56 durable supplemental evidence files match their recorded hashes. Implementer evidence reports 14 required checks passing: 252 unit/PGlite, 569 PG17 and 24 browser tests, schema/type/build/smoke/drift/whitespace checks. These broader suites were not needlessly rerun. Production clean-install/build/prune/serve evidence is preserved with its disclosed qualification: staging preceded the final focus-preservation edit; dependency/build graph stayed unchanged and the current full checks/recompilation cover current files.
- Independently compared the four changed baseline code/config/dependency files with archived bytes that exactly match their S5-A baseline hashes. Wiring is thin; root config gains only the operator exclusion; existing locked dependency entries are unchanged except the declared root devDependency, and exactly four dev packages were added. No new runtime dependency.

Review logs, scripts, before/after preservation records and their SHA-256 values are indexed in `/tmp/atlas-stage5/astra-s5a-rc1/review-evidence-inventory.json`.

| Probe/evidence path (under `/tmp/atlas-stage5/astra-s5a-rc1/`) | SHA-256 |
|---|---|
| `probe.ts` | `ecb0c3b6581b8124991050da615515e98bcd353ecb4835bca7878f32a201b540` |
| `probe.log` | `cf2dfd450e7d342cdcec903ecbf557fdb9e4a69cdbd22cb843777203ea4ec5f9` |
| `default-deadline.mjs` | `0008bc077a6edf3fbe3862b03fa549656628059620e4fec44effded81ef936a9` |
| `default-deadline.log` | `a437e7f4b7c25b13ade6a6ef820347eae0009c75d361a5821bd0e8bdc0da5f59` |
| `browser-probe.ts` | `2375247880a6820530442745f92040c7cbcad44f28a04bf7af7490d1c856bd28` |
| `browser-probe.log` | `fb5c7ad051d6cf940ff344d9199955bb9e15ec7bb955447d69ce4faee9e6a592` |

Reproduce from the repository cwd with `node --experimental-strip-types /tmp/atlas-stage5/astra-s5a-rc1/browser-probe.ts`; the probe starts/stops its own synthetic fixture API and Chromium, uses current built modules, and writes no repo files. The source probe uses `node --experimental-strip-types .../probe.ts`; built Node probe uses `node .../default-deadline.mjs`. Tokens are synthetic and not printed. Boundary timing is scheduler-sensitive: the hashed logs record successful reproductions, while a rerun can let the timer win first. Use controlled phase delays/clock behavior for regression tests.

## Exact identity and preservation

| Identity | Value |
|---|---|
| Repository | `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1` |
| HEAD | `916a4d69853ff6da636e8609a2e0bd33aa787f66` |
| S5A-rc1 packageHash | `3dfbaf4db36b802d59ee08bdee46daa2e3d574c8822adf55f261d27440283dab` |
| S5A_RC1_MANIFEST.json SHA-256 | `8f93a3eff7dd5025b078df0f432ad24031198b46a87c5508d7ade79cbcf83e06` |
| S5A_RC1_PACKAGE.zip SHA-256 | `686e04e31ce5927c776eb4d7f82b28eaab594a1e1ce6c7be54e4ab4da6c8e514` |
| Working inventory hash (968 files) | `3db671e427159de1084270e6653cb45d8973481e193ffc4710b453eb86185f01` |
| Built inventory hash (181 files) | `303624d98a82ca4f4eb8c98610d189e13ed4356d63c8e1706d80b3b751e9b00b` |
| dist/operator/manifest.json SHA-256 (16 assets) | `091fe87cbb50ccee6763adff7fa606bbf3e0467eab57cfa19bfbee8ea8236093` |
| Baseline SHA-256 | `48e13aee419623aeb02b403668fc3cab6b06e57b4252caf1bac118d876d2185d` |
| Approved design packageHash | `b2fc0f89605cc27039044ff6f934cb06ee3180f23f8372ab2f427388ce4e72a7` |
| S5_DESIGN_APPROVED.json SHA-256 | `bd6e49ac7f20692d242c744062f7ae780fedee413f41d5759e912108f6220c60` |
| S4C_APPROVED.json SHA-256 | `0a7f21f676edb3d3f07c921214254003d2625a478a9bc9c0a79f243860b1573b` |

Before and after review: every 968 working-inventory and 181 built-inventory hash matches; no unexpected working/built file is present after the stated current manifest/archive exclusions; all 917 archive entries match exactly, with no missing/extra entry; all 8 approved normative files and both accepted seals match. Before/after preservation JSON is identical. Against the 926-file baseline, only the 6 declared files changed, none was removed; accepted authority/domain/read code, migrations, fixtures and historical evidence remain preserved.

## Optional notes and residual scope

**O1 (non-blocking robustness):** `transport.ts:41` awaits error-body cancellation before returning 401/403. A synthetic ReadableStream with a never-settling `cancel()` makes those statuses become TIMEOUT instead. Native browser-fetch cancellation stalling was not demonstrated, so this is not an additional acceptance blocker. Consider best-effort cancellation without delaying status classification while repairing the transport; test 401/403 and oversized/error-body cleanup if changed.

No authorization/isolation bypass, token DOM/storage leak, unapproved operation, business mutation or new success-audit behavior was found in the reviewed paths. Browser abort remains local and cannot undo server work; already-seen data and compromised same-origin/browser-extension code remain outside the stated boundary. Ask Atlas, S5-B rendering/queue/evidence, LIVE/pilot/deployment and production authentication remain separate gates. Re-review must bind the repaired source, built bytes and refreshed evidence to a new exact artifact; this report accepts none of the dependent work.
