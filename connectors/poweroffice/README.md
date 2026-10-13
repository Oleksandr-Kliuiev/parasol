# PowerOffice — synthetic MOCK export port (Stage 4)

Design: `docs/stage4/` (01 scope, 02 DTOs, 04 port and sync). Code routing: `packages/poweroffice/AGENTS.md`.

- `contract.ts` — the Atlas-normalized export port: private sessions pinned to connection/company/lifecycle/attempt/asOf,
  one `readPage` per ordinal with an AbortSignal and a monotonic deadline, `closeSession`. Not a vendor wire schema.
- `builtin.ts` — the only implementation: a deterministic in-process synthetic export (invented MOCK invoices; size chosen
  by the synthetic company UUID), with cancellation before, during and after its work.

There is no vendor HTTP adapter, token provider, OAuth, credential or secret resolution, webhook, file or URL source here;
the composition (`packages/poweroffice/composition.ts`) is DISABLED by default and only the exact `MOCK` mode composes the
built-in port. Real PowerOffice v2 endpoints, company proof, accounting semantics and live reads remain the separate,
owner-deferred S4-LIVE gate (`docs/stage4/04_PORT_AND_SYNC.md` "Official references and future LIVE").
