# Persistent worker boundary

Implemented in task 1.6 (durable inbox, claims with lease and claim token, two phases, bounded retry, dead letter, requeue) and 1.7 (shadow jobs): `packages/events/inbox.ts`, `packages/events/worker.ts`, `packages/events/shadow.ts`. The worker connects as the confined runtime role and uses `withScope` for every read and write.

Stage 1 has no scheduler or long-running process. One pass over the operator's clients is `npm run ops -- worker-once` (`packages/ops/worker-pass.ts`), started by hand or by an external timer. Concurrent passes are safe. A long-running worker process with its own schedule belongs here in a later slice. Operation: `docs/RUNBOOK.md`.
