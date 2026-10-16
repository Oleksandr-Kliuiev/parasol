# Independent architecture review: S5ASKREMOTE-DESIGN-rc1

**Verdict: CHANGES_REQUIRED. Required open: R1. Required closed: none.**

The question-only intent boundary, deterministic local reference selection/compiler, V1 compatibility, explicit synthetic-only consent, committed one-use egress admission and conservative durable accounting form a coherent architecture. One public authorization contract needs a precise revision rule before implementation: the consent policy version must advance independently of the workspace authority fence.

Reviewed all ten frozen normative files. This verdict covers engineering architecture only. It neither accepts remote code nor opens R-EVAL, account/data/billing admission, interactive use, LIVE or deployment.

## Exact artifact and verification

- Repository: `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`; HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`; branch `planning/stage2-m365`.
- Package SHA256: `6cf125c2476191dd000ae9097a683296dd7fae50c6e538faeaa87113f04742f7`.
- Manifest SHA256: `ee17e5b84b56d8b7bace6c61f7466bb26ba97cd7379b6b87b73188465edceb0b`.
- Ten-entry ZIP SHA256: `148a3f17d52a2dc6371d45f0744ef463454f45fa3f827fbaac4ee576dab8948e`; every entry matches the normative bytes and size. Package digest independently recomputed as sorted `<sha256>  <path>\n`.
- Baseline: 1,175 files, of which 1,169 unchanged and six exactly declared administrative changes; all 224 built files unchanged. No unexpected baseline change or removal. Fourteen new files are exclusively ten norms, design status, baseline, delta list and manifest.
- Eight dependency seal/closure hashes match. Accepted ASK-B's 1,169-file inventory matches this baseline after its five sealed closure changes. Six parent Ask norms and eight console norms independently match their approved identities.
- Administrative inspection reconstructs five deltas exactly by removing appended routing or one inserted routing line. The sixth also changes its Current status heading; a narrow accepted-archive comparison shows status/acceptance/routing content. Its exact baseline/current hashes are independently bound. The preliminary append-only probe's limitation is preserved.

## R1 — Bind consent to a non-reusable policy revision

**Priority: P1.** Primary location: [04_AUTHORITY_AND_BILLING.md:17](/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1/docs/stage5/ask/remote/04_AUTHORITY_AND_BILLING.md:17), with policy identity at lines 10–15 and egress/final checks at lines 30–46. Public acknowledgement and refresh behavior: [02_CONTRACTS.md:29](/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1/docs/stage5/ask/remote/02_CONTRACTS.md:29), lines 29–32 and 64–69.

Policy changes, allowlist changes, pause and revoke must take the workspace fence and “increment its version.” In context this specifies the existing workspace fence. The separately introduced `policyVersion`, which is the only revision in the browser acknowledgement, has no explicit monotonicity, mutation or reuse rule. If that sentence intends the policy version instead, advancement of both distinct versions still needs to be explicit. The existing epoch check alone cannot invalidate consent captured before a later request starts.

Concrete permitted sequence under the incomplete rule: capability exposes `(admissionId=A, policyVersion=7)` while fence is 41; the operator checks consent for a draft. Trusted provisioning changes approved admission metadata/expiry or client admission, advancing fence to 42 while retaining `(A,7)`. A subsequent POST with the old acknowledgement starts phase1 at fence 42. Egress sees the current fence 42, active policy A/7 and exact matching acknowledgement, so all specified equalities pass. The question can be sent under changed policy without the intended `ASK_REMOTE_POLICY_CHANGED` refresh. This is an architecture counterexample, not an observed implementation failure.

**Necessary repair:** specify and enforce a non-reusable consent revision separately from the workspace fence. For example, make every material policy/client-admission change and reactivation monotonically advance `policyVersion` for the admission, with overflow/reuse rejected, while also advancing the authority fence. Alternatively use immutable admission revisions and a fresh, never-reused admission ID; define the exact tuple replacement rules. Cover provider/project/secret binding, retention/data/profile/price/cap/expiry/owner-approval changes and client allowlist changes. A revoke/reactivate or delete/recreate sequence must not restore an earlier acknowledgement tuple.

Add acceptance cases in `05_ACCEPTANCE.md`: capture consent, mutate policy before phase1, then submit the old tuple and require rejection before reservation or dispatch; repeat after revoke/reactivate and client-allowlist change; require explicit capability refresh and fresh checkbox acknowledgement. Verify exact bigint handling and version-overflow failure. The R-A brief must make the DB transition and trusted provisioning rules concrete. This finding changes an authorization/public-contract invariant, so the new frozen package needs fresh independent review at the mandated effort.

## Other assessed boundaries

Egress linearization is explicitly at confirmed admission commit, and a later revocation cannot retract an admitted dispatch. Unknown commit cannot dispatch. The capability is one-use and checked against local terminal/deadline state; locks do not cross HTTP. Final current authority and audit remain publication gates.

Month/day reservation and original-period settlement use a consistent order. Separate pause avoids a financial-lock-to-fence cycle. Unknown usage/delivery/crashes preserve reservation; duplicate settlement cannot refund twice. The architecture explicitly keeps the underlying owner through real cleanup and narrowly permits financial drain after public terminal. These are implementable requirements, still needing actual PostgreSQL and ignored-abort evidence at R-A/R-B.

The proposed full-window token bound is conservative: 289,172.4 microUSD, rounded up to 289,173, below the 300,000 reservation by 10,827. The example settlement is 358 microUSD. Independent static probes verified the closed five-intent schema and representative worst-encoding 2,000-codepoint payload sizes (maximum tested 10,040 bytes). These are arithmetic/schema/construction checks, not provider, implementation, concurrency or latency tests.

Official documentation supports the [model/context/effort](https://developers.openai.com/api/docs/models/gpt-6-luna), [rates](https://developers.openai.com/api/docs/pricing), [explicit cache mode](https://developers.openai.com/api/docs/guides/prompt-caching) and [wire options](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create). The [data-controls documentation](https://developers.openai.com/api/docs/guides/your-data) supports keeping EU/MAM/ZDR eligibility and retention verification behind a separate account admission. No inference call or account inspection was performed.

## Nonblocking implementation notes and residuals

- Preserve the distinction between content failure and validated cost-only settlement, including the specified timeout/unknown rules. Duplicate JSON keys require a parser that detects them; JSON.parse followed by schema validation alone cannot satisfy the acceptance matrix.
- Egress exclusion tests must distinguish source-derived names/IDs from the unchanged operator question, which may itself contain such text. The package already discloses that raw questions are not sanitized; synthetic test markers must exercise both sides of that boundary.
- R-EVAL quality, latency, actual model/tier/usage shape, regional account eligibility, disabled instrumentation and owner-approved paid scope remain unproved. Published model IDs do not prove immutable weights. Provider abort, in-process counters and application reservations do not guarantee no vendor processing, charge or invoice variance.

## Reviewer and evidence qualification

Assignment: fresh native Codex reviewer `/root/astra_s5askremote_design_rc1`, explicit `gpt-6-astra`, effort `xhigh`, initial brief with no other current reviewer's verdict. No subagent was spawned and no other reviewer's current verdict was read. Effective assignment is recorded as xhigh; provider response-model telemetry, attributable usage and subscription quota are not exposed to this reviewer. This is explicit native assignment evidence, not independent provider-routing attestation or model self-identification. The coordinator must retain the native launch receipt with the review.

Original checkout remained read-only. All written files are under `/tmp/atlas-stage5/askremote/astra-rc1/`. No code implementation, migration/DB setup, build, regression-suite run, provider inference, credential/account access, credits, commit or deployment occurred. `EVIDENCE.json` binds the proof inventory, including preliminary diagnostic failures and the abstract counterexample. Existing accepted test totals were inspected only as dependency metadata and are not claimed as rerun results.
