# Persistent worker boundary

Implemented in task 1.6 (durable inbox, claims with lease and claim token, two phases, bounded retry, dead letter, requeue) and 1.7 (shadow jobs): `packages/events/inbox.ts`, `packages/events/worker.ts`, `packages/events/shadow.ts`. The worker connects as the confined runtime role and uses `withScope` for every read and write.

Stage 1 has no scheduler or long-running process. One baseline pass over the operator's clients is `npm run ops -- worker-once`, one shadow-job pass is `npm run ops -- shadow-once` (`packages/ops/worker-pass.ts`); they are separate so that a slow experiment never holds back a baseline, and run from independent timers. Concurrent passes are safe. A long-running worker process with its own schedule belongs here in a later slice. Operation: `docs/RUNBOOK.md`.
