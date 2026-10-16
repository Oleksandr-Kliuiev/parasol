# Independent RS-A brief review — RC2

**Verdict: CHANGES_REQUIRED.** My original R1–R5 are closed at the brief level. One bounded P2 feasibility finding remains (RC2-F1). It needs a wording/check correction within RC4, not a fresh architecture gate or expanded scope.

## Identity and review boundary

- Artifact: `S5ASKREMOTE-REVAL-RSA-BRIEF-rc2`.
- Package SHA-256: `c752398dea2c9eed10a2a9b0346e68011d4a085210487915885d16cf4893cfdb`.
- `docs/stage5/ask/remote/reval-server/rs-a/IMPLEMENTATION_BRIEF.md`: 430 lines; SHA-256 `ec46a59c5abdb85042968daf174effab31a538c1449fbd8ea2e94a3d9ce45b3e`.
- Companion `docs/stage5/ask/remote/reval-server/rs-a/ACCEPTANCE_CHECKS.md`: 127 lines; SHA-256 `76832c356a4d5193b71dd6e2c546d7460c9fc2e6c5bfd3824ed46268009446b8`.
- ZIP SHA-256: `573968b5817337679c0e895e73863df07e9214b7a9c439199a06e253c5350127`.
- Parent RC4 SHA-256: `9fa16222d6c32c18d4d193b6666e078fd3624a4bdb2ccb8ab9fbd68113b08163`.
- Continued only my own independent RC1 reviewer session for this bounded repair review; explicit native assignment remains `gpt-6.1-sol` / `xhigh`. Explicit launch assignment is launcher evidence. Independent backend response-model/effort telemetry, attributable usage, billing/quota attribution and precise elapsed telemetry remain unavailable; none is inferred from self-identification.
- No other review report, private status file or author conversation was read. The candidate's embedded closure-map/classification statements were not relied on as evidence; closure was checked against its actual normative requirements and current entry files.
- Read-only: no repository edits, code implementation, tests, DB connections, network/provider calls or activation. Only this report was written.

Recomputed the compact path-sorted manifest hash: it matches the stated package identity. All 44 listed current files and ZIP members match their hashes. Relative to RC1, only the brief changed and the acceptance-checks companion was added. All 1540 baseline entries, all 38 parent RC4 entries and all 120 execution RC5 entries remain unchanged. The native Unix PG fixture entry in CHECKS is correctly labeled preflight only, with `candidateImplementationTested:false`; this review did not inspect or execute that fixture.

## Original finding closure

| RC1 finding | RC2 disposition |
|---|---|
| R1 actual S/runtime and executor DB binding | **Closed for the brief.** §2b removes endpoint authority from secrets; §2e authenticates a child before any secret/DB access; §3 fixes reader/S/E to one Unix endpoint, independently compares physical facts, bounds S mode, refuses mismatches before listen/owner effects, and supplies meaningful wrong-DB/copied-ID tests. Runtime pool/socket-swap qualifications remain UNVERIFIED, not complete image/process proof. |
| R2 executor lifetime/orphan cleanup | **Closed for the brief.** §6 supplies one 1800 ms C budget, sub-deadlines, a hard E timer, parent-EOF handling, one-spawn semantics, bounded kill/reap/backend cleanup, COMMIT_UNKNOWN latch and actual child/owner-backend absence checks. These are requirements to prove during code acceptance, not runtime results. |
| R3 executable pricing/grants | **Closed.** §7 distinguishes policy constants from actual attempt rate/reservation columns; §8 includes both attempt rate SELECT grants; pricing remains internal and comparison covers all project attempts. Checks require positive confined-definer execution, parity and historical/mixed-price failures. |
| R4 effective EXECUTE allowlist | **Closed.** §8 explicitly preserves the exact accepted PUBLIC SECURITY INVOKER helper set, forbids explicit helper grants/other routines, mirrors SQL/TS lists and tests new PUBLIC, definer-substitution and schema-name spoofing drift. Ancestor ACLs and remote-nine/reval-two counts stay fixed. |
| R5 Prisma inverse-relation scope | **Closed.** §5/§10 authorize a cohesive new `prisma/reval.prisma` plus minimal virtual inverses in the actual existing model files, with validation/drift/populated-upgrade checks and resealed accepted-file deltas. |

Nearby repairs preserve existing invariants: explicit login-OID selection after clearing stale GUCs; missing referenced counter refuses instead of zero-filling; orphan rows count toward the bound and are reconciled; owner-only ALWAYS guard closes the migration/default-grant window; real PTY test entries keep production TCP/TTY/peer relaxation unreachable; confirmed NOOP must call the accepted owner routine and COMMIT before reread/floors; any post-commit reread failure latches uncertainty. Four-key closure and no retry/refund/activation remain intact.

## Required finding

### RC2-F1 — P2: Specify inherited descriptors separately from ordinary runtime descriptors

**Location:** `IMPLEMENTATION_BRIEF.md` line 106; `ACCEPTANCE_CHECKS.md` line 108 (also the helper exception wording in brief §2).

The brief says C/S/E “hold fds 0–3 only,” and the required live launch check repeats “C/S/E fds 0–3, helper 0–4.” This cannot be a literal live-process descriptor invariant. All four stdio slots are already occupied at spawn; the required PostgreSQL connections necessarily open additional descriptors. Node/libuv also opens its own event-loop/signal descriptors, and C opens transient helper/child handles. CLOEXEC prevents a descriptor being inherited across exec; it does not prevent a process opening legitimate descriptors afterward. The mandatory check as written therefore cannot pass for the required running topology.

**Required repair:** state that only the intentionally inherited cross-process application handles are 0–3 (the native helper additionally receives fd 4). Prohibit unintended inherited handles, while explicitly accounting for newly opened DB sockets, Node/libuv internals and bounded child/helper handles. Align the live test with that boundary: prove no secret/owner connection or unrelated inherited file descriptor crosses O→C, C→S or C→E, rather than asserting an impossible total FD range. Keep full destination/process proof deferred to RS-D.

**Acceptance criterion for the repaired brief:** exact launch inheritance allowlist and a feasible targeted inheritance/leak test are specified; live required DB/event-loop descriptors are allowed and classified. No change to authority, credential separation, exported schemas or architecture is needed.

## Nonblocking notes

1. The companion filenames embedded in the documents are stale: brief line 6 says `RS_A_ACCEPTANCE_CHECKS_RC2.md`, while the actual file is `ACCEPTANCE_CHECKS.md`; the checks header names `RS_A_IMPLEMENTATION_BRIEF_RC2.md`, while the actual file is `IMPLEMENTATION_BRIEF.md`. Correct these while repairing RC2-F1 so the implementer receives unambiguous normative entry paths.
2. §8 must retain RC4's complete effective capability checks, including schema/database CREATE, ownership, grant options and nonstandard built-in escalation; the new relation/routine lists are not a reason to narrow that inherited requirement. No additional role or ancestor ACL is admitted.
3. Convert E's deadline without extending C's absolute monotonic budget when wall time moves. C's hard deadline/kill and parent-loss handling remain authoritative. Keep timing/cleanup failures as findings, not relaxed thresholds.

## Gate and residuals

The bounded repairs remain within accepted RC4. A1–A9 retain my RC1 classification; A10's NONE mode does not create a positive server identity, and its C-produced factual SNAPSHOT/PAUSE_EXPORT have no server self-report dependency. No critical invariant or new implementation scope was added that requires a fresh architecture review. A future proposal to weaken endpoint/peer/credential/finance/public-contract rules would change that assessment.

This report accepts no code or runtime evidence. Actual Darwin peer/PID-version, exact grants/RLS/concurrency, native Unix binding, helper/build reproducibility and the stated deadline/lifetime tests must pass on the later exact code artifact. Native fixture availability is preflight, not proof of the candidate. Full image binding stays UNVERIFIED; `verifiedPass`/`liveAcceptanceEligible` stay false. RS-B/C/D and human/account/key/data/budget/evaluation/customer/deployment admissions remain separate. Paid product calls: 0; activation: none.
