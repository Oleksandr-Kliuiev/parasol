# Independent Ask Atlas RC3 architecture review

**Verdict: APPROVE.** No required findings for this six-file OFF/MOCK design. Approval covers the ASK-A design gate only, conditional on an independent Fable approval of this exact current artifact. It is not actual-code acceptance, permission to advance to ASK-B without ASK-A acceptance, or approval of external inference, LIVE, deployment or paid services.

Reviewer assignment: fresh native Codex subagent, explicitly assigned `gpt-6-astra` / `xhigh`; no delegated reviewers. This records the named assignment in the handoff. Native launch/model-routing evidence belongs to the orchestrator; no CLI/provider response-model telemetry or billing/quota data was available inside this review, and textual self-identification is not offered as separate provider evidence. I reviewed the current design independently without reading another Ask reviewer's verdict, historical Ask review conclusions, or the current other review.

## Exact artifact

| Identity | Value |
|---|---|
| Artifact | S5ASK-DESIGN-rc3 |
| Package SHA-256 | `a9e43a42655ddfea64577d9640fa5778bbf9acf2bd979abdb55e53459a4ab13a` |
| Manifest | `verification/stage5/S5ASK_DESIGN_RC3_MANIFEST.json` |
| Manifest SHA-256 | `a2fbc2836a59ec9769c6f7b73e4645e015782462654a7fe6ae4e961aeeaf584b` |
| Archive SHA-256 | `30020a9bfc3f3043e3477630506a6bf402d6ccf31eda92fb8b3ca24e6e5a191f` |
| HEAD | `916a4d69853ff6da636e8609a2e0bd33aa787f66` |
| Branch | `planning/stage2-m365` |
| Ask baseline SHA-256 | `fcf598c3f9b67e35a8c5d32fcd82f3723fd47f8831c756d597d2ba68e0eec22e` |
| Working inventory hash | `4b7b32b836729ba1d8c16bf2718b92c1bf736fea840457f81d9afe443470be24` |
| Accepted S5B package | `0346dc1293e06dfe04c58cda197eb276baedf0784df1aef08f6cd951692f0d6b` |
| S5B seal SHA-256 | `2e6b7b27bab868b997a8f93cc80e68d09549da6ee8529a7a2a2ca70016e637e4` |
| S5B closure SHA-256 | `4b52961d8ce4d2f3c8781a79003be2adb553bf757093c6f097aeca9eaacd5b2e` |

The manifest binds `docs/stage5/ask/{AGENTS,README,01_SPEC,02_CONTRACTS,03_SECURITY_AND_STATE,04_PLAN_AND_ACCEPTANCE}.md`. All six were read in full.

## Assessment

- **Ingress and bounded ownership:** `02_CONTRACTS.md:38` and `03_SECURITY_AND_STATE.md:8,20,94` specify the complete enabled-route boundary: one synchronous global reservation before raw/auth awaits for both GET and POST; private parsed-body storage; explicit exclusion from generic parsers; alias and HEAD/OPTIONS handling; bounded private digest authentication; atomic binding of the same owner to exact workspace/actor. The 10-question rolling counter is charged only after positive phase1 authority. Capability, invalid input and denials do not charge it. Owners remain occupied through ignored cancellation and actual DB/query cleanup, with exactly-once release. This closes the otherwise unbounded authentication/draining path without changing shared guards.
- **Current scope and publication:** `03_SECURITY_AND_STATE.md:29,42,50` correctly sets the token-derived workspace hint before the RLS-protected fence lock, declares the Ask-only `FOR SHARE` exception, and leaves frozen Stage3 `FOR UPDATE` admissions intact. Existing runtime grants and readiness checks support that read lock. Reauthentication preserves the private-authentication actor/workspace in both phases; final scope cannot follow a rebound token, and equal epoch integers from different workspaces cannot substitute for identity. No transaction survives the planner. Post-audit-insert expiry and original deadline checks, rollback, unknown-commit handling and no automatic retries form an explicit publication boundary.
- **Evidence and claims:** `02_CONTRACTS.md:61,80,97,113` requires validation of original selected source rows/items before mapper repair or bank reduction, explicit projections, scoped duplicate checks and honest bounded coverage. This is necessary because the accepted mapper substitutes unknown sources, truncates summaries and repairs malformed snapshots. `02_CONTRACTS.md:126,143,147` gives the deterministic planner enough server-derived eligibility information to choose the exact focus resource, while preserving identifier-free descriptors. SUMMARY selection is deterministic. ENTITY confirmation uses exact entity ID/kind plus a confirmed Atera/Huntress link, independently of the focus resource tuple. The claim matrix, unsupported/insufficient behavior, all-status evidence and mandatory urgency notices prevent an unrelated fact or planner omission from changing source urgency.
- **HTTP, privacy and audit:** `02_CONTRACTS.md:21,29,168` fixes error/answer shapes, status codes, caps, header correlation and no-echo rules. `03_SECURITY_AND_STATE.md:54,65,117` limits completion metadata to existing audit keys, excludes question/plan/answer/source text from persistence and diagnostics, distinguishes workspace denials from client completion, and states the limits of memory cleanup and delivery after commit. Existing audit helpers support the selected allowlist; no new ledger, permission or role is needed.
- **Browser and checkpoints:** `03_SECURITY_AND_STATE.md:128` fits the accepted closed credential holder, original browser deadline and epoch/generation model. It explicitly invalidates Ask for context, queue, selection and credential changes, including stale errors/finally and capability completion. `04_PLAN_AND_ACCEPTANCE.md:11,34,46` provides separate actual-code gates, real confined-PG barriers, parser preservation goldens, positive fixture/PG/browser journeys and restored-byte negative controls. The OFF/MOCK slice delivers real free input with a documented deterministic recognizer; remote readiness is correctly outside this approval.

Required findings: **none**. No required corrective closure remains in this independently assessed artifact; no previous review finding is claimed closed based on unseen history.

## Preservation and verification

Read-only hash/path/archive checks passed before and after the assessment. The supplied verification helper was inspected before running; supplemental independent Python checks verified the inventory digest, exact path sets, baseline deltas and dependency chain.

- All six normative files, all 1,055 working inventory entries and all 197 built entries match the manifest. The actual tracked/nonignored working path set is exactly those 1,055 entries plus this RC3 manifest/archive (1,057 total). The actual `dist` file path set is exactly the 197 built entries. Inventoried paths are not symlinks.
- The six-entry archive has exact membership and exact entry bytes; the package hash, manifest/archive hashes, HEAD and branch match the handoff both before and after review.
- Relative to the 1,032-entry Ask baseline, exactly the five declared administrative files changed: root `AGENTS.md`, context map, workflow, parent implementation status and parent review status. Both before/after hashes match their declaration. Added paths are Ask documentation/evidence only. Source, tests, accepted normative files, migrations and build outputs remain unchanged.
- The S5B manifest/archive/closure hashes and package identity match its seal. Its 971-entry source archive is exact; its 1,026-entry working inventory differs from the Ask baseline only by the four declared S5B closure administrative deltas. Its built inventory equals the Ask baseline and current RC3 inventory. The dependent console-design, S5A and S5B-brief seal hashes also match the S5B seal.

Source assessment was bounded to API bootstrap/guard/database/Host middleware; bearer/current-token and current-authority helpers; relevant auth RLS and authority-fence trigger sections; fence readiness/role grants and Stage3 admission; context query/mapper/observation order; audit projection/sanitizer; operator instructions, credential holder, transport, controller, entity and resource validation. No whole-HEAD diff, unrelated history, private configuration or credentials were inspected. Historical Ask report bytes were hashed as inventory members but their contents/verdicts were not read.

## Limits and implementation attention

This is architecture assessment against preserved accepted source, not implementation verification. No tests, builds, database operations, network/browser actions or runtime probes were run; none are needed to accept this design-only package. Only this scratch report was written. Actual cancellation/transaction cleanup, parser defaults and aliases, concurrent fence behavior, original-source rejection and browser generation isolation remain mandatory implementation evidence under the existing Q gates. This approval adds no scope or extra gate beyond the current contract.
