# Independent RS-A verification addendum V1 review

**Verdict: APPROVE_VERIFICATION_ADDENDUM. Required findings: 0.**

This approves the verification procedure and its explicit qualification. It does not accept current implementation, establish a passing historical verification view, or admit execution RC5 against the RS-A image.

## Exact identity and independence

- Candidate: `/tmp/atlas-reval-rsa/VERIFICATION_ADDENDUM_V1.md`.
- Independently recomputed SHA-256: `9bbd6036a67e685a634da8403dc271f5ae6edbd109472816c478d718fcd56252`.
- Unchanged approved brief: `S5ASKREMOTE-REVAL-RSA-BRIEF-rc4`, package `e8f87336b1cf7e0ba7b18702378f3a6efb877b20e5d9aa4e9a96ee175bf85040`.
- Architecture parent remains server DESIGN RC4, `9fa16222d6c32c18d4d193b6666e078fd3624a4bdb2ccb8ab9fbd68113b08163`.
- Reviewer: same independent native Codex session, explicitly assigned `gpt-6.1-sol` / `xhigh`. The explicit native assignment is launcher evidence. Independent backend response-model/effective-effort telemetry, provider billing attribution, attributable token/elapsed usage and subscription quota telemetry are unavailable; none is invented.

I read the proposed addendum, the immutable artifact guard and corpus binding, a directly relevant frozen execution test entry, and the source/build/manifest anchors. I did not review changing RS-A implementation code, other reviewer reports, author history, private status contents, credentials or fixture contents. No tests, DB, provider or network actions were performed. Repository access was read-only; only this report was written.

## Verified anchors

The current brief and acceptance-check documents retain their approved SHA-256 values (`caa8a5b446d3efa21aa07ae6574647e6425cbc9fb05bda423fad364c4e902aaa` and `5b2b3062b9ee9fa0e5ce2c92d55f5a7416c14c91830465db61b9ed507955e410`). The sealed RC4 ZIP matches all 44 manifest entries and the manifest recomputes to the approved package hash. This is verification of the frozen brief, not an assertion that current implementation files still equal its pre-implementation inventory.

All 120 execution RC5 manifest files currently match their frozen bytes. The R-C and offline manifest files match the hashes pinned by `artifact.ts`:

- R-C manifest: `1b8128214440ba444b329fa496242aa8a9f074ac7fb106124ad6e7d6d0d94731`.
- Offline RC3 manifest: `3af49f790a2bff92a64b8ef83a9c7b8c1a174f758fb863de97e49086778ca58c`.

The R-C source ZIP at the manifest's absolute archive path has SHA-256 `4cace5d30cb88d2f288e03023fe6f3330e4dffcdcca8403f9fa9f4a97fe5d3c4`. All 1252 source entries match the R-C manifest, with no missing entries. `/tmp/atlas-reval-rsa/RC_RC1_VERIFIED_BUILD.zip` has SHA-256 `b2dc34c4b3a17aca90071d8ba847015e6d2bb647ab199cdceb241c7a55b8d001`; all 244 build entries match the accepted built inventory, with no missing entries. These byte comparisons establish preserved archive inputs. They do not establish the assembled historical view or any test result.

## Assessment

The stated conflict follows from the frozen code. `verifyArtifact()` hashes the pinned R-C source and build inventories; it tolerates only six administrative paths at exact pinned overlay hashes. `loadContext()` binds the corpus only when that snapshot is valid, and the inspected frozen execution test calls it at module initialization. Authorized changes to protected source/build bytes therefore prevent those historical-image tests from loading against the current image. This static finding does not independently certify the exact observed failure list; the required current unfiltered run must supply it.

The proposed qualification is sufficiently narrow:

1. The complete current unit/PGlite suite must run unfiltered, with its actual nonzero exit, counts and log hash preserved. Each qualified failure must be enumerated and causally attributed to the historical identity refusal. A test-name allowlist alone is insufficient; unrelated failures remain blockers.
2. Every frozen execution RC5 test must run unmodified in the independently verified exact historical view, with zero skips. Both pinned manifests, all historical source/build bytes, all 120 execution files, the six exact overlays and frozen dataset/fixture/order identities must verify. `verifyArtifact().ok` must be true before those tests run.
3. Missing historical inputs or an unverified/nonpassing historical view leave acceptance unsatisfied. The available source/build archives do not waive that requirement.
4. Current RS-A tests must prove the live tool refuses the enumerated controlled child deltas, that other protected historical files still match, and that unrelated tampering remains detectable. The guard and its source/hash/overlay policy stay unchanged.
5. Every current RS-A test and required schema/type/drift/PG17/native production-chain/browser/helper/repro/budget/grant/closure check remains mandatory. Historical execution results substitute only the specified identity-coupled historical tests, never current implementation evidence.

The reporting requirements prevent an unqualified green current-suite claim and retain execution compatibility as NOT_ADMITTED/PENDING a separately reviewed later revision. The addendum authorizes no production guard relaxation, changed historical hash, source overlay, provider use or execution admission.

## Gate classification and residuals

This is a verification-only correction within accepted architecture RC4 and the approved RS-A runtime scope. It changes how an intentionally identity-bound historical regression suite is evidenced after an authorized child image changes; it preserves the authority, isolation, financial, physical/peer, credential, protocol and closure invariants. No material architecture exception requiring fresh Astra/Fable approval was identified.

Final implementation acceptance still requires the exact historical view and zero-skip historical test evidence, the complete current failure qualification, and all current RS-A checks. No such runtime result is claimed here. `loadedBinding:UNVERIFIED`, `verifiedPass:false` and `liveAcceptanceEligible:false` remain required. RS-B/C/D, paid calls, activation, customer use and deployment remain outside this approval. Integration remains subject to the stated single-writer ownership and both independent approvals of this exact addendum SHA-256.
