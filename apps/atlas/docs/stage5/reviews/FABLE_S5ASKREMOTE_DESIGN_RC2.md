# APPROVE — ASK-REMOTE architecture S5ASKREMOTE-DESIGN-rc2 (independent Fable 5.1 review)

Verdict: **APPROVE** for engineering architecture only (R-A/R-B/R-C offline implementation and synthetic verification). This does not admit paid inference, data egress, account or key provisioning, R-EVAL, LIVE, real customer use or deployment. No required findings. Eight nonblocking notes and the design's own residuals follow.

## 1. Reviewed artifact identity (recomputed, read-only)

| Item | Expected | Recomputed | Match |
|---|---|---|---|
| Manifest `verification/stage5/S5ASKREMOTE_DESIGN_RC2_MANIFEST.json` | 88a8b86695d8b3d6504d8ec88118394e276d0e09d163dbd39be09a6d81e14979 | same, 4317 bytes | yes |
| Ten-file package hash | 9c92327f6a3d693031c30cc907091f6dd61f4e0747491e10f00a784f877719d3 | same | yes |
| Source ZIP `~/.codex/atlas-evidence/stage5/ask/remote/design-rc2/S5ASKREMOTE_DESIGN_RC2_PACKAGE.zip` | f68e789ec039af13168ce798ec68d7a58722c8f917eb2cbec5143d2850eeba8c | same | yes |

- Package hash reproduces as SHA256 over the path-sorted lines `"<sha256>  <path>\n"` of the ten manifest entries.
- All ten per-file hashes match in the manifest, the working checkout and the ZIP entries (streamed, nothing extracted). Sizes match, 55,299 bytes total.
- Manifest head 916a4d69853ff6da636e8609a2e0bd33aa787f66 equals current HEAD. Package files are untracked and bound by hash.
- Baseline and administrative-deltas files match the manifest. Of 1175 baseline files, 1169 match and the 6 differing files are exactly the declared deltas, each matching its declared after-hash. All 224 built files match.
- All eight dependency seals and closure receipts in the manifest match their recorded hashes.

Files assessed as one artifact: 01_SCOPE.md, 02_CONTRACTS.md, 03_DATA_AND_PROVIDER.md, 04_AUTHORITY_AND_BILLING.md, 05_ACCEPTANCE.md, 06_PROVIDER_DECISION.md, AGENTS.md, README.md, intent-prompt.json, intent-schema.json. DESIGN_STATUS.md was read as administrative only.

## 2. Reviewer, method, limitations

- Model claude-fable-5-1, fresh context, no other reviewer's report or verdict read. Assigned effort high. Effective runtime effort and the native-subscription route are not observable from inside the model; the orchestrator's execution record is the evidence of record.
- Read-only work: hashing, the package, narrow reads of the accepted Ask source, fence readiness and roles.sql, the Stage 3 fence migration, main.ts and ask-state.ts, plus five official OpenAI documentation pages. No subagents, no scratch writes, no repository writes, no provider or model HTTP, no accounts, keys or DB.
- No implementation exists, so nothing here claims code, live or account proof. Provider telemetry was not available and is not inferred.
- The API reference URL cited in 06 line 30 returned 404; the parent reference page documents the same method and was used instead.

## 3. Probed and found sound

**Egress linearization and revocation.** The egress transaction takes the fence `FOR SHARE` first, then rechecks bearer, actor, all-of permissions, the policy and acknowledgement tuple, locks MONTH then DAY counters, inserts the attempt, and rechecks expiry and deadline after INSERT. Every material policy, allowlist or pause mutation takes the fence `FOR UPDATE` first. A mutation committed before the egress lock is visible; one blocked behind it commits after egress and is caught by phase2. The design states honestly that a later revocation cannot retract an admitted dispatch.

**Fence mechanism implementability.** Verified against the Stage 3 migration and fence-role.ts. The fence guard trigger is SECURITY INVOKER and accepts any role's exactly-plus-one version update. The scope policy applies to PUBLIC, so the new remote definer with SELECT(workspaceId, version) and UPDATE(version) can lock and bump the fence under the captured workspace setting with no new fence policy. The accepted readiness query asserts exactly two fence policies and confines only the fence owner, both preserved. The accepted routine check would fail on any new PUBLIC-executable routine, and the design's blanket PUBLIC EXECUTE revocation is exactly the countermeasure. Runtime readiness restricts routine EXECUTE only for the cleanup routine, so granting reserve, settle and pause to runtime breaks nothing. roles.sql currently requires seven distinct roles, so "eighth role" is consistent.

**Lock order.** Reserve: fence shared, MONTH, DAY, attempt INSERT. Settle: MONTH, DAY, attempt, never the fence. Pause and revision: fence exclusive, then policy rows, never counters. Missing counters are inserted in the same order before locking. No cycle exists.

**Time floor.** Accepted code fixes each phase at min(2 s, remaining) with per-statement timeouts. The 4500 ms floor checked before INSERT, before return and before dispatch fits that model, and the 500 ms publication floor is honestly called an opportunity. Settlement's independent clock is implementable because the phase helper accepts any object with a check method, so accepted modules need no change.

**Money model.** The 300000 µUSD reserve recomputes as 1,050,000 × 0.275 + 512 × 0.825 = 289,172.4, rounded up. Rates 275 and 825 equal the worst Standard long-context cache-write and output rates with the 10% regional uplift, matching the official pricing page. Maximum settled cost under the usage gates is 9,434 µUSD, always below the reserve. UTC period keys are session-timezone independent. Project identity partitions counters, so revisions cannot reset spend. Unknowns retain the full reserve, and duplicate settlement is blocked by the attempt-state check under row lock.

**Provider facts.** Official pages confirm the model ID has no dated snapshot or alias, supports effort none, Chat Completions and structured outputs, with a 1,050,000 context and 922,000 max input. The Chat Completions reference documents `prompt_cache_options` with implicit or explicit mode for gpt-5.6 and later, the service tier values, and exactly the usage detail keys the design enumerates. The caching guide confirms explicit mode without breakpoints writes nothing. The data page confirms the EU hostname, per-project residency, GPT-6 Luna Standard support on chat completions, that store true is not allowed in non-US regions, and that ZDR needs approval. The design's qualifications match.

**Local facts stay authoritative.** The schema is strict-compatible. The selector mirrors the accepted MOCK plan function exactly, and a focus intent without focus yields INSUFFICIENT through the unchanged compiler. The V1 answer has exactly 15 keys, so "15 plus provenance" is accurate. Permissions are plain strings and an all-of helper already exists. New tables carry scoped composite FKs, and Workspace delete is already refused by the Stage 3 guard. Default-privilege leakage is handled by post-grant REVOKE and a readiness query.

**Consent and UI.** Per-question unchecked consent, reset on every listed boundary, tuple captured before clearing, no durable storage, question sent unchanged and never called sanitized, acknowledgement compared before reservation. Stale responses are confined to their generation. Audit keys exist in the allowlist.

## 4. Required findings

None.

## 5. Nonblocking notes

1. **Dead citation.** 06_PROVIDER_DECISION.md line 30 points to a 404 path. Fix: cite `https://developers.openai.com/api/reference/resources/chat` at the next package revision.
2. **Pause on benign usage counters.** 03_DATA_AND_PROVIDER.md lines 67–72 pause the workspace and retain the full reserve when cached, cache-write or reasoning token counters are positive. Those are subsets of prompt or completion tokens already billed at or above worst rate by the 275/825 formula. Fix: keep pause for model, tier, 401/403, image, audio and unknown keys; settle known cost for the three benign counters instead of pausing.
3. **Settlement ordering steals publication time.** 04 lines 70 and 136–139 run up to 2 s of settlement before phase2 while reserving only 500 ms for publication, although settlement failure never affects the answer. Fix: publish first and settle in drain, or lower the pre-publication settlement bound.
4. **Settle-0 is runtime-asserted.** 04 lines 73 and 133: the DB cannot verify no dispatch occurred. Fix: store a per-process dispatch nonce in the attempt at INSERT and require it for settle-0, so a restarted process can never settle 0.
5. **Admission predicates inside the reserve routine.** 04 lines 63–67 and 118: re-evaluate policy active, unexpired, version equality, client admission and caps inside the SECURITY DEFINER routine so they are DB-enforced regardless of runtime code.
6. **Numeric usage is a coarse length proxy.** 02 line 32 says no question length in any record, while 04 lines 113–114 store token counts and cost. Fix: state the proxy explicitly in 04 and the runbook.
7. **Refund wording.** 04 lines 120–121 "no refund on timeout/disconnect" versus settle-0 after a proven pre-dispatch floor failure at lines 73 and 133. Fix: add "except the proven in-process no-dispatch case".
8. **Shared fence lock across counter waits.** Egress holds the shared fence while waiting on counter locks, bounded by the 2 s phase, which can delay Stage 3 exclusive admissions in that workspace. Acceptable. Record it in the R-A brief.

## 6. Residuals already acknowledged by the design

- Published model ID is not immutable weights. A dated response ID pauses rather than passes.
- A schema-valid intent can be semantically wrong. R-EVAL is the release gate.
- The raw question is not sanitized. Synthetic-only admission is a declaration, not detection.
- Revocation after egress commit cannot undo the question or cost. Abort proves no refund.
- Upstream 429/5xx and unknown outcomes retain the full reserve. Six unknowns exhaust the day cap, so the 200-case eval may span several UTC days.
- The ledger bounds admitted token charges only, not taxes, other project usage, a compromised key or vendor price changes.
- EU residency, ZDR/MAM and exact response shape remain unverified until the separately admitted R-EVAL.

## 7. Scope statement

This acceptance covers engineering architecture of the ten-file RC2 package only. Implementation may begin only after the second required independent approval by fresh gpt-6-astra/xhigh of the same package identity 9c92327f6a3d693031c30cc907091f6dd61f4e0747491e10f00a784f877719d3, per the roles and gates section of docs/DEVELOPMENT_WORKFLOW.md.

The same report is saved at `/Users/oleksandr/.claude/plans/independently-review-ask-remote-architec-humming-turtle.md`, outside the repository. Nothing in the original checkout was modified, and no implementation step follows from this review.