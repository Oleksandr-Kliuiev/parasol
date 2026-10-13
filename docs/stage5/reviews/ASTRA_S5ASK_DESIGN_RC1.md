# S5ASK-DESIGN-rc1 — independent Astra architecture review

Verdict: **CHANGES_REQUIRED**. Required findings R1–R2 remain open. Source implementation remains NOT_STARTED.
The OFF/MOCK direction is implementable and useful as a bounded engineering journey; the two contract gaps below
must be closed before ASK-A. This is not a code acceptance, remote-inference approval, or LIVE/deployment gate.

## Identity and independence

- Reviewer: explicitly assigned native `gpt-6-astra`, effective effort `xhigh`, fresh context, session `/root/astra_s5ask_design_rc1`.
- Native assignment is the available model/effort evidence. Independent response-model/provider telemetry and attributable
  subscription usage are not exposed to this reviewer; no stronger telemetry claim is made. No CLI/API/credits/fallback used.
- No other reviewer's verdict on this artifact was read. No delegation.
- HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`; branch `planning/stage2-m365`.
- Package `79f37a5698e5d02d420af1ed52759f347edeb489032d7072f03459b07421e212`.
- `verification/stage5/S5ASK_DESIGN_RC1_MANIFEST.json`
  SHA-256 `1300034ee49986314958e35eee14d8d228def331f86cdf5c91c8cb2c7a2b4138`.
- `verification/stage5/S5ASK_DESIGN_RC1_PACKAGE.zip`
  SHA-256 `0e39b1acde793c1c589fde171b5b57c37db5a3fe75cf4a9199908039143c2b6a`.
- Baseline SHA-256 `fcf598c3f9b67e35a8c5d32fcd82f3723fd47f8831c756d597d2ba68e0eec22e`.
- Accepted S5B package `0346dc1293e06dfe04c58cda197eb276baedf0784df1aef08f6cd951692f0d6b`;
  seal SHA-256 `2e6b7b27bab868b997a8f93cc80e68d09549da6ee8529a7a2a2ca70016e637e4`;
  closure SHA-256 `4b52961d8ce4d2f3c8781a79003be2adb553bf757093c6f097aeca9eaacd5b2e`.

## Required findings

### R1 — Specify the intent/reference/claim predicate matrix before calling it an exact contract (P2)

Location: `docs/stage5/ask/02_CONTRACTS.md:81–109`, especially 90–97 and 107–109;
acceptance `04_PLAN_AND_ACCEPTANCE.md:33`.

The plan permits zero to eight references and the answer permits several claim codes, but the promised “exact predicate”
for each code is not defined. Kind compatibility and “requires the current focus” do not state whether a focus intent
must select only its required reference, may include other same-kind references, or how all claim references must relate
back to the selected plan. Nor is the result of an empty supported plan against a nonempty bank specified.
These are observable compiler/browser validation decisions, not just internal module choices.

Contract counterexamples (no implementation is claimed):
- Focus is LOW observation E1; a different observation E2 is HIGH. A WHY_URGENT plan selects `[E1,E2]`. Both references
  have the permitted kind and the current focus is present. The contract needs to say whether this is invalid or precisely
  which claims may result; citing E1 somewhere is insufficient to prevent an unrelated E2 urgency explanation for the focus.
- A SUMMARY plan selects `[]` against a nonempty bank. It satisfies the structural plan rule; no rule chooses between
  an empty ANSWER, INSUFFICIENT, or ASK_PLANNER_INVALID. Browser parity cannot independently establish the intended outcome.
- For RESOURCE_RECORDED, freeze the predicate/message meaning for ERROR/MISSING/FIXTURE as a recorded resource state,
  so the code cannot imply that a successful source read occurred merely because a resource fact exists.

Required closure: add a small normative matrix for each intent: allowed plan ref kinds/cardinality, exact focus/tuple/entity
binding, handling of absent required facts versus invalid supplied references, permitted claim codes, and claim ref
predicates/cardinality. Specify ANSWER/INSUFFICIENT/UNSUPPORTED claim rules and whether/how compiler claims may use refs
outside the plan (apart from the separately defined mandatory urgency notice). Add the cases above to Q4 and browser
validation acceptance. This should complete the existing design, not expand its supported questions or inference powers.

### R2 — Define capacity ownership after timeout when underlying work ignores abort (P2)

Location: `docs/stage5/ask/03_SECURITY_AND_STATE.md:40–52`; planner interface
`02_CONTRACTS.md:76`; ignored-abort acceptance `04_PLAN_AND_ACCEPTANCE.md:35`.

The planner is asynchronous; abort is expressly only a courtesy and late ignored-abort results must be handled.
The same contract says to release capacity “on every outcome”, but does not distinguish the public timeout outcome
from actual settlement/termination of the underlying planner or database work. Releasing on the former can defeat the
resource bound even when all public answers and late callbacks are safely discarded.

Contract counterexample: inject a planner that ignores abort and remains pending. Start four requests, let their planner
or overall deadlines return failures, release the four permits, then admit four more requests. Eight planner executions
and their captured request data can now remain live while bookkeeping still reports at most four. Repeating the sequence
can accumulate more work; a rolling admission limit does not give a finite bound when abandoned work never settles.
This counterexample is within the explicit ignored-abort test contract, despite the normal local recognizer being small.

Required closure: define what each global/actor permit owns and its exact release point. Keep abandoned-but-running work
accounted for until it settles or is demonstrably terminated, or specify another bounded execution design that prevents
such accumulation. Public timeout response must remain bounded; do not wait indefinitely to send it. Ensure cleanup
releases once, late completions cannot release a newer request's slot, and actor entries with outstanding work cannot be
evicted. Add a Q6 sequence covering repeated ignored-abort timeouts, pressure from additional actors, eventual settlement,
and capacity recovery. Clarify separately when a question consumes the rolling admission counter.

## Optional clarifications and implementation cautions

- `02_CONTRACTS.md:69–72`: define `observationsRead` explicitly as the active page count excluding the additional focus
  (and excluding a cap+1 sentinel), if that is intended. A full 100-row page plus an out-of-page resolved focus reads 101
  observations; the current 0..100 range and “source read before bank reduction” wording otherwise pull in different directions.
- The invalid-source requirement already forbids silently accepting repaired input. Preserve it before invoking inherited
  mapping helpers: `packages/graph/context-mapper.ts:40–53` defaults an unknown system to Atera and truncates summaries;
  lines 75–84 convert malformed snapshot items to ERROR. Validate original selected inputs first, then use the reviewed
  projection/status semantics. Do not mistake those existing mapper fallbacks for the new Ask validation contract.
- A brief failure/finalization table would make audit obligations easier to implement: planner invalid/timeout with budget
  remaining, source/projection failure, exhausted original deadline, final authentication/scope loss, and uncertain commit.
  Retain the specified fail-closed rules and no retry. Real PG acceptance must exercise expiry after audit-related waits,
  not only after the fence wait; the design requires a DB-clock check after all lock waits and before final return.

## Source-backed assessment

The following existing contracts support the proposed architecture:
- `packages/auth/token.ts:8–19`, `transaction-token.ts:19–26`: bounded bearer syntax/digest and current nullable-expiry
  lookup using the DB clock. The existing HTTP `ApiTokenGuard` uses `authenticateToken`, which is not itself the new
  fenced admission; the Ask-private path must retain the two current checks specified in the design.
- `packages/actions/authority.ts:77–121`: existing clear-GUC, workspace hint, fence, readiness, current actor/membership,
  admitted RLS and committed-denial pattern. Its transaction wrapper/Number epoch should not be reused unchanged.
- `packages/graph/fence-role.ts:55–70,162–183` and narrow excerpts of the accepted Stage3 fence migration confirm the
  required Actor/ApiToken/ClientMembership/Connection mutation triggers and readiness surface. FOR SHARE conflicts with
  the trigger's fence UPDATE; releasing the first transaction before planning and reacquiring the fence is feasible.
- `apps/api/src/db/database.ts:15–20` and `packages/graph/runtime-role.ts:170–193` retain the established confined-role
  startup check. Ask need not add a PowerOffice-specific admission dependency or change any grants/migrations.
- `packages/graph/prisma-context.ts:31–51`, `context-mapper.ts:33–117`, and `packages/observations/query.ts:35–60` establish
  active priority order, resource freshness/status semantics, separate read times and the existing projection boundary.
  A focused same-transaction reader avoids nested scope transactions and unnecessary global observation counts.
- `packages/audit/{sanitize,prisma}.ts` already provide the required metadata keys, escaped denial text and client row builder.
- Browser `validate-{context,observations,resources}.ts`, `entities.ts`, `operations.ts`, `credential.ts`, `transport.ts`,
  and `controller.ts` support explicit projection, fixed operations, safe status handling and generations. Ask must add its
  own stricter response predicates and retain existing console behavior. API `main.ts`, fixture module and DB composition
  were checked narrowly for parser/route integration; no parser or route was changed.

The real free-text HTTP/UI journey with four documented exact RU/EN intents is useful MOCK engineering and honestly
labelled. It does not establish general language understanding. Source urgency is independent of route/confidence;
bounded coverage and an additional exact focus can be represented; included display strings remain potentially sensitive.
No external planner, arbitrary tool, finance/M365 read, or new credential is needed. Actual authorization/race/runtime
proof remains an ASK-A/ASK-B obligation. Read admission is not an atomic source snapshot or revocation of delivered bytes.

## Preservation and verification

Before review, `/tmp/atlas-stage5/verify_s5ask.py 1` matched all 1041 working and 197 built files, package and archive.
Independent comparison verified the 1032-file baseline: only the five declared administrative files changed; nine declared
preparation paths were added; no source/test/build delta. S5B archive entries, manifest/seal/closure hashes, closure admin
deltas and preserved source/build inventories matched. All eight accepted console normative files remain byte-identical.
After review, external `verify_identity.py` repeated these checks and verified complete Git-visible and built-file path sets;
only the two self-excluded RC1 manifest/archive paths lie outside the working inventory. `PRESERVATION_AFTER.json` records it.
No tests, builds, DB access, schema operations, network/model/vendor calls, credential/private-config reads or checkout/dist
writes were performed. Only the report and identity probe/evidence under this external review directory were written.

Required next gate: close R1/R2 in a newly identified package and obtain both independent architecture approvals on that
same artifact before ASK-A implementation. This verdict does not itself authorize source changes.
