# Ask Atlas — scoped read-only contract

RC3 candidate, architecture approval PENDING. Owner progression: accepted operator console → Ask Atlas contract.
The accepted console is S5B-rc1 package `0346dc1293e06dfe04c58cda197eb276baedf0784df1aef08f6cd951692f0d6b`.
This additive package governs only the Ask endpoints/modules/UI described here; existing Stage1–4 and console contracts
stay controlling elsewhere. It does not reopen accepted migrations, source adapters or decision classification.

| Concern | Entry |
|---|---|
| User questions, useful first slice and explicit MOCK boundary | [01_SPEC](01_SPEC.md) |
| HTTP, evidence bank, planner and compiled-answer contracts | [02_CONTRACTS](02_CONTRACTS.md) |
| Current authorization, privacy, deadlines and browser isolation | [03_SECURITY_AND_STATE](03_SECURITY_AND_STATE.md) |
| Implementation boundaries and acceptance | [04_PLAN_AND_ACCEPTANCE](04_PLAN_AND_ACCEPTANCE.md) |

Source basis: accepted browser `apps/operator/AGENTS.md`; API `apps/api/src/db/{auth,clients,tools}.ts`;
`packages/graph/{prisma-context,context-mapper,scoped-db}.ts`; `packages/auth/{token,transaction-token,authority}.ts`;
authority fence `packages/graph/fence-role.ts` and accepted Stage3 triggers; audit `packages/audit/{sanitize,prisma}.ts`.
Existing `packages/decisions/provider.ts` classifies an event; it is not an Ask provider and must not be widened or reused
to submit arbitrary questions. The existing Decisions input redaction remains unchanged.

No code/application/DB suite is needed for design-only preparation. Freeze exact package/source-baseline/dependency
hashes; obtain fresh independent Astra/xhigh and native actual Fable5.1/high reviews of the same artifact. Original
reviews and failed iterations remain evidence. A contract approval is not acceptance of implementation or remote inference.
