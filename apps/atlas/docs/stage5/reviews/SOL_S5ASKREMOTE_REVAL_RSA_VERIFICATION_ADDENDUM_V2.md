# Independent RS-A verification addendum V2 review

**Verdict: APPROVE_VERIFICATION_ADDENDUM. Required findings: 0.**

This approves the verification-only procedure. It does not accept current RS-A implementation or admit historical execution RC5 against the RS-A image.

## Exact identity and assignment

- Addendum: `/tmp/atlas-reval-rsa/VERIFICATION_ADDENDUM_V2.md`.
- Recomputed SHA-256: `59c2fd7f82020d62cbbdd070494b62fcb5cdae719e0568c98ab8d34492dc99dc`.
- Original approved brief remains `S5ASKREMOTE-REVAL-RSA-BRIEF-rc4`, package `e8f87336b1cf7e0ba7b18702378f3a6efb877b20e5d9aa4e9a96ee175bf85040`.
- Architecture parent remains server DESIGN RC4, `9fa16222d6c32c18d4d193b6666e078fd3624a4bdb2ccb8ab9fbd68113b08163`.
- Same independent native Codex reviewer session, explicitly assigned `gpt-6.1-sol` / `xhigh`; bounded re-review of my approved V1 procedure. Native launcher assignment is the available identity evidence. Independent backend response-model/effective-effort, provider billing, attributable usage/elapsed time and subscription quota telemetry are unavailable and are not invented.

I inspected the exact V2, the named preservation/test receipts, frozen guard/manifest anchors and the isolated view's protected bytes. I did not inspect changing RS-A implementation, other reviewer verdicts, author history, private status contents or secrets. No tests, database, provider, network or checkout writes were performed. Only this report was written.

## Bounded delta assessment

V2 strengthens the V1 qualification without relaxing the frozen guard:

- All six exact administrative overlays and the 244 accepted build outputs are durably archived. Overlay edits are deferred; `ADMIN_OVERLAY_DRIFT` is never an expected RS-A refusal.
- Historical construction requires the pinned source ZIP, aggregate inventory hashes, individual protected bytes, exact RC5/offline inputs, a genuinely separate root, dependency-only symlinking under the lock pin, recorded Node version and unchanged guard identity before and after all manifest-listed tests.
- Current failures require test-level causal evidence and exact historical source/build path deltas reconciled to the final RS-A manifest. Generic allowed categories and the two named candidate test edits do not themselves become approvals. Every other drift code or unrelated failure remains a blocker.
- Module-load failures are reported as failed file wrappers plus the unchanged historical inventory blocked from registration. This correctly avoids representing unregistered tests as executed, while demanding reconciliation of every file/hash/name/count and every actually registered current test.
- Independent copied-view source, build and overlay tamper cases must each trigger the appropriate unchanged guard. Module roots must resolve to the copied view. Production hashes, overlay policy, RC5 files and guards cannot change.

These requirements address the plausible ways a historical-image qualification could hide unrelated regression or lose reproducibility. The current unfiltered nonzero result, all other current passes, blocked inventory, historical passes and new refusal/tamper results must remain separately reported. The mandatory current RS-A suite and current production-copy rebuild are unchanged.

## Independently checked preservation and feasibility evidence

The durable overlay archive SHA-256 is `2fade6636c430fd1919e6113f249db4f2a2ba6a34affedcbae4d87b542bc7619`: exactly six entries, all matching the immutable guard's pinned table. The durable build archive SHA-256 is `b2dc34c4b3a17aca90071d8ba847015e6d2bb647ab199cdceb241c7a55b8d001`: exactly 244 entries, all matching the frozen built inventory. The manifest-named source ZIP SHA-256 is `4cace5d30cb88d2f288e03023fe6f3330e4dffcdcca8403f9fa9f4a97fe5d3c4`: exactly 1252 entries, all matching the frozen source inventory.

Using the specified SHA-256-of-sorted-two-space-path-lines algorithm reproduces the R-C package, built-inventory and working-inventory hashes (`9ae0c2b813388af58ee7d12e4df7f59521ba8cff417a4124ea9ddb2bff1c7fe1`, `fe536a0c681332b4e466d80d99c5c3ba89d8c8a31f70b3744f44931f8e9dabfd`, `98051ad21d224bf1140f76eeac8242c11153b899109c95cefd5889c0cbfe5e66`). The working-inventory aggregate is a check of its manifest entries; this does not claim the 59 archive-excluded historical files exist in the verification view.

The view resolves to `/private/tmp/atlas-reval-rsa/historical-rc5-view`, outside the checkout. Its 1252 source entries match subject only to the six accepted exact overlays; its 244 build entries, 120 RC5 entries and 87 offline entries also match. The only symlink found is `node_modules`, targeting checkout dependencies. Its package-lock bytes match the accepted source inventory.

The supplied historical command receipt lists exactly the 13 testfiles in the RC5 manifest, uses that view as cwd and records exit 0. I independently hashed the log to `f8769b9b9919d8d039195f57dc3b500b2da9c3e09bc96382becf3df7f8cb6d6e`; its summary reports 110 passed, 0 failed, 0 cancelled, 0 skipped and 0 todo. `HISTORICAL_RC5_VIEW_CHECKS.json` (SHA-256 `8a0f3ae7728387f9371b20cccc42084abbd25d698558efec8ec9ea8763adb712`) records the after-test snapshot `ok:true`, no drift, 1589 files checked and the expected pinned identities. `DURABLE_HISTORICAL_PRESERVATION.json` has SHA-256 `f26f473fc9d09fc94772286fd3fa38daed463608bf22e4df97211e96e905fcc2`.

I did not rerun the guard or tests. The supplied CHECKS object contains the after-test snapshot; final evidence must also retain the actual before-test snapshot, Node version and per-file logical inventory required by V2. Approval of this procedure does not waive those evidence requirements or certify final current failure attribution.

## Gate classification and stopping boundary

This is a verification-only correction within accepted architecture RC4. The identity guard continues refusing the future image, and historical tests exercise only their exact historical image. No authority, isolation, data, durability, financial, peer/physical, credential, public-protocol or closure invariant is changed. No new material architecture exception requiring fresh Astra/Fable approval was identified.

Current implementation acceptance remains pending the full current checks, exact failure/delta/inventory reconciliation, complete historical evidence and three tamper negatives. `loadedBinding:UNVERIFIED`, `verifiedPass:false` and `liveAcceptanceEligible:false` remain required. Historical RC5 compatibility with RS-A stays NOT_ADMITTED/PENDING a separately reviewed future revision. RS-B/C/D, paid calls, activation, customer use and deployment remain outside this approval. Integration still requires both independent approvals of this exact V2 hash and transfer from the sole checkout writer.
