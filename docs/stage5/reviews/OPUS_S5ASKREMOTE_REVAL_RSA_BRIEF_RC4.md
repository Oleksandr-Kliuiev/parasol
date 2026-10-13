# Bounded re-review — S5ASKREMOTE-REVAL-RSA-BRIEF-rc4 (continuing my own independent Opus brief review session)

**Verdict: APPROVE_BRIEF.** My RC3-R1 and all the nearby items listed are repaired. I found no remaining required
finding and no regression. This is brief acceptance only. It does not authorize or accept any code, test result,
activation or data/budget admission. Code acceptance is a separate gate.

## 1. Exact identity (verified by me)

| Item | Result |
|---|---|
| Artifact | `S5ASKREMOTE-REVAL-RSA-BRIEF-rc4` (a brief revision; the parent architecture is still RC4) |
| Lineage | parentBriefHash = rc3 `5fb55a6846327aab4b55ad04be6104bd2ff2c847aee919ec81e03883ab4fe343`; parentArchitectureHash = RC4 `9fa16222d6c32c18d4d193b6666e078fd3624a4bdb2ccb8ab9fbd68113b08163` |
| packageHash | `e8f87336b1cf7e0ba7b18702378f3a6efb877b20e5d9aa4e9a96ee175bf85040`, recomputed (sha256 of compact JSON of path-sorted entries). **MATCH** |
| Manifest | `…RSA_BRIEF_RC4_MANIFEST.json`, sha256 `133cfc42403c469c1250abe5d3c2d228dc288fe21cc1bdabb5893fb79f6b56f7`. 44 entries, sorted, all match on disk |
| ZIP | `…RC4_PACKAGE.zip`, sha256 `0b82e1cb39e1f9889879f05b3526ab2becb4003e912993b919c4f31938b8d636`. 44 entries read in memory; all byte-equal, none extra or missing |
| CHECKS | `…RC4_CHECKS.json`, sha256 `a4a8fbbb9435539dc5ae9520767adbb03b1c0dc644d9d26f0f3be568d11de0b7`. Claims static checks plus fixture preflight only; `candidateImplementationTested:false` |
| Delta vs rc3 | Changed: `rs-a/IMPLEMENTATION_BRIEF.md` (469 lines) and `rs-a/ACCEPTANCE_CHECKS.md` (174 lines). `AGENTS.md` unchanged. Nothing added or removed. I diffed both against the sealed rc3 ZIP |
| Unchanged | RC4 architecture: 38 of 38 entries. Execution RC5: 120 of 120. Baseline: 1540 of 1540. HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66` |

## 2. Session, effort, telemetry, conduct

- This continues my own independent brief review session (RC1 → rc2 → rc3 → rc4). Requested: native
  `claude-opus-5-5` at `xhigh`. I make no self-identification claim as model evidence; the root checks the actual model
  from assistant-message metadata.
- I cannot observe the effective effort, billing route (native Max/included), elapsed time or token use from inside
  the session, so all four are **UNAVAILABLE**. I requested no API, credits, fast mode or fallback.
- Read-only throughout:
  - No repository or code writes.
  - No DB connection, tests, network, provider calls or activation.
  - No secrets or status files read.
  - I read no other reviewer's verdict and no author conversation.
- For one feasibility check I read the accepted test `tests/pg/ask-remote-policy.pg.test.ts:138–147`. This report is
  my only write.

## 3. RC3 findings and listed items — closure

| Item | Status | Where |
|---|---|---|
| **RC3-R1** — owner principal | **CLOSED** | Checks L62–69. In every test where E runs (closure, executor lifetime, E physical binding, native chain), the owner config credential is a dedicated `NOSUPERUSER NOBYPASSRLS` LOGIN (CREATEDB+CREATEROLE). It ran `migrate deploy` and roles.sql (non-superuser branch), so it owns the tables. The admin/superuser only bootstraps and drops, and never appears in any owner config or spawned process. `rolsuper`/`rolbypassrls` are recorded false for the owner, runtime and reader roles. The positive closure therefore proves scope was set before the FORCE-RLS read. A skipped-scope seam → zero rows → `REGISTRATION_MISMATCH` before any lock, with no revise call. The native setup was updated to match (L149–152) |
| Feasibility of RC3-R1 | ✔ | The accepted boundary technique for version max−1 / Int max is `ALTER TABLE … DISABLE TRIGGER USER` run by the table owner (`ask-remote-policy.pg.test.ts:142–144`), which needs no superuser. The non-superuser owner can create attempts as the runtime (reserve), or by `SET ROLE` to the remote definer through its accepted non-superuser `SET TRUE` link (`roles.sql:410`). There is no conflict with "admin bootstrap only" |
| SQL `sha256` | ✔ | `sha256(convert_to(…::text,'UTF8'))` for both fingerprints, computed in the same session/TimeZone (brief L270–273) |
| Revise row/value check | ✔ | The revise statement must return exactly one row, whose value is `expected` (pre-state PAUSED) or `expected+1` (pre-state ACTIVE/INACTIVE). Zero rows, more rows or any other value → ROLLBACK, `POLICY_CHANGED`, never treated as a no-op (L278–280). Test seam: checks L101–102. Version exhaustion still reaches step (6): the return value is `expected+1`, state is TOMBSTONE → `CONTAINMENT_UNCONFIRMED`, consistent with the map |
| FD inheritance test | ✔ | Checks L127–139:<br>- the parent holds sentinel handles and records their identities;<br>- C, S and E probe at first JS and classify descriptors the runtime opened itself;<br>- inherited application handles are exactly 0–2 (`/dev/null`) and fd 3;<br>- no descriptor matches a sentinel, and there is no total-count/range assertion;<br>- the production helper is unmodified and inspected externally via a paused invocation plus `lsof`;<br>- a detector self-test with an injected extra sentinel must fail.<br>Consistent with brief §2c L107–115 |
| Fixed `application_name`s | ✔ | `atlas-reval-c-reader`, `atlas-reval-s-runtime`, `atlas-reval-e-owner` (brief L151–153), used in the S cross-check (L173) and the lifetime checks (checks L115–116, L137–139) |
| Reader password residual | ✔ | Added: the reader string resident in C, plus the S and E strings (brief L467–468) |
| Tags removed | ✔ mostly | `(R6)`, `(R3)` and `(R2)` are removed. See NB-1 |
| Scope | ✔ | No new architecture, scope, DTO, finance or authority. A1–A10 are unchanged and within RC4. The header now states "brief revision, not an architecture revision" (L3) |

The earlier closures still hold:
- RC2-R1: the branch is bound to the pre-call state, preserved arguments go straight from the locked row in SQL, and the whole row is compared.
- RC2-R2: the mandatory native production chain, with zero skips in the evidence run.

## 4. Required findings

None.

## 5. Nonblocking notes (for implementation and code review; no new brief revision needed)

- **NB-1 — Cosmetic tags.** Finding-ID tags remain in checks L38 `(R9b)`, L43 `(R9c)` and L48 `(R9a)`. Not verdict or history claims. (`RC2_MINOR` at L101 is the RC4 obligation ID and is legitimate.)
- **NB-2 — Test-only seams.** The static "no relaxation selector" check (checks L51–54; brief §3) should also cover every test-only seam added since RC1: skip-scope, zero-row revise, argument difference, injected ROLLBACK, ack loss / commit unknown, simulated clock. `productionDeps()` and the production entries, config and env must wire none of them.
- **NB-3 — Helper inspection.** The paused helper invocation should go through the production peer-spawn function (`packages/reval/peer.ts`), so the inspected descriptors reflect C's real helper spawn configuration rather than a test-only spawn.
- **NB-4 — S pool connections.** Put `application_name=atlas-reval-s-runtime` in S's in-memory runtime URL too (brief L170–172), so its pool backends are attributable in the "no runtime/owner backend for C" check.
- **NB-5 — Code precedence.** For an ACTIVE/INACTIVE pre-state whose call returns `expected`, step (5) refuses with `POLICY_CHANGED` before step (6)'s `CONTAINMENT_UNCONFIRMED`. Both fail closed with no latch. Tests should assert that exact code.

## 6. Residuals (declared honestly; unchanged)

- Full loaded image/immutability UNVERIFIED (RS-D); helper TOCTOU.
- Socket swap possible between checks and between IDENTITY rechecks.
- Closure confirmation inherits snapshot limits and binding failures.
- RS-C must keep S's runtime binding before any Ask path.
- Docker timing is regression evidence only. Native fixture results are test-fixture evidence: never MEASURED, not platform/image proof.
- Password strings persist in JS memory (C reader, S runtime, E owner).
- `pg_stat_activity` cross-check visibility.
- Same-UID/root/kernel trust limit; darwin x86_64 refused; S logs dropped.
- A3: production RS-A refuses until RS-B.
- `roles.sql` is about 660 lines (under the 700 cap).
- No paid calls, activation or admissions.
