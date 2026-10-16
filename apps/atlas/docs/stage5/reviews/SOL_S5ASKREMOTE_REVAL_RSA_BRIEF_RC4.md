# Independent RS-A brief RC4 review

**Verdict: APPROVE_BRIEF. Required findings: 0.**

This accepts the bounded implementation brief and its required acceptance checks. It is not implementation acceptance, activation approval, or a platform/image proof.

## Exact artifact and review identity

- Artifact: `S5ASKREMOTE-REVAL-RSA-BRIEF-rc4`.
- Recomputed package hash: `e8f87336b1cf7e0ba7b18702378f3a6efb877b20e5d9aa4e9a96ee175bf85040`.
- ZIP SHA-256: `0b82e1cb39e1f9889879f05b3526ab2becb4003e912993b919c4f31938b8d636`.
- `IMPLEMENTATION_BRIEF.md` (469 lines): `caa8a5b446d3efa21aa07ae6574647e6425cbc9fb05bda423fad364c4e902aaa`.
- `ACCEPTANCE_CHECKS.md` (174 lines): `5b2b3062b9ee9fa0e5ce2c92d55f5a7416c14c91830465db61b9ed507955e410`.
- Accepted architecture parent: `S5ASKREMOTE-REVAL-SERVER-DESIGN-rc4`, `9fa16222d6c32c18d4d193b6666e078fd3624a4bdb2ccb8ab9fbd68113b08163`.
- Bounded prior brief: RC3, `5fb55a6846327aab4b55ad04be6104bd2ff2c847aee919ec81e03883ab4fe343`.
- Reviewer assignment: native Codex `gpt-6.1-sol` / `xhigh`, continuing this reviewer's own independent session. Explicit native launcher assignment is the available identity evidence. Backend response-model/effective-effort telemetry, provider billing attribution, subscription usage and attributable token/elapsed telemetry are not exposed here; none is independently attested or inferred from self-identification.

The review used the active root/workflow policy, the exact normative artifact and its checks, and narrowly necessary accepted source/contracts. No other reviewer's verdict, author conversation, private status, credentials or fixture contents were read. Repository access was read-only; the only write is this report.

## Static verification

All 44 current manifest entries and all 44 ZIP entries match their SHA-256 values. Recomputing the manifest's compact, path-sorted JSON hash yields the exact package hash above. The RC3-to-RC4 normative delta consists only of the two documents above; no entries were added or removed.

The 1540-file implementation baseline, 38-file architecture parent and 120-file `S5ASKREMOTE-REVAL-EXECUTION-rc5` manifest match their current files. Execution RC5 remains `5c6a7e521220b703ca78efd045376f7ac98e41c613e17e766b0eadc27b994d97`. The baseline records HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `codex/reval-server-contracts-20261011`.

The CHECKS metadata accurately describes static/preflight evidence rather than candidate runtime proof. I did not run tests, access a database, invoke providers or use the network.

## Closure of my remaining finding

**RC2-F1 / RC3 carry-forward: closed at brief level.** `ACCEPTANCE_CHECKS.md:123–146` now distinguishes intended inherited application handles from descriptors Node/libuv has already opened before the first JS instruction. It requires classification of the visible inventory and comparison against stable parent sentinel identities, explicitly forbids a total-fd-count/range assertion at any JS point, and requires a deliberately inherited extra sentinel to make the detector fail. Later database/listener/runtime descriptors are classified. The production helper stays unmodified and is inspected externally during a test-only paused invocation. This is feasible and directly tests the inheritance concern without demanding an impossible Node descriptor inventory.

The original R1–R5 closures remain intact: actual reader/S/E physical checks, bounded owner-executor lifetime, exact pricing-rate grants, compatibility with the accepted PUBLIC invoker-helper surface, and the necessary Prisma inverse relations are still specified. No reopened required finding was identified in the nearby changes.

## Nearby changes and compatibility

- **Actual owner/RLS evidence:** every PG/native case running E now requires the dedicated actual table owner with `NOSUPERUSER NOBYPASSRLS`; that principal runs migrations and the nonsuperuser roles branch. The administrator is limited to bootstrap/cleanup and is excluded from owner config and spawned processes. Recording actual owner/runtime/reader flags, a positive scoped closure and the scope-omission refusal addresses the FORCE-RLS test blind spot.
- **Policy preservation and confirmed closure:** the revise statement must return exactly one row with the state-appropriate version; zero, multiple or unexpected results roll back and cannot become a no-op closure. SQL fingerprints explicitly encode JSONB text with `convert_to(...,'UTF8')` before `sha256`. Locked preserved arguments stay in SQL, retaining microseconds. PAUSED requires a whole-row no-op; ACTIVE/INACTIVE requires the applied pause with only the four allowed columns changed. Confirmed COMMIT and the exact reread/floors remain mandatory.
- **Connection attribution:** fixed role-specific `application_name` values make backend observation reproducible without treating PostgreSQL backend PID as the C process PID. Credential-absence spies and argv/env/channel sentinels remain required. Visibility limitations must be recorded honestly rather than weakening grants.
- **Credential residual:** the text now explicitly acknowledges that the reader password string may reside in C until GC/exit, alongside the runtime/owner string residuals in S/E. Buffer clearing is not represented as erasing those strings.

These are bounded test/implementation clarifications inside accepted architecture RC4. They do not grant new authority, change public contracts, expand data/provider admission, or weaken peer/physical/financial/closure invariants. I found no material architecture exception requiring a fresh Astra/Fable decision in this delta. My prior bounded classification of A1–A9 remains applicable; this verdict approves no architecture exception.

## Residuals and stopping boundary

Actual implementation must satisfy the required suite and produce concrete evidence for the descriptor detector, dedicated nonsuperuser owner, real Darwin peer PID/incarnation checks, physical connections, timing/cleanup, strict frames and both confirmed-commit closure paths. Those tests are not proven by this brief review.

The declared native PostgreSQL 17.11 Unix-socket fixture is preflight availability only. The eventual evidence run must exercise the unmodified production chain with the fixture supplied and no skip; Docker/TCP remains isolated test injection. Neither fixture route establishes loaded-image binding or MEASURED production evidence. `loadedBinding:UNVERIFIED`, `verifiedPass:false` and `liveAcceptanceEligible:false` remain honest limits through this checkpoint.

RS-A remains the full bounded checkpoint. RS-B/C/D, paid product calls, activation, customer use and deployment remain outside this acceptance. The independent actual-code/evidence gate is still required after implementation. Later changes to reviewed content require review of the affected exact artifact.
