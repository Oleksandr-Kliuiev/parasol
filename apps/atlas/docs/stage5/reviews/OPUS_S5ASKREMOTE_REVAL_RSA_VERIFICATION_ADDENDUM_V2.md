# Review — RS-A verification addendum V2 (continuing my own independent Opus brief/verification review session)

**Verdict: APPROVE_VERIFICATION_ADDENDUM.** AV1-R1 and AV1-R2, and my V1 notes, are closed. No required findings
remain.

**Classification: within RC4, verification only. Not a material architecture change.** BRIEF rc4 runtime requirements,
RC5 code, tests, manifest, pins and guard are all unchanged. There is no admission or adoption, and the old tool stays
refused against the current image.

This approval accepts no RS-A code and no test result, and it waives no failure. A missing or unverifiable historical
view still means no qualification (V2 §2).

## 1. Exact identity (verified by me)

| Item | Result |
|---|---|
| Addendum V2 | `/tmp/atlas-reval-rsa/VERIFICATION_ADDENDUM_V2.md`, 38 lines, sha256 `59c2fd7f82020d62cbbdd070494b62fcb5cdae719e0568c98ab8d34492dc99dc`. **MATCH** |
| Approved brief (unchanged; not edited by V2) | `S5ASKREMOTE-REVAL-RSA-BRIEF-rc4`, `e8f87336b1cf7e0ba7b18702378f3a6efb877b20e5d9aa4e9a96ee175bf85040` |
| Durable overlay archive | `/Users/oleksandr/.codex/atlas-evidence/stage5/reval/rsa/verification-baseline-20261011/RC5_PINNED_ADMIN_OVERLAYS.zip`, sha256 `2fade6636c430fd1919e6113f249db4f2a2ba6a34affedcbae4d87b542bc7619` (**MATCH**). Exactly 6 entries, none extra or missing. Each is byte-equal to its `ADMIN_OVERLAYS` pin in the RC5 file `scripts/ask-remote-eval-execution/artifact.ts`, whose sha equals its RC5 manifest pin. That covers the three status docs that previously existed only in the working tree |
| Durable build archive | `…/RC_RC1_VERIFIED_BUILD.zip`, sha256 `b2dc34c4b3a17aca90071d8ba847015e6d2bb647ab199cdceb241c7a55b8d001` (**MATCH**, same as the `/tmp` copy). 244 of 244 entries are byte-equal to R-C `builtInventory` |
| Preservation receipt | `/tmp/atlas-reval-rsa/DURABLE_HISTORICAL_PRESERVATION.json`, sha256 `f26f473fc9d09fc94772286fd3fa38daed463608bf22e4df97211e96e905fcc2`, byte-identical to the durable `PRESERVATION_RECEIPT.json`. Its six overlay pins and archive hashes match what I computed |
| Source archive | Unchanged from my V1 review: R-C `sourceZip` sha `4cace5d3…c3c4`, 1252 of 1252 entries byte-equal. The four R-C aggregate hashes reproduce with `sha256␠␠path\n`, the algorithm V2 §2 now names |
| Historical view receipt | `/tmp/atlas-reval-rsa/HISTORICAL_RC5_VIEW_CHECKS.json`, sha256 `8a0f3ae7728387f9371b20cccc42084abbd25d698558efec8ec9ea8763adb712`. See §3 |

Conduct:
- Read-only. No checkout writes, test runs, DB connection, network or provider calls, or secrets.
- I read only the addendum, the immutable anchors and the receipts. I read no other reviewer's verdict, no author history and no status files.
- Requested: native `claude-opus-5-5` at `xhigh`. I make no self-identification claim; the root checks the model from assistant metadata. Effective effort, billing route, elapsed time and token use are **UNAVAILABLE** from inside the session.
- This report is my only write.

## 2. Closure of my V1 findings

**AV1-R1 — CLOSED** (V2 §1).
- All six exact overlay byte sets, and the 244-entry build, are now in a verified durable store outside `/tmp`.
- The source comes only from the pinned R-C `sourceZip`; `baseline.json` and the current tree are excluded as byte sources.
- The root defers edits to the six overlay paths until RS-A evidence is frozen.
- `ADMIN_OVERLAY_DRIFT` is never an expected RS-A refusal, even after freezing. Any later overlay edit is disclosed separately and forces renewed verification.

**AV1-R2 — CLOSED** (V2 §3).
- Every failed test is enumerated by file and name or TAP id. Its output must directly establish `CORPUS_IDENTITY_MISMATCH` or snapshot-not-ok, caused only by approved drift.
- Every other test, including registered tests in coupled files, must pass, and no unrelated cancelled or skipped test is qualified.
- `verifyArtifact().drift` must be ⊆ {`RC_SOURCE_DRIFT`, `RC_BUILD_DRIFT`}; every other code is a real failure.
- Every drifting source and build path is enumerated with old and new hashes, and must equal the final RS-A manifest's explicitly named §10 child deltas. Generic categories are resolved to exact paths; the two candidate test files are named and **not** accepted.

**Module-load reconciliation** (my V1 count cross-check, corrected honestly).
- V2 correctly notes that a module-load failure gives one failing file wrapper before any tests register, so raw runner counts cannot be equal.
- Instead it requires the wrapper's exact stack and cause, plus the RC5 file's current bytes matching both its accepted RC5 hash and the historical bytes.
- It also requires exact reconciliation of the blocked registrations against the historical per-file inventory, and separate counts: executed, failed-wrapper, blocked-unregistered, historical-passed.
- It never claims blocked tests ran. Any disappearing test, a different hash or an unexplained mismatch blocks acceptance.

**Coverage concern behind AV1-R2 — resolved.**
- Of the RC5 test files, 10 reach `packages/ask/source.ts` (via `tests/support/ask-source.ts`), and through it the RS-A-modified `packages/graph/runtime-role.ts`.
- Independently, **16 ordinary non-RC5 current test files** reach `packages/ask/source.ts`. Examples: `ask-service`, `ask-remote-flow`, `ask-settlement`, `operator-ask-remote-controller`.
- V2 §3/§5 requires every non-qualified current test to pass and retains full current Ask/source/runtime regression coverage. So RS-A behaviour on that path stays tested in the current image, and blocked RC5 files cannot hide a regression there.

**V1 notes — CLOSED.**
- View mechanics, V2 §2: a fresh copy outside the checkout; no checkout symlinks except a `node_modules` checked against its package-lock pin; Node version recorded; cwd = view; offline; identity checked before and after.
- Aggregate hashes, V2 §2.
- Durability, V2 §1.
- Three isolated tamper negatives, each with `ROOT` rooted in its own copy, V2 §4.
- Separate reporting, never an unqualified "green", with execution compatibility `NOT_ADMITTED`, V2 §5.

## 3. Historical preflight receipt — corroborated, not final

I independently recomputed every identity field in `HISTORICAL_RC5_VIEW_CHECKS.json` from the unchanged anchors, using
the formulas in `artifact.ts`. All ten match:
- `adminOverlaySha256`, `executionToolSha256`;
- `comparatorSha256`, `browserValidatorSha256`, `projectionSha256`;
- `offlinePackageHash`, `rcPackageHash`;
- `datasetCorpusSha256`, `orderSha256`, `fixtureSha256`.

The other figures also check out:
- `filesChecked` 1589 = 6 + offline entries + 1252 + 244.
- The six `adminDeltaPaths` are the expected overlays.
- The 110 passed with 0 skipped equals RC5's accepted `tests.pass = 110`, `skipped = 0` (`S5ASKREMOTE_REVAL_EXECUTION_RC5_CHECKS.json`).

As recorded, the receipt is preflight evidence. It does not yet meet all of V2 §2/§3:
- It has only `snapshotAfterTests`, with no before-test snapshot.
- It has totals only, with no per-file test names and counts. RC5's own CHECKS have no per-file inventory either, so this run is the inventory source.
- It has no Node version, view path, `package-lock`/`node_modules` verification, or cancelled/todo counts.

The final checkpoint evidence must supply these, by re-running or augmenting under V2; this receipt alone must not be
presented as the complete historical proof.

## 4. Nonblocking notes

- **NB-1 — Exact count.** Make "110/110 (or actual identical accepted inventory)" concrete in evidence: exactly the 110 accepted tests, with 0 skip, 0 todo and 0 cancelled, and per-file names taken from the historical run.
- **NB-2 — Durable citations.** When integrating, cite the durable `PRESERVATION_RECEIPT.json` (byte-identical, `f26f473f…`) rather than the `/tmp` copy. Durably preserve the historical view receipt and log together with the final evidence.
- **NB-3 — Separate signatures.** Keep both review gates distinct. This addendum approval, and later code acceptance (where fresh code reviewers receive V2), are separate. RS-B/C/D and all data, budget, customer and deploy admissions stay separate.

## 5. Scope statement

This approves only the exact V2 text above, as a verification-only qualification of BRIEF rc4's required-suite
evidence. It authorizes no RC5 edit, no adoption of hashes, no admission and no claim of current RC5 functional
compatibility. Paid product calls: 0. Activation: none.
