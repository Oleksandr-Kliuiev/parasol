# Frozen RS-D-C test input

`rsdc.json.gz` is gzip-compressed canonical JSON (`version`, `view`, `provenance`,
`files`). `files` maps repository-relative paths to base64-encoded historical bytes.
The test reader uses these bytes for frozen sources/build outputs and reads unchanged
historical verification metadata from the repository. It never writes production files.

Provenance: Atlas commit `459b1de0f2edd0a6870d12a19af20191d30db9c2`, the committed
verification ZIPs, and the deterministic API/operator builds of that commit with its
locked dependencies. Source/build entries were selected by their original SHA-256,
in the acceptance order used by `scripts/reval-instrument/identity.ts`; administrative
seal deltas, the pinned build inventory, and the RS-D-C candidate seal were retained.
No expected hash or approval seal was regenerated.

The archive contains test inputs, not code to execute. `tests/support/reval-history.ts`
passes its Reader to the **current** `verifyRevision` implementation before binding the
corpus. `reval-instrument-identity.test.ts` verifies the positive case and corrupts anchors,
seals, source files, build outputs and candidate files to verify fail-closed behaviour.
The production CLI is separately required to reject current checkout drift.

To inspect the fixture without running historical code, decompress it with Node's
`gunzipSync`, parse JSON and decode a selected `files[path]` from base64. Rebuilding
requires a separate checkout of the commit above, its API/operator build, and matching
bytes from the existing verification ZIPs. Do not derive accepted hashes from current
Parasol source. Run the chained identity/tamper tests after any fixture change.
