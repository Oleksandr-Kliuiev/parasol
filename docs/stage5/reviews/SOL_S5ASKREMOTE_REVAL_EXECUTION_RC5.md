# Independent Sol bounded re-review — execution RC5

Verdict: **APPROVE_LOCAL_EXECUTION_PREPARATION**. Required findings: **0**. My RC4 R1 is closed on the exact RC5 artifact below. This approval covers local engineering preparation only; it does not admit live execution, data, budget or human labels.

## Artifact identity

- Artifact: `S5ASKREMOTE-REVAL-EXECUTION-rc5`.
- Package hash: `5c6a7e521220b703ca78efd045376f7ac98e41c613e17e766b0eadc27b994d97`.
- Independently recomputed manifest package hash matches; all 120 listed files match the checkout.
- ZIP SHA-256: `ef70d7c06eceff971e91c5f79f8d1906a458032227c831eaf90ff3b5f9312fbe`; all 120 ZIP entries match current bytes.
- All 1,431 baseline files are unchanged. Product, accepted offline corpus/supervisor, schema, dependencies, prompt and build baseline remain unchanged.
- Artifact checker: no drift; 1,589 source/build/overlay checks. Execution tool SHA-256: `8a20b598679a7e50e4b7457b37750fedd8f2c597e441d0628cb1237d97bad776`.
- Accepted dependency identities remain offline package `d706a437b2e77ccb215080d4676d2ae70fee53376636d3d9040590d5d8f2dc3a` and R-C package `9ae0c2b813388af58ee7d12e4df7f59521ba8cff417a4124ea9ddb2bff1c7fe1`.
- Declared `RC5_ADMIN_DELTA.json` matches the historical status document's before/after hashes. Its delta retitles and qualifies historical RC3 acceptance without relabeling it as current acceptance; original historical facts remain preserved.

## RC4 finding closure and nearby changes

**R1 CLOSED — saved ledger validity and credit.** `scripts/ask-remote-eval-execution/replay.ts` now revalidates saved bound ledgers and pre-counters using the session ingestion rules (`ledgerValues`, `counterValues`), admitted caps and reply-class consistency (`ledgerMatchesReply`) before accepting replay. I independently repeated all three RC4 in-memory falsifications, retaining arithmetic-consistent post-counters and totals:

| Falsification | RC5 result |
|---|---|
| Answer with `CONFIRMED`, charged `0` | `MISMATCH`, `REPLY_LEDGER_CLASS` |
| Answer with `CONFIRMED`, charged `9435` | `MISMATCH`, `LEDGER_INVALID` |
| Answer with `RETAINED_KNOWN`, charged `1` | `MISMATCH`, `LEDGER_INVALID` |

The added regression suite also covers missing correlation, two attempts, DAY/MONTH order/cap violations, no-dispatch contradiction, a reserve short by one micro-USD, and the legitimate full `300000` retained reserve. Existing unknown-liability/no-credit receipts remain replayable. Replaying saved booleans still does not authenticate original answers; code and README state this explicitly.

The affected replay delta additionally derives case pass from semantic/truth/request/reconciliation fields, verifies group/refusal counts, safety and handoff counts, and rejects inconsistent complete-run threshold claims. Regression mutations exercise each category. These checks enforce internal consistency without claiming live predicate replay.

The small `session.ts` delta preserves a validated error envelope when the pasted request is unparseable: error code, correlation, safety tally and accounting remain available; request uncertainty is separately recorded as `REQUEST_UNVERIFIED`/`REQUEST_UNPARSED`. INVALID/model/usage and attested unavailable-config failures stay FAILED, while non-escalating errors with the unverified request stop INCOMPLETE. Answers without a parsed request remain unattributed handoff failures. The new scenarios cover these distinctions, and the prior unknown-liability safety-priority matrix remains passing.

No new required finding was identified in this bounded delta or affected regressions. My RC4 assessment of unchanged procedural/privacy boundaries remains applicable to this exact RC5 package.

## Reproduced verification

- Combined execution tests, accepted offline corpus/fixtures/supervisor/offline tests and context-budget test: **110 passed, 0 failed, 0 skipped** (including the real pseudo-terminal test).
- `npm run typecheck`: **exit 0**.
- Execution `artifact-check`: **exit 0**, no drift; live readiness `BLOCKED`, live acceptance eligibility `false`.
- Execution rehearsal without write flag: **56/56**, byte-identical to stored receipt; SHA-256 `1c41398327968e8a3cbe2040b932ae61af939057ebf085c64fbfd1620bfc2d73`.
- All three original RC4 adversarial replay probes now reject; only in-memory copies were mutated.
- Manifest/ZIP/baseline verification was independently performed; no reviewed source or evidence file was changed.

## Review identity and limits

This is the same independent native Codex reviewer session, bounded re-review at the same explicitly assigned `gpt-6.1-sol` / `xhigh`. No other current reviewer verdict was supplied or consulted, no reviewer was contacted, and no repairs were performed. Backend response-model/provider/billing telemetry remains unavailable to this reviewer; the explicit assignment is recorded but is not independently authenticated backend identity evidence. No model, billing, API-credit or fallback setting was changed; attributable subscription usage is unavailable.

No provider/product call, network dispatch, DB mutation, account/key/policy/budget activation, deployment or background schedule was performed. Paid product calls: **0**. Actual browser/DB/server observation was not established by these local tests.

Human labels remain DRAFT_MODEL_ASSISTED with attestation pending. Manual values, transient handoff, operator identity and local clock remain unverified/attested. Server-process identity, actual authority/publication, fixture provisioning, ledger/closure read contracts, platform egress/privacy evidence and owner data/budget admission remain explicit live blockers. `verifiedPass:false`, `liveAcceptanceEligible:false` and readiness `BLOCKED` remain enforced. Fake-V2 rehearsal does not measure model quality. Terminal-startup-before-raw echo, process/power-loss durability and other disclosed operational qualifications remain unchanged.
