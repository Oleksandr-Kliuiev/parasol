# S2-LIVE pilot recorder routing

Read ../../../docs/AI_CONTEXT_MAP.md first. Authority: docs/stage2/reviews/S2LIVE_OPERATIONAL_BRIEF_RC5.md (§L4 recorder,
admission) and S2LIVE_RECORDER_IMPLEMENTATION_BRIEF.md. Preparing this driver is not authorization to run it live: fresh Astra
xhigh acceptance of the exact code, owner-provided target/grants/credentials and the RC5 prerequisites come first.

- classify.ts: fixed endpoint classes (token POST, Graph GET via the accepted `assertGraphUrl`, Atera/Huntress GET paths).
- receipts.ts: allowlisted receipt shapes, NEW-file (`wx`, 0600) sink with write + fsync per line.
- recorder.ts: recorded Stage 1 / Graph / auth transports over one private dispatch; pre-dispatch receipt or zero dispatch.
- guard.ts: captures native fetch, installs the refusing global fetch guard; `dispatch` goes to createRecorder only.
- config.ts: clean-process check, private config, command allowlist (refused before parsing flags), pilot authority extras.
- project.ts: typed allowlist projection per command, run-local aliases, final safe-string walk.
- driver.ts: the ordered admission/composition; scripts/stage2-live-pilot.ts is the thin entry.

Private configuration (outside the repository; placeholders shown, never real IDs in public files):

```json
{ "version": 1, "command": "m365-sync",
  "flags": { "client": "<client id>", "connection": "<m365 connection id>", "resource": "users" },
  "scope": { "client": "<client id>", "connections": ["<m365 connection id>"] },
  "output": { "receipts": "/absolute/private/dir/run-001.receipts.jsonl", "private": "/absolute/private/dir/run-001.private.json" } }
```

`node --experimental-strip-types scripts/stage2-live-pilot.ts --config /absolute/private/dir/run-001.json`

Allowlist: m365-probe, m365-sync, m365-status, m365-directory, correlation, live-read, mapping, confirm-link. Everything else
(bind, worker/shadow/decisions, requeue/reset/disable, cleanup, triage, telemetry) is refused before flag parsing, DB or I/O.
Never add a configurable origin, fixture resolver, mock mode or retry; never edit accepted core files from here. Keep files
≤500 lines. Tests: tests/pilot-{recorder,redirect,admission,privacy,process}.test.ts, tests/pg/pilot-driver.pg.test.ts,
support tests/support/pilot-*.ts (loopback servers and injected dispatch are synthetic test mechanisms only).
