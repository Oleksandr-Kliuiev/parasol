# Native Fable 5.1 / high — APPROVE S2-LIVE plan RC5

2026-10-08. Bounded closure in the RC4 native Anthropic subscription session. Explicit model/effort unchanged;
actual response model only `claude-fable-5-1`, high. Exit0,44.6s,5turns,no permission denials.
Codex saved the returned read-only report. Session API estimates are cumulative, not attributable quota.

## Verdict: APPROVE

**Identity and scope.** Reviewer: Claude Fable 5.1, model ID claude-fable-5-1, same native Anthropic subscription session as the RC4 review, requested effort high. I cannot observe the runtime's effective effort or billing. This is a bounded closure re-review of exact RC5: brief declared SHA-256 494c614b…79a2f5 and manifest package 7cfdc792…5f2e3 with previous package 4cc8024d…748d6. Read-only, no Bash, no edits, no DB, no network, no subagents. I did not read history or any other reviewer's verdict. Approval covers conditional preparation only. It is not harness acceptance, not live acceptance, and not authorization of any target, setup transaction or owner-side exception.

**What I verified.** Four manifest entries are declared with the three supporting digests unchanged from RC4 and only the brief entry replaced. I did not recompute any byte hash; byte verification remains with Codex and Astra. I compared the full RC5 text against the RC4 text read earlier in this session. The only differences I found are the version heading and the replaced provisioning paragraph at lines 65 through 72. Auth, grants, exception authorization, privacy, driver, L3 and all other sections read identically.

**R1 closure against the accepted bind implementation.**

- **Setup leaves Connection empty.** RC5 now states the bootstrap creates no Connection row and forbids precreating an unbound row. This removes the dead-end path I flagged.
- **Bind creates the row with provenance.** The accepted service inserts a new DISABLED row with the actor as binder, a bind timestamp and lifecycle version 1, and writes a connection.bound client audit row in `packages/connections/connections.ts:123`. RC5 line 68 describes exactly that.
- **Refusal semantics stated correctly.** The service refuses an existing ID with CONNECTION_EXISTS and a duplicate tenant with TENANT_ALREADY_BOUND, matching RC5 line 69.
- **Ordering is executable.** Bind runs through the accepted CLI, which performs the runtime confinement check and token authentication before the command, and the command requires connections:manage on the membership. That permission is in the five-grant set, so the pilot operator can bind after owner disconnect.
- **Provenance invariants hold.** The lifecycle and binding-immutability triggers are BEFORE UPDATE only, so the insert with lifecycle version 1 is legal, and once set the provenance cannot be altered. The M365 authority requires provenance and DISABLED status before activation, both satisfied by a bind-created row.
- **Tenant and secret validation unchanged.** Bind enforces the lower-case non-nil tenant GUID for Microsoft 365 and the env reference pattern, consistent with the schema CHECK and the brief's private tenant and env reference wording.
- **Multiple pilot connections are compatible.** The unique key is per workspace, system and tenant, so one M365 and separate Atera or Huntress bindings for L4 do not collide.

**Limits.** No code or tests changed and I reran nothing. The helper test requirement on line 70 is a future obligation for the Opus implementer and Astra, not something verified here. Unknown target, config, license, human attestation and the RLS_NOT_ENABLED preflight state continue to block any actual run, and L3 remains BLOCKED_EXTERNAL as the brief states.
