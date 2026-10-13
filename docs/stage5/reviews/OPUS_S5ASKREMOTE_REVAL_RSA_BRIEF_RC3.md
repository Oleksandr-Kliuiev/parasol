# Bounded re-review — S5ASKREMOTE-REVAL-RSA-BRIEF-rc3 (continuing my own independent Opus brief review session)

**Verdict: CHANGES_REQUIRED.** One required finding (RC3-R1), one sentence to fix, in the native fixture setup text
that rc3 itself added. My RC2-R1 and RC2-R2 are closed, and every nearby item the root listed checks out. The changes
stay within RC4 and are a bounded repair: no new scope, no exported DTO change, no finance or authority change. This
brief does not need fresh Astra/Fable review.

## 1. Exact identity (verified by me)

| Item | Result |
|---|---|
| Artifact | `S5ASKREMOTE-REVAL-RSA-BRIEF-rc3`; manifest parentBriefHash = rc2 `c752398d…cfdb`; parentArchitectureHash = RC4 `9fa16222…8163` |
| packageHash | `5fb55a6846327aab4b55ad04be6104bd2ff2c847aee919ec81e03883ab4fe343`, recomputed (sha256 of compact JSON of path-sorted entries). **MATCH** |
| Manifest | `…RSA_BRIEF_RC3_MANIFEST.json`, sha256 `18013fc206bd48a8bccd5b323872e07e8459a8ae9f41a088f2bc6dabdcb52088`. 44 entries, sorted, all match on disk |
| ZIP | `…RC3_PACKAGE.zip`, sha256 `0622a0c99e76750f2b87cef28515f745c71ec897f9341dc5486205b42770339e`. 44 entries read in memory; all byte-equal, none extra or missing |
| CHECKS | `…RC3_CHECKS.json`, sha256 `5d8e5fcf3cefcf6d4597c1707547bd41c8fa597742dd51a51f8291ef2792f02a`. Claims static checks plus fixture preflight only; `candidateImplementationTested:false` |
| Delta vs rc2 | Changed: `rs-a/IMPLEMENTATION_BRIEF.md` (462 lines), `rs-a/ACCEPTANCE_CHECKS.md` (153 lines), `rs-a/AGENTS.md` (10 lines; adds `ACCEPTANCE_CHECKS.md` to the read-first list). Nothing added or removed. I diffed each file against the sealed rc2 ZIP |
| Unchanged | RC4: 38 of 38 entries. RC5: 120 of 120. Baseline: 1540 of 1540. HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66` |

## 2. Session, effort, telemetry, conduct

- This continues my own independent brief review session (RC1 → RC2 → RC3). Requested: native `claude-opus-5-5` at
  `xhigh`. I make no self-identification claim as model evidence; the root checks the actual model from
  assistant-message metadata.
- I cannot observe the effective effort, billing route (native Max/included), elapsed time or token use from inside
  the session, so all four are **UNAVAILABLE**. I requested no API, credits, fast mode or fallback.
- Read-only throughout:
  - No repository or code writes.
  - No DB connection, tests, network, provider calls or activation.
  - No secrets or fixture credentials read.
  - I read no other reviewer's verdict and no author conversation.
- This report is my only write. Brief review only; code acceptance is a separate gate.

## 3. RC2 findings — closure

**RC2-R1 (no artificial revision) — CLOSED** (brief §6 L265–284; checks L95–101).
- (a) The branch is bound to the state before the call:
  - pre-state PAUSED must be the no-op (`fullPost = fullPre`, same version, fence unchanged);
  - pre-state ACTIVE/INACTIVE must be applied (`restPost = restPre`, version+1, PAUSED, OWNER, fence+1);
  - anything else, including a no-op on ACTIVE or a TOMBSTONE from exhaustion → ROLLBACK, REFUSED `CONTAINMENT_UNCONFIRMED` (map L293).
- (b) A single SQL statement passes every preserved argument straight from the locked row (L269–273), so
  `timestamptz(6)` keeps its microseconds and no policy value passes through JS. The argument order matches the accepted
  signature (`202610111020:281–283`).
- (c) Whole-row fingerprints are compared in SQL. Excluding `policyVersion/state/stateReason/revisedAt` matches exactly
  what the accepted revise UPDATE changes.
- (d) Tests: microsecond `expiresAt` on both paths; a runtime `stateReason` of MODEL_MISMATCH that the no-op keeps; an
  injected argument difference that rolls back; an ACTIVE row whose call is a no-op → REFUSED; a spy showing no policy value or
  secretRef enters JS.
- The core of the root's R6 is unchanged: the routine is always called on an already-PAUSED row, there is never a
  closure after ROLLBACK, the reread must match exactly, floors are strict, and an unknown acknowledgement latches.

**RC2-R2 (native production chain) — CLOSED except for RC3-R1** (brief §3 L187–194; checks L127–145, L149).
- The test drives the unmodified production chain, with no `tests/support` DI in any spawned process:
  - O runs under a real PTY via `/usr/bin/script`;
  - C runs with `productionDeps()`;
  - S is the built `main.js` in bridge mode;
  - E is the production `owner-exec.ts`;
  - the helper is the built binary pinned by sha256.
- It covers IDENTITY (UNVERIFIED, `rsa-peertoken-unixphys-v1`), the exact SNAPSHOT, both closures (applied and
  already-PAUSED no-op), and three physical negatives (socket dev/inode, `postmaster.pid` pid/start, DB OID).
- In the evidence run the env variable is mandatory: a skip, a missing descriptor or an unreachable cluster is a failure.
- Results are labelled test-fixture evidence (never MEASURED, not platform/image proof), and secret contents are excluded.

**Other nearby items the root asked me to check:**

| Item | Status | Where |
|---|---|---|
| Inherited vs newly opened descriptors | ✔ | Brief §2c L107–115 separates the exact inheritance allowlist (0–3; helper 0–4 + stdout; no ctty) from descriptors opened after exec. See NB-3 for test wording |
| Monotonic relative deadline clamp | ✔ | `remainingMs` 1..1400 from C's monotonic clock (L250, L255–257). E's timeouts `max(1, min(1400, …))` (L244). Wall-clock-jump test (checks L31–32) |
| Pinned `apiEntry` | ✔ | Must be the realpath of `dist/apps/api/src/main.js` and an entry of the compared manifest (L122–123) |
| Honest password residual | ✔ | Buffer zero-filled, string persists until GC (L260–262, L461). See NB-5 |
| Routing names | ✔ | Brief L4–5, checks L1/L5, RS-A AGENTS L3 |
| Minimal Prisma inverses | ✔ | Only `RemoteAskPolicy`, `RemoteAskClientAdmission`, `Client`, `Actor`; none on `Workspace` (L231–234) |
| Startup ordering | ✔ | Snapshot wrapper before `server.mode`, so LAUNCH needs a registered sandbox (L79–80) |
| Complete capability checks for both new roles | ✔ | Retained (L387–391) |
| Verdict/history claims removed | ✔ | Only cosmetic finding-ID tags remain (NB-6) |

## 4. Required finding

**RC3-R1 — E's owner principal is not pinned to a non-superuser, non-bypassing table owner, so the FORCE-RLS behaviour
the brief relies on can go unexercised (checks L129–132 "Setup (admin, test-only): … migrations + roles.sql …"; the
closure, executor-lifetime and E physical cases in checks L89–105; brief §3 L176–180).**

The problem:
- E must use the table-owner login (RC4 01:47–51).
- The rc3 native setup runs migrations and roles.sql as the fixture admin role.
- The existing harness owner is `ATLAS_PG_ADMIN_URL`, which is "the compose superuser" locally, and the harness documents it as "Bypasses RLS by design; never handed to application code under test" (`tests/support/pg-harness.ts:14–17, 26`).
- Following either pattern literally puts a superuser (or BYPASSRLS) credential in the owner config, and FORCE RLS does not apply to superusers.

The consequences:
- The required order, "set `app.workspace_id` BEFORE the FORCE-RLS registration read" (brief L177–180, my RC1 R4(e)), would pass even if it were missing.
- roles.sql would take its superuser branch rather than the non-superuser branch of the documented production path (`pg-harness.ts:14–17`: CREATEDB + CREATEROLE).
- The "production chain" evidence would not be production-faithful on exactly the scope/RLS property.

Required change (test wording only; no change to production behaviour or architecture):
- In the native production chain, and in every PG17 test where E runs (closure, executor lifetime, E physical-binding cases):
  - the owner credential in the owner config is a dedicated `NOSUPERUSER NOBYPASSRLS` LOGIN that owns the tables, because it ran `migrate deploy` and roles.sql (non-superuser branch);
  - the fixture admin or compose superuser only creates that owner, the temporary database and the roles, and drops them afterwards;
  - the admin/superuser never appears in an owner config.
- The evidence records `rolsuper=false` and `rolbypassrls=false` for the owner, runtime and reader roles actually used. With such an owner, the positive closure itself proves the scope was set before the registration read.
- Optional: one test-only seam that skips setting the scope → zero rows → REFUSED `REGISTRATION_MISMATCH` before any lock.

## 5. Nonblocking notes

- **NB-1 — sha256 over text (L267–268).** PostgreSQL has `sha256(bytea)` only. Use `sha256(convert_to(to_jsonb(p)::text, 'UTF8'))`. The fingerprints are stable because pre and post are computed in the same session (same TimeZone; jsonb renders ISO timestamps with microseconds).
- **NB-2 — Revise statement row count (L269–273).** Require the statement to return exactly one row, whose value is `expected` (no-op) or `expected+1` (applied). Zero rows → ROLLBACK, REFUSED `POLICY_CHANGED`. Under the step (3) lock zero rows shouldn't happen, but if it did, the PAUSED no-op branch would see `fullPost = fullPre` and commit without the routine having been called.
- **NB-3 — Inheritance test wording (checks L117–121).** At the first JS instruction, Node/libuv already hold descriptors they opened after exec (kqueue, wakeup/signal pipes), so "exactly … and nothing else" can't hold literally. The test should assert:
  - fds 0–2 are `/dev/null`, and fd 3 is the expected AF_UNIX end;
  - none of the parent's planted canaries appears, matched by identity (vnode, or the `lsof` socket address);
  - everything else is classified.

  The helper needs an external `lsof` or a paused test probe; the production helper stays unmodified. This matches brief §2c.
- **NB-4 — Mapping backends to processes (checks L121–122).** `pg_stat_activity` cannot tie a Unix-socket backend to a client pid. Use a fixed `application_name` per process, or phase windows.
- **NB-5 — Reader password residual.** The residual at L461 names the owner and runtime password strings. Also name the reader password held by the resident C.
- **NB-6 — Cosmetic tags.** Finding-ID tags remain at brief L321 "(R6)" and checks L69 "(R3)" and L105 "(R2)". They are cosmetic, not verdict claims.

## 6. Classification and residuals

- Everything stays within RC4. The rc3 changes tighten tests, inheritance and deadline handling, fix wording, and remove history claims.
- A1–A10 are unchanged.
- The residuals are declared honestly:
  - full image UNVERIFIED (RS-D);
  - socket swap between checks;
  - closure confirmation inherits snapshot limits;
  - RS-C must keep S's runtime binding before any Ask path;
  - Docker timing is regression evidence only;
  - password strings persist in JS memory;
  - native fixture results are test-fixture evidence only;
  - `roles.sql` is about 660 lines.

If RC3-R1 is repaired as text-only wording under a new exact hash, this session can review the delta.
