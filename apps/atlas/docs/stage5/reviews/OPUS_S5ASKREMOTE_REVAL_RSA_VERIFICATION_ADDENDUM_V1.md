# Review — RS-A verification addendum candidate V1 (continuing my own independent Opus brief review session)

**Verdict: CHANGES_REQUIRED.** Two required findings (AV1-R1, AV1-R2). Both are bounded wording and preservation
repairs.

**Classification: within RC4, verification only. Not a material architecture change.** The addendum changes only how
the approved BRIEF rc4's required suite is evidenced. Runtime authority, isolation, data boundaries, durability, public
contracts and RC5 code, hashes and guards are all untouched. The current execution tool stays refused against the
current image. The contradiction it addresses is real: I verified it in the code, and the RS-A briefs (including my own
RC1 feasibility check) missed it. Nothing in this review waives any other failure, or claims historical coverage that
has not been produced.

## 1. Exact identity (verified by me)

| Item | Result |
|---|---|
| Addendum | `/tmp/atlas-reval-rsa/VERIFICATION_ADDENDUM_V1.md`, 24 lines, sha256 `9bbd6036a67e685a634da8403dc271f5ae6edbd109472816c478d718fcd56252`. **MATCH** |
| Approved brief (unchanged) | `S5ASKREMOTE-REVAL-RSA-BRIEF-rc4`, `e8f87336b1cf7e0ba7b18702378f3a6efb877b20e5d9aa4e9a96ee175bf85040` (verified in my rc4 review; the addendum does not edit it) |
| Guard | `scripts/ask-remote-eval-execution/artifact.ts`, an RC5 file. All 120 RC5 files are byte-identical on disk now. It pins `RC_MANIFEST` `1b8128214440ba444b329fa496242aa8a9f074ac7fb106124ad6e7d6d0d94731`, which equals the on-disk sha of `verification/stage5/S5ASKREMOTE_RC_RC1_MANIFEST.json` |
| R-C source archive | The manifest's `sourceZip` (under `~/.codex/atlas-evidence/…/S5ASKREMOTE_RC_RC1_SOURCE.zip`) exists. Its sha equals the manifest's `sourceZipSha256` (`4cace5d30cb88d2f288e03023fe6f3330e4dffcdcca8403f9fa9f4a97fe5d3c4`). 1252 of 1252 entries are byte-equal to manifest `files`, with no extra entries and no build paths. The manifest's `packageHash`, `builtInventoryHash` and `workingInventoryHash` all reproduce, in `sha256␠␠path\n` line format |
| Preserved build archive | `/tmp/atlas-reval-rsa/RC_RC1_VERIFIED_BUILD.zip`, sha256 `b2dc34c4b3a17aca90071d8ba847015e6d2bb647ab199cdceb241c7a55b8d001` (**MATCH**, equals its receipt). 244 of 244 entries are byte-equal to manifest `builtInventory`, with none extra or missing |
| Current state, for context only (not code acceptance) | R-C source drift on disk = the six admin-overlay paths (all at their pinned overlay hashes) plus `packages/graph/runtime-role.ts`, `prisma/askremote.prisma`, `prisma/roles.sql`, `prisma/schema.prisma`, `tests/context-mapper.test.ts`, `tests/m365-database.test.ts`, `tests/support/pg-harness.ts`, `tests/support/roles-sql.ts`. R-C build drift is currently 0 |

Conduct:
- Read-only. I made no repository or code writes, ran no tests, opened no DB connection, made no network or provider calls, and read no secrets or status files.
- I hashed only the anchors and the files the guard covers.
- I read no other reviewer's verdict and no author history. The prompt, repair and implementation files in `/tmp/atlas-reval-rsa/` were not opened.
- Requested: native `claude-opus-5-5` at `xhigh`. I make no self-identification claim; the root checks the actual model from metadata. Effective effort, billing route, elapsed time and token use are **UNAVAILABLE** from inside the session.
- This report is my only write.

## 2. The contradiction is genuine

- `verifyArtifact()` rehashes every R-C `files` entry (1252) and every `builtInventory` entry (244), relative to `ROOT = new URL('../../', import.meta.url)` (artifact.ts L13, L89). The only tolerance is the six pinned `ADMIN_OVERLAYS` (L23–30, L77).
- `loadContext()` → `bindCorpus(verifyArtifact())` rejects with `CORPUS_IDENTITY_MISMATCH` whenever `!snapshot.ok` (corpus.ts L26–33).
- The RS-A edits that the approved brief allows touch R-C-listed files, so `RC_SOURCE_DRIFT` is unavoidable, and `RC_BUILD_DRIFT` follows after rebuild.
- Meanwhile BRIEF rc4's required suite expects `node --test tests/*.test.ts` to pass.
- Both cannot hold without changing RC5, which is forbidden. RC5 is behaving as designed by refusing an unaccepted image.
- Only `artifact.ts` consumes the R-C manifest. The browser suite is not coupled: `apps/operator/src/controller.ts` has an unrelated local `loadContext`, and `tests/ui/artifact.spec.ts` checks the operator assets' own per-build manifest.
- My RC1 "RC5 delta 0 feasible" scan looked for import references and missed this manifest-level binding. I note that candidly here.

## 3. Required findings

**AV1-R1 — Three of the six pinned overlay byte sets exist only in the mutable working tree (addendum item 2; artifact.ts L23–30).**

The historical view needs "the exact six accepted ADMIN_OVERLAYS at pinned hashes". I searched every sealed ZIP in
`verification/stage5/`, plus the preserved build ZIP, for each pinned overlay hash:

- `AGENTS.md`, `docs/AI_CONTEXT_MAP.md` and `docs/DEVELOPMENT_WORKFLOW.md` exist at their pinned hashes in the sealed RC5 package ZIP (and in others).
- `docs/stage5/IMPLEMENTATION_STATUS.md`, `docs/stage5/REVIEW_STATUS.md` and `docs/stage5/ask/remote/DESIGN_STATUS.md` exist at their pinned hashes **in no sealed archive**. The only copies are the current working-tree files.

These are root-maintained status documents, and updating them is part of the orchestrator's normal work. One status
edit would therefore:
- (a) destroy the only bytes the view needs, which triggers item 3 and loses historical coverage; and
- (b) add `ADMIN_OVERLAY_DRIFT` to the current image, a refusal cause unrelated to RS-A, which item 1 would then either misattribute or have to waive.

Required:
- Before any further edit to the six overlay paths, the root preserves all six exact byte sets in a hash-verified archive with a receipt, matching the pattern of `RC_RC1_VERIFIED_BUILD.zip`.
- The view takes overlays only from that archive, or from the sealed RC5 ZIP for the three it contains, always checked against the pinned hashes.
- The addendum states that `ADMIN_OVERLAY_DRIFT` is never part of the "expected historical identity refusal". If the root edits an overlay path before RS-A evidence is frozen, that is reported as a separate, enumerated cause, or the root defers such edits until the evidence is frozen.

**AV1-R2 — The qualification is at suite level; it must be test-level, cause-exact and path-exact (addendum items 1, 4, 6).**

Concrete risk:
- RC5 suites execute RS-A-modified code in the current image, through `tests/support/ask-source.ts` (an RC5 file) → `packages/ask/source.ts` → `packages/graph/scope-context.ts` → `packages/graph/runtime-role.ts` (an RS-A bounded modification).
- A suite-level "identity-coupled" exclusion could therefore hide an RS-A-caused functional failure inside the same files.
- Coupling can also be transitive or happen through a child process, e.g. the PTY and CLI suites spawning the tool. So the coupled set cannot be fixed by file name.

Required, for the current unfiltered run:
- **(a) Test-level listing.** Enumerate every failing test (file plus test name or TAP id). Each must fail with the identity refusal (`CORPUS_IDENTITY_MISMATCH` / snapshot not ok), shown in its failure output. A file that fails at module load counts all its tests as failed with that cause, and this is shown.
  - Every other test, including tests inside the coupled files, must pass.
  - No cancelled or skipped tests outside this enumeration.
- **(b) Drift codes.** In the current image, `verifyArtifact().drift` must be ⊆ {`RC_SOURCE_DRIFT`, `RC_BUILD_DRIFT`}. Any `ADMIN_OVERLAY_DRIFT`, `RC_MANIFEST_DRIFT`, `OFFLINE_*`, `DATASET_*` or `*_EMPTY` code is a real failure.
- **(c) Drift paths.** The drifting paths, computed by the item-4 test, must equal an explicit enumerated list.
  - The list is bound to the approved BRIEF rc4 §10 (named new paths and bounded modifications) and to the final RS-A manifest.
  - Generic §10 categories such as "existing parity/invariant tests only where needed" must be resolved into named paths. Today's tree already contains two such paths, `tests/context-mapper.test.ts` and `tests/m365-database.test.ts`. I neither accept nor reject those code changes here.
  - Rebuilt `dist` deltas must be enumerated the same way; any other drifting R-C source or build path fails.
- **(d) Count cross-check.** For each RC5 test file, record per-file test counts in the current run and in the historical view. They must be identical, so no test can vanish between the two runs.

## 4. Nonblocking notes

- **NB-1 — View mechanics.** Because `ROOT` derives from the guard module's real path:
  - build the view as a fresh directory outside the checkout, from copied bytes;
  - use no symlinks into the checkout except a read-only `node_modules`, and only after `package-lock.json` in the view matches its pinned hash;
  - run with cwd = view root, with no network (the offline guards apply);
  - record the Node version, and the `verifyArtifact()` identity, which necessarily equals the accepted identity when `ok`, because the manifests are pinned in RC5 code;
  - never use `baseline.json` or the current tree as a byte source for historical files.
- **NB-2 — Aggregate hashes.** Have the view builder also verify the manifest's `sourceZipSha256`, `packageHash`, `builtInventoryHash` and `workingInventoryHash` (`sha256␠␠path\n` lines). I reproduced all four.
- **NB-3 — Archive durability.** Move or copy `RC_RC1_VERIFIED_BUILD.zip` (and the new overlay archive) out of `/tmp`, into the same durable evidence store as the source ZIP, keeping the receipts. macOS periodically cleans `/private/tmp`, and once `dist` is rebuilt this archive is the only copy of the accepted build bytes.
- **NB-4 — Item-4 tamper test.** It should copy the unmodified RC5 tool into a temporary view, so that `ROOT` resolves there. That means no RC5 edits and no production guard change. Cover three cases: one unrelated protected source file tampered, one build file tampered, and one overlay at the wrong hash. Each must be refused with its specific code.
- **NB-5 — Reporting.** Item 6's separate reporting, together with item 7, is correct. In particular, the old tool's compatibility with the current image stays `NOT_ADMITTED`/pending a later reviewed execution revision; there is no automatic adoption; `loadedBinding` stays UNVERIFIED; and `verifiedPass`/`liveAcceptanceEligible` stay false.

## 5. What I did not do

I did not approve or accept any RS-A code, any test result, or the two non-explicit test-file edits above. I did not
change or relax any RC5 file, hash or guard. I did not waive the rule that a missing historical artifact (item 3) means
no historical coverage claim. Once AV1-R1 and AV1-R2 are repaired under a new exact addendum hash, this session can
re-review it.
