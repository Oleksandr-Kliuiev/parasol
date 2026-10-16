# R-EVAL RS-A native peer helper routing

`peer.c`: closed Darwin arm64 peer-incarnation probe (brief §2, `docs/stage5/ask/remote/reval-server/rs-a/IMPLEMENTATION_BRIEF.md`).
Build only with `scripts/reval-server/build-peer.ts` (fixed flags and basename `reval-peer`); the owner pins its sha256. It
proves the peer pid/pidversion/uid/executable, never a loaded image. Do not add probes or options; tests inspect it externally.
