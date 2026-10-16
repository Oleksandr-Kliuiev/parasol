# RS-A verification addendum V2 — candidate

Verification only. Runtime architecture RC4 and approved BRIEF rc4 requirements remain unchanged. No RC5 source, test, manifest, pin or guard change is authorized. No execution admission, activation or paid calls.

The unchanged RC5 guard deliberately binds all1252 historical R-C source entries and244 build entries. Authorized RS-A source/build changes necessarily make current verifyArtifact() refuse. Unqualified green current-unit evidence and that unchanged historical guard cannot both hold. This addendum makes that qualification explicit without hiding other failures.

## 1. Preserve exact historical bytes

Before any further administrative overlay edit, preserve ALL six ADMIN_OVERLAYS at their exact RC5-pinned hashes in a verified durable archive. Preservation is complete: receipt /tmp/atlas-reval-rsa/DURABLE_HISTORICAL_PRESERVATION.json; durable store /Users/oleksandr/.codex/atlas-evidence/stage5/reval/rsa/verification-baseline-20261011/.
- RC5_PINNED_ADMIN_OVERLAYS.zip SHA256 2fade6636c430fd1919e6113f249db4f2a2ba6a34affedcbae4d87b542bc7619, exactly6entries all individually pinned.
- RC_RC1_VERIFIED_BUILD.zip SHA256 b2dc34c4b3a17aca90071d8ba847015e6d2bb647ab199cdceb241c7a55b8d001, exactly244entries all match frozen R-C builtInventory. Captured before RS-A rebuild.
- Source archive is ONLY the exact sourceZip named and sha256-pinned by S5ASKREMOTE_RC_RC1_MANIFEST.json. No baseline.json/current-tree bytes substitute historical files.
- Root defers edits to the six overlay paths until RS-A evidence is frozen. ADMIN_OVERLAY_DRIFT is NEVER an expected RS-A refusal, even after freezing; any later overlay edit is separately disclosed and requires affected verification renewal.

## 2. Historical execution verification view

Create a fresh directory outside checkout, using only copied exact source/build/RC5/offline bytes and the preserved overlay archive. Verify R-C sourceZipSha256, packageHash, builtInventoryHash, workingInventoryHash (manifest algorithm sha256-twoSpaces-path-newline), each1252source/244build entry, all120RC5files and frozen dataset/fixture/order. Preserve exact6overlays from the archive. No checkout symlinks except dependencies-only node_modules after package-lock pinned-hash verification; record Node version. Cwd=view, offline/no DB/provider. Require unchanged verifyArtifact().ok true and exact identity BEFORE and AFTER tests. Run ALL13 testfiles in RC5manifest UNMODIFIED, require110/110 (or actual identical accepted inventory) pass, zero skips/cancellations/failures. Missing/unverifiable archive/view means no acceptance qualification. View never substitutes current RS-A tests or production-copy rebuild.

## 3. Current unfiltered command — test-level exact qualification

Run COMPLETE current unit/PGlite command unfiltered, preserve nonzero exit code, TAP/test diagnostics, counts and log hash. Enumerate EVERY failed test by file and name/TAP id; its output must directly establish CORPUS_IDENTITY_MISMATCH or snapshot-not-ok caused only by approved historical source/build drift. Every other test, including registered tests in a coupled file, must pass; no unrelated cancelled/skipped tests are qualified.

For module-load failures, current Node emits one failing file wrapper BEFORE its tests register. Report that wrapper and exact stack/cause, plus the historical per-file test-name/count inventory blocked from registration. Do not pretend those tests ran/currently passed, and do not demand impossible equality of raw runner counts. Cross-check each RC5 testfile current bytes against the accepted RC5 hash and identical historical bytes; enumerate per-file logical test inventory from the historical run. For registered current tests require matching names/counts; for a module-load-blocked file reconcile the missing registrations exactly to that unchanged historical inventory. Any disappearing test/file, different source hash, unrelated failure or unexplained count mismatch blocks acceptance. Report current executed, failed-wrapper, blocked-unregistered and historical passed counts separately.

Current verifyArtifact().drift must be a subset of RC_SOURCE_DRIFT and RC_BUILD_DRIFT only. ADMIN_OVERLAY_DRIFT, RC_MANIFEST_DRIFT, OFFLINE_*, DATASET_*, *_EMPTY and every other code are real failures. Enumerate every drifting historical source and built path with old/new SHA; the set must equal the final RS-A manifest's explicitly named allowed child deltas under BRIEF §10. Resolve generic parity/invariant categories to exact paths (currently tests/context-mapper.test.ts and tests/m365-database.test.ts are candidates, NOT accepted here). All other historical paths match their pins, except already accepted exact6overlay bytes.

## 4. Current refusal and tamper checks

Add focused tests/reval-*.test.ts checks against CURRENT source/build proving unchanged RC5 refuses only the explicitly enumerated authorized child deltas. No production guard bypass/adoption, no RC5 edits. In separate copied immutable views run unmodified guard with three isolated tamper negatives: unrelated protected source byte -> RC_SOURCE_DRIFT; historical build byte -> RC_BUILD_DRIFT; overlay wrong hash -> ADMIN_OVERLAY_DRIFT. Use module paths rooted in each copy so ROOT actually resolves there. Do not mutate checkout/frozen archive. These tests are new RS-A tests in the same Opus implementation session; code acceptance still pending.

## 5. Unchanged current acceptance and reporting

ALL current new RS-A unit/PG17/guard/grants/closure/deadline/native-production-PTY checks, Prisma/schema/typechecks/drift/browser/helper/repro/clean-current-production-copy checks remain mandatory. Historical-view coverage never claims current RC5 functional compatibility. Retain full current Ask/source/runtime regression coverage in current ordinary tests. Separate results explicitly: current unfiltered command qualified nonzero with exact identity-only failures; all other current tests pass; historical110pass with exact identity; current refusal/tamper checks pass. Never call npm test unqualified green.

Historical execution RC5 acceptance remains preserved; compatibility with RS-A image is NOT_ADMITTED/PENDING a later separately reviewed execution revision. No automatic source/build hash adoption. loadedBinding UNVERIFIED, verifiedPass/liveAcceptanceEligible false; RS-B/C/D and all data/budget/customer/deploy admissions remain separate. Paid product calls0; activationnone.

Candidate only: effective after independent same-own-session Sol6.1/xhigh and native Opus5.5/xhigh approve this SAME exact addendum SHA. Root integrates only after sole checkout writer stops, original BRIEFrc4 stays unchanged, and both later fresh code reviewers receive this explicit verification addendum. Current author continues only already approved runtime work; affected final evidence/new refusal test uses this addendum only after approval.

