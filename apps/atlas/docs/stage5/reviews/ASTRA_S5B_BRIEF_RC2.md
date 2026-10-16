# Independent S5-B implementation-brief review — RC2

**Verdict: APPROVE.** R1 and R2 are closed. No required brief findings remain. Approval covers the concrete implementation brief within the already approved Stage5 architecture; it is not acceptance of S5-B source code or rendered behavior.

Reviewer: native Codex subagent `/root/astra_s5b_brief_rc1`, continuing its own bounded review with explicit **gpt-6-astra / xhigh** assignment. Effective effort remains **xhigh**, with no claimed reduction on the resumed session. Native assignment is the available qualification; independent underlying response-model telemetry and attributable subscription usage are not exposed. No fallback/API-credit route or other reviewer's current-artifact verdict was used.

Repository: `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`; HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `planning/stage2-m365`. Reviewed 2026-10-10 UTC.

## Exact approved artifact

| Artifact | SHA-256 / package identity |
|---|---|
| `docs/stage5/S5B_IMPLEMENTATION_BRIEF_RC2.md` (136 lines) | `24ba441d2ecf36fd83417ad57caec70a66e634bab3dfd8bcf4b072e0bae04732` |
| Nine-file RC2 package | `5beba7475918ed55458084804265e6fab91186762ef78e47d9ce1143878d795f` |
| `verification/stage5/S5B_BRIEF_RC2_MANIFEST.json` | `beb923cda1fdfc8a7090805f66d4016cddac46116b3a4b0cb4e359a8978fd95d` |
| `verification/stage5/S5B_BRIEF_RC2_PACKAGE.zip` | `b977273a353cf5d4c2cb6404ff35ad47020b459af3d0120ad918c91786cdf2da` |
| 991-file working inventory | `fa52c07733067df62fff46b34871f0bd29604f4d8301c0d2c3ad5be065e5d6ab` |
| 181-file built inventory | `c621ace2398a4916695b6e953bef9143ef777fb21dc823b4bcb76ebc316f72c8` |
| `verification/stage5/S5B_BASELINE.json` | `ad0f8b6677bd4a4662c58d7362a3bf05b62692ff304dd12e9e1b43cd4cc969ad` |
| Controlling eight-file Stage5 RC3 architecture package | `b2fc0f89605cc27039044ff6f934cb06ee3180f23f8372ab2f427388ce4e72a7` |
| Accepted design seal | `bd6e49ac7f20692d242c744062f7ae780fedee413f41d5759e912108f6220c60` |
| Accepted S5-A seal | `93fe2b27aad04bdfc257ee920b566a81099370dbd5c75792b222d3675f998aa7` |
| Accepted S4-C seal | `0a7f21f676edb3d3f07c921214254003d2625a478a9bc9c0a79f243860b1573b` |

## Closure and nearby regression review

**R1 CLOSED — operation-specific response status.** RC2 lines 70–72 explicitly require HTTP 200 for GET and HTTP 201 JSON ResourceView for evidence POST; they preserve content-type, redirect, body, deadline and 401/403 guards, prohibit arbitrary 2xx acceptance/server status changes, and require actual fixture/DB 201 positives plus a focused GET-200-only regression. This matches the existing controllers (`apps/api/src/atlas.module.ts:76`, `apps/api/src/db/tools.ts:30`), the pinned Nest default and `tests/pg/api-input.pg.test.ts:89–96`. Re-ran the independent, request-free compiled-controller/status probe: both POST handlers resolve to 201, while frozen S5-A GET transport accepts 200 and rejects 201. That existing GET behavior is a preserved baseline, not a new S5-B implementation defect.

Nearby requirements remain intact: exact closed tool/body allowlist; validated connection/source identifiers; private bearer injection; same-origin/omit/no-store/redirect-error/no-referrer; original deadline and byte cap; explicit action and fresh request ID; no automatic retry; captured tuple and mode validation; actual Gateway/audit outcomes; no server/API modification.

**R2 CLOSED — synthetic visual evidence.** RC2 lines 130–132 now require synthetic visual PNGs after clearing the password INPUT and verifying token-free DOM/capture. They expressly allow the synthetic session to remain connected for queue/detail/evidence screenshots, prohibit trace/HAR/video and credential-bearing captures, and allow safe reports/logs without tokens, Authorization, private URLs or raw sensitive diagnostics. This resolves the former outright screenshot prohibition and explicitly clarifies the nearby “after token cleared” shorthand at line 126. The 320/768/1440 visual requirement, B9 evidence and memory-only credential/reset boundaries remain unchanged.

**Existing queue rule made explicit.** RC2 lines 45–46 require every DB queue item to match the captured status/severity selection and page length to fit the requested limit. This restates `docs/stage5/02_CONTRACTS.md:37–38`; it does not add a server consistency guarantee. The independent 100-item cap, duplicate-ID rejection, fixture active/no-query/no-pagination behavior, original server ordering, cursor resets, page replacement and non-atomic response semantics remain intact.

The exact RC1→RC2 diff has four bounded hunks: status metadata; the existing queue validation rule; R1 status policy/checks; R2 artifact wording. No other projection, operation, state, scope, ownership or acceptance requirement changed. The RC1 assessment of B1–B9 and A1–A8 preservation remains applicable.

## Independent preservation evidence

Before and after review, independently verified all nine package files, all 991 working files and all 181 built files against the current manifest, with no added/missing paths or mismatches. Recomputed package and inventory identities and checked all RC2 archive members. Both verification results are identical apart from their timestamps.

All 986 RC1 working-inventory files, all 984 preparation-baseline files, the accepted S5A-rc2 working inventory after its four recorded administrative closure deltas, and accepted built output match. All eight normative files, accepted seals, prior manifests/archives and their checked archive members remain unchanged. The original RC1 brief hash is unchanged; the repository copy of the RC1 review matches `778a98594088e551f9e578e444588b5ea925edae31f03012d94bce7eef2da22b`.

The five additional RC2 inventory entries are the new RC2 brief, RC1 review and assignment, plus the RC1 manifest/archive formerly self-excluded from its own inventory. No original file was modified. All reviewer outputs are outside the repository under `/tmp/atlas-stage5/`.

Evidence: `/tmp/atlas-stage5/astra-s5b-brief-rc2/verify-frozen.py`, `before-verification.json`, `after-verification.json`, and `status-probe.json`. The status probe source remains `/tmp/atlas-stage5/astra-s5b-brief-rc1/status-probe.mjs`.

## Gate classification and remaining work

RC2 remains wholly inside the accepted eight normative documents. These corrections restore/clarify existing contracts and do not change architecture, authority, data boundaries or public server behavior. **No new dual Astra/Fable architecture amendment is required for this brief.** The exact approved RC2 identity may be used for the authorized S5-B implementation after the required dependency/identity and sole-writer handoff checks.

S5-B code has not been implemented or accepted by this review. The initial actual-code acceptance must use a separate fresh explicit Astra/xhigh reviewer and the required implementation, browser, PG, audit, visual and negative-control evidence. No broad test suite, build/generate, DB/server/browser run, source mutation or vendor/model request was performed at this source-free gate. The bounded probe used only frozen compiled code and synthetic in-process responses. Existing credential, abort/server-work, context-cap and fixture qualifications remain. Ask Atlas and LIVE/pilot/deployment remain excluded.
