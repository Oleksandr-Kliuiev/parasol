# Independent RS-A brief review — RC3

**Verdict: CHANGES_REQUIRED.** RC1 R1–R5 remain closed. RC2-F1 is closed in the brief's inheritance rule but remains partly open in the required acceptance check. One bounded P2 wording/check repair is required; no new architecture gate or implementation scope is needed.

## Exact identity and independence

- Artifact: `S5ASKREMOTE-REVAL-RSA-BRIEF-rc3`.
- Package SHA-256: `5fb55a6846327aab4b55ad04be6104bd2ff2c847aee919ec81e03883ab4fe343`.
- `docs/stage5/ask/remote/reval-server/rs-a/IMPLEMENTATION_BRIEF.md`: 462 lines, SHA-256 `c45fdfd8b972c721d039fa80945e9fd38509bdc49e85990883f63eb1b9c7791c`.
- Companion `ACCEPTANCE_CHECKS.md`: 153 lines, SHA-256 `19cedcebdb291796afb2bdbdf01ece0339c7052442609bd69cb781d17eb79608`.
- RS-A routing `AGENTS.md`: SHA-256 `58373835834fd2a89adcfd7bcc7913013f2ea8dd73285443dec0fd5d3faa1097`.
- ZIP SHA-256: `0622a0c99e76750f2b87cef28515f745c71ec897f9341dc5486205b42770339e`.
- Accepted architecture RC4 package: `9fa16222d6c32c18d4d193b6666e078fd3624a4bdb2ccb8ab9fbd68113b08163`.
- Continued only my own independent review session at explicitly assigned native `gpt-6.1-sol` / `xhigh`. Explicit assignment is launcher evidence. Independent backend response-model/effort telemetry, attributable usage/billing/quota attribution and precise elapsed telemetry remain unavailable; no backend attestation is inferred.
- Compared the exact RC2→RC3 package delta and retained requirements, plus the relevant existing owner revision routine/build entry. No other reviewer report, author conversation or private status/fixture file was read. No code, test, DB, provider or network action was performed. Only this report was written.

Recomputed the 44-entry package hash and verified every current file and ZIP member. Only the brief, checks companion and RS-A routing file differ from RC2. All 1540 baseline entries, 38 parent RC4 entries and 120 execution RC5 entries remain unchanged. CHECKS correctly labels the native cluster as preflight with `candidateImplementationTested:false`.

## Closure and bounded compatibility

The brief now correctly distinguishes intentionally inherited application descriptors (0–3; helper fd 4 and stdout at its normal fd) from post-exec DB/libuv/listener/child/file descriptors. Stale companion filenames are fixed and routing names both normative documents. The executor uses a clamped relative monotonic budget with C's absolute deadline/kill authoritative; password-string persistence is disclosed honestly. Effective capability checks remain explicit for both roles.

The new policy-preservation rules stay inside RC4: preserved parameters go directly from the locked SQL row into the existing revision routine, avoiding JavaScript Date microsecond loss; PAUSED must remain a whole-row no-op, while ACTIVE/INACTIVE must make the exact owner pause transition. Only policyVersion/state/stateReason/revisedAt may differ on the applied path. Required microsecond/runtime-reason/mutation tests make this reviewable without changing any accepted routine. The native fixture evidence run now requires the unmodified production O→C→built main→E→helper chain, real PTY, positive snapshot/applied/no-op closure and physical mismatch negatives, with no skip or DI substitution. `apiEntry` is bound to the manifest entry. None of these changes grants authority, activates a policy outside synthetic test setup, changes finance/public contracts or opens later checkpoints.

## Required finding: RC2-F1 remainder — P2

**Location:** `ACCEPTANCE_CHECKS.md` lines 117–121.

The mandatory check still says each child reports, “at its first instruction” through a test-only entrypoint probe, **every** open descriptor as exactly 0–3 (helper 0–4 plus stdout) “and nothing else”; it classifies legitimate runtime descriptors only later. A TypeScript entrypoint's first instruction runs after Node/libuv native initialization has already opened event-loop/signal/runtime descriptors. The corrected brief expressly permits those descriptors after exec. Moving an impossible total-FD-range assertion to the first JavaScript instruction does not make it an inheritance measurement.

**Required repair:** make the entrypoint probe classify already-open Node/libuv runtime descriptors immediately and compare the identities of intentionally inherited application handles/parent sentinels, without asserting a total open-FD range. Require that the parent's deliberately held DB socket, secret/config file, listener and unrelated child channel do not appear in the child. A deliberate extra-handle injection should fail the leak detector, proving the test is meaningful. Alternatively use a genuinely pre-runtime native observation, clearly distinguishing it from a TS first instruction. Keep the production inheritance allowlist and credential isolation unchanged. The helper's stdout pipe is fd 1, not an extra descriptor beyond 0–4.

**Closure criterion:** the mandatory check can pass with ordinary Node/libuv initialization and required DB sockets, yet fails an unintended inherited parent handle. This is a bounded test-specification correction within NB5, not a relaxation of isolation or a fresh architecture concern.

## Nonblocking implementation notes and residuals

- Treat the fingerprint notation in brief §6 as mathematical shorthand: PG17's built-in SHA-256 takes bytea. Use schema-qualified typed built-ins, for example `pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(p)::text,'UTF8')),'hex')`, rather than requiring a new extension or `sha256(text)` overload. The “no policy values in JS” wording concerns preserved/private arguments; the explicitly allowed state/version/fence scalars still cross as specified.
- PostgreSQL `pg_stat_activity.pid` identifies the database backend, not C's OS PID. Link observed backend identities and credential/connect spies carefully; a pid equality alone cannot prove C has no owner/runtime connection. Complete independent process attribution stays RS-D.
- Actual code acceptance must prove the full mandatory suite, native production-chain fixture, peer/PID-version, role/RLS/concurrency, deadline/lifetime and reproducible build/helper requirements on one exact new artifact. This brief review supplies no runtime pass. Fixture results remain test evidence, `loadedBinding:'UNVERIFIED'`, never complete platform/image proof.
- Helper TOCTOU, runtime socket/pool recheck limits, same-UID/root/kernel trust, short-lived password strings and closure dependence on census/binding bounds remain disclosed. `verifiedPass`/`liveAcceptanceEligible` stay false. RS-B/C/D and human/account/key/data/budget/evaluation/customer/deployment admissions remain separate. Paid product calls: 0; activation by this review: none.
