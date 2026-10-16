# Scope and boundaries

## Product outcome

A connected operator asks a natural RU/EN question about the selected client's bounded stored Atera/Huntress read.
Remote classification admits only SUMMARY, WHY_URGENT, SOURCE_STATE, ENTITY or UNSUPPORTED. Equivalent paraphrases
can now work without a fixed phrase match. Unsupported requests, ambiguous/multiple intents, another client/person,
root cause, remediation, exhaustive history, M365/finance or external research must classify UNSUPPORTED.
No model-created prose is displayed. The exact existing claim compiler, source validation, coverage, urgency and
request-local citation cards remain authoritative. This is a bounded semantic improvement, not a general chatbot.
Semantic classification can still be wrong; schema validity does not prove understanding. R-EVAL is a release gate.

The provider sees only `{question,hasFocus}` in a fixed developer/user message pair. It receives no evidence bank,
summary, name, email, source ID, E-ref, timestamp, client/workspace/actor/request/correlation ID or business record.
hasFocus is true exactly when the finalized bank contains the explicitly requested focus observation. No text lookup
resolves a name or changes the selected scope. All information about actual facts stays within Atlas.

## Admission and compatibility

`ATLAS_ASK_MODE` becomes off|mock|remote only after implementation of this approved amendment. Off remains default;
mock remains local, byte-compatible and key-free. Unknown configuration fails startup. Remote is DB-only; fixture
startup with remote fails. Disposable DBs contain synthetic registered workspaces/clients. Remote startup verifies
schema/runtime-role readiness but does not provision or activate policy. Missing/inactive admission leaves remote
unavailable and never enables a fallback. No existing OPENAI_API_KEY, Decisions config or subscription token activates it.

Separate owner admission binds one dedicated OpenAI project/key to one workspace, the exact provider profile,
EU endpoint, verified account retention controls, synthetic dataset/client allowlist, fixed price revision/expiry,
budget and consent disclosure version. Zero active admissions are shipped. One key/project cannot be shared across
workspaces or Decisions; no self-service browser admission. Owner/operator provisioning is a separate trusted
operation described in the runbook and reviewable as metadata before execution. No account modifications now.

Remote POST requires BOTH `context:read` and new `ask:remote` on the same current client membership, plus active
workspace/client policy and per-question acknowledgement. A new migration extends the current permission CHECK
without granting it to any actor. Existing routes still enforce their original permissions. Source reads remain
read-only; new financial/governance writes are isolated to remote admission/attempt/counter tables and audit.

## Explicit amendment deltas

| Parent restriction | Narrow remote exception |
|---|---|
| No provider network/keys | One private fixed HTTPS OpenAI intent request, only after durable current admission |
| Question stays local | Original question + one boolean sent only with version-bound explicit acknowledgement |
| No new permission/schema/ledger | Add `ask:remote`, isolated admission/counter/attempt tables, focused RLS/grants |
| Existing role/readiness surface | Add one confined remote definer with scoped fence-column UPDATE; exact grants/readiness and PUBLIC routine ACL checks expand; existing fence definer/policies remain unchanged |
| Ask V1 is mock-only | New V2 remote DTOs; V1 remains mock-only and unchanged |
| Local planner outputs refs | Remote outputs only intent; local deterministic selector supplies refs |
| Provider audit label fixture | Remote uses fixed `openai`/`ask-remote-intent-v1`; no question or plan in audit |
| No work after terminal | Financial-only settlement may drain after terminal; never new reads/answers/audits |
| ASK-B typing during pending work | In REMOTE only, a question edit invalidates pending work and consent; MOCK typing behavior stays unchanged |

The original8s server deadline, private raw/auth ingress, ≤4 underlying owners, ≤1 owner/actor, ≤64 actor entries,
10 questions/rolling60s, each DB phase≤2s and provider phase≤2s remain. Browser original10s remains. Additional
egress-admission and settlement phases consume the SAME original request budget before publication; exhausted time
fails closed. An ignored abort retains the task owner until transport and financial/DB cleanup genuinely settle.
No claim that a remote timeout cancels provider processing/billing or erases a question already sent.

Engineering approval admits only offline implementation and synthetic local verification. R-EVAL additionally needs
explicit owner data/budget admission; real client questions/data require a later reviewed live admission. Operator
synthetic attestation is a policy declaration, not technical PII detection. No deploy/PR/commit is implied here.
