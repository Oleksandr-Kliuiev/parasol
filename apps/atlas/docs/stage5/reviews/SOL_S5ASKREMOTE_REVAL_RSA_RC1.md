# Independent RS-A code acceptance review

**Verdict: CHANGES_REQUIRED.** This verdict covers only `S5ASKREMOTE-REVAL-RSA-rc1`, package SHA256 **`1f5cd250970daab57b5004ce291abe04d4ef42961c57450d6a15ac2fcea0a05c`**, 338 entries. Four required findings follow; R1–R3 have independent, nonmutating reproductions. No dependent checkpoint should advance on this artifact.

Requested reviewer: fresh native Codex `gpt-6.1-sol` / `xhigh`, independent of orchestration, implementation and brief reviews. Actual response-model/provider/billing telemetry is collected externally by root; this report does not establish it by self-identification. Attributable subscription usage and exact elapsed time are unavailable here. No delegation, other code-reviewer verdict, author conversation, build, migration, repository/DB mutation, provider call or activation was used. The only file written is this report.

## Required findings

### R1 — P1: enforce the operation deadline around physical binding and rechecks

**Locations:** `packages/reval/controller.ts:57–67`, `:80–84`, `:106–108`; `packages/reval/physical.ts:74–85`; `packages/reval/deps.ts:66–73`.

The first request awaits `connectReader()` before reaching the snapshot reader's timer, and later reader reconnection/IDENTITY rechecks also await untimed physical work. `connectionTimeoutMillis` bounds connection establishment, not `client.query(PHYSICAL_QUERY)`. That query and filesystem work have no operation timer. There is no outer controller race/cancellation against `t0 + 1800`. Thus a hung physical query or recheck can withhold all C responses past O's 2 s deadline. Shutdown also waits for `current` at controller line 146, so EOF does not unblock that wait.

**Independent reproduction:** appendix A substitutes a never-completing physical-bind dependency after successful platform/helper/peer gates. At 2200 ms it produced `connects:1,responseFrames:0`. This is a pure DI reproduction, not a claim that the provided native PG fixture hung. Source tracing shows the corresponding untimed production query at physical line 79 and deps line 69.

**Impact:** violates BRIEF §§6/7/9's single 1800 ms operation budget and delivered-before-2 s requirement; failure-path timing and parent-loss cleanup are not guaranteed by the happy-path PTY measurements.

**Required repair/check:** propagate one absolute deadline through startup, binding/rebinding, recheck and export; bound all awaited work, invalidate/destroy timed-out reader clients, prevent late startup/S launch or late success, and make EOF cancel outstanding work. Add controller-level stall tests at initial binding, reconnect and IDENTITY physical query, including owner EOF during each. Require the appropriate authenticated failure by 1800 ms after peer proof, no late response/effect, and bounded process/backend cleanup. Preserve the approved local exit set before peer proof. An outer timer must not leave an abandoned operation able to mutate controller state later.

### R2 — P1: reject duplicate private handshake frames before credential access

**Locations:** `apps/api/src/reval/bridge.ts:70–78`; `packages/reval/owner-exec.ts:126–137`; `packages/reval/server-link.ts:48–54`; `packages/reval/channel.ts:27`, `:39–42`, `:66–68`.

Channel queues every valid frame, but S and E consume one launch/request and immediately read a credential and connect. They never reject an already queued duplicate; E does not subsequently consume it at all. C similarly does not reject a duplicate HELLO before sending its private launch/request. This violates BRIEF §2e: unsolicited/early/duplicate private frames abort with no secret read.

**Independent reproduction:** appendix B sends two identical schema-valid private frames in one socket write, after observing the child's HELLO. S printed `READ_SECRET_CALLED`, `DB_VERIFY_CALLED`, `BRIDGE_START_RETURNED` and exited 0. E printed `OWNER_SECRET_READ`, `OWNER_CONNECT_CALLED` and exited at its deadline (20). Both use the actual production libraries with spy dependencies; no secret file or DB was touched. The duplicated frames are present before the promise continuation reaches credential access.

**Impact:** malformed private protocol traffic crosses the credential/connection boundary instead of failing closed. Existing tests at `tests/pg/reval-launch.pg.test.ts:198–212` test missing/non-launch frames, not duplicate valid frames; pure schema decoding cannot establish handshake ordering.

**Required repair/check:** enforce explicit private-channel phases and permitted frame counts on both endpoints; reject queued/coalesced duplicate HELLO/launch/request/result frames and unexpected transitions. Cover S and E with secret-read/connect/effect spies, including two valid frames in one chunk, fragmented duplicates, a frame before HELLO, wrong-phase traffic and duplicate traffic while work is pending. Before credentials/effects begin, violations must leave those spies at zero; after a request may have executed, preserve the approved uncertainty/latch semantics. Do not change the exported 01/02/06 schemas or weaken peer proof.

### R3 — P2: preserve authentication errors through the physical connector

**Locations:** `packages/reval/physical.ts:76–77`; `packages/reval/owner-exec.ts:62–63`; `packages/reval/closure.ts:44–50`.

`verifyPhysicalEndpoint()` converts every connection error into `PhysicalMismatchError('connect')`. Consequently E never sees SQLSTATE `28P01`/`28000` from production authentication: runOwnerExec returns `REGISTRATION_MISMATCH`, bypassing the explicit `OWNER_REQUIRED` phase/outcome mapping in BRIEF §6. The pure `refusedCodeFor()` tests pass without exercising this wrapper.

**Independent reproduction:** appendix C injects `28P01` through the actual physical connector and runOwnerExec. Observed `{outcome:'REFUSED',code:'REGISTRATION_MISMATCH'}`; the required code is `OWNER_REQUIRED`. No DB operation occurred.

**Impact:** the closed failure contract misidentifies invalid owner credentials as sandbox identity drift. Other mapped connect failures can also lose their cause.

**Required repair/check:** distinguish genuine physical mismatches from the SQL/auth errors needed by the approved executor map without exposing diagnostic text or credentials. Exercise `28P01` and `28000` through the production connector path, and a real invalid-password native/PG fixture case. Assert `REFUSED OWNER_REQUIRED`, no lock/revise, no closure, no latch, one spawn and timely cleanup. Keep wrong physical tuples as `REGISTRATION_MISMATCH`.

### R4 — P2: complete mandatory independent negative controls

**Locations:** `tests/pg/reval-launch.pg.test.ts:181–212`; `tests/pg/reval-native-unix.pg.test.ts:113–125`; `tests/pg/reval-closure.pg.test.ts:106–120`, `:169–174`; `tests/pg/reval-upgrade-guard.pg.test.ts:64–79`, `:88–94`. Requirements: ACCEPTANCE_CHECKS “physical binding”, “guard” and “closure”.

Several explicitly required controls are absent or not isolated:

- There is no case where C's reader is correctly bound but S is independently directed to another otherwise-ready DB, no forged `RevalServerBoundV1.observed` tuple differing from the reader, and no copied registration/instance UUIDs on another physical DB. All native config negatives change the common config and stop at C's reader before S/E starts. The E test at closure line 172 changes expected `systemIdentifier` in the same-DB test seam, rather than connecting E to another DB with copied logical identity.
- The guard tests exercise foreign client and an unknown registration/dataset together, but not isolated foreign actor/admission and mismatched dataset against an existing registration. Binding registrationId/workspaceId immutability is not tested. Replica-mode coverage is binding UPDATE/TRUNCATE by the non-owner admin, not the enumerated owner immutability/monotonicity/FK cases under replica.
- Only the APPLIED closure test plants nonzero `expiresAt` microseconds (line 88). The already-PAUSED NO-OP case does not plant them, although preservation on both paths is explicitly mandatory.

**Impact:** 26 passing RS-A PG tests and the native positive chain do not satisfy every mandatory negative control. The verification addendum qualifies historical RC5 identity failures only; it does not waive these checks.

**Required repair/check:** add isolated, meaningful cases for the bullets above with the documented dedicated NOSUPERUSER/NOBYPASSRLS owner. For independently wrong S/E DB targets, establish that the control reader/registration path is valid, then assert no S listen/Bound success or E lock/revise and no closure. Tamper one invariant per FK/guard case, including under replica where required; plant nonzero microseconds on an already-PAUSED row and require whole-row equality and a confirmed no-op COMMIT. Preserve the required all-current-RS-A-checks rule, and report precisely which checks ran on the repaired artifact.

## Identity, scope and substantive assessment

Independently recalculated the compact sorted manifest hash: exact expected package, 338 current files match, ZIP has exactly the same 338 entries with identical bytes and no extras. All 203 build-inventory entries match the current build; inventory hash is `5e8d7f3270efebe3315a2a215aec7573ada9daa6d904c56c49f7f83440dd2116`. The 1540-file baseline has exactly the declared 14 modifications, no missing files; the lineage current inventory matches. All 120 execution RC5 files remain exact. Accepted child changes do not require historical parent references to become old again.

Inspected all new production boundaries and focused tests. The additive scoped FKs, FORCE RLS, owner-only ALWAYS guards, column-based evidence definer, EXECUTE-only reader and broad effective-capability/readiness checks are coherent. The snapshot clears caller GUCs, selects by session login OID, uses RR/RO, computes full-project pricing/counts and counter integrity, refuses missing referenced counters, synthesizes only absent current periods, and exports only the permitted registered-scope attempt metadata. Actual pricing columns and pinned rates are used. No new finance/Ask/browser behavior was found outside allowed child deltas.

The owner transaction sets scope before registration/locks, locks fence before policy, keeps preserved policy arguments inside SQL, checks exactly one revise result, and branches postconditions on pre-state using whole-row/rest fingerprints. It calls the routine on the already-PAUSED path and uses COMMIT; closure requires confirmed commit, one exact reread and both strict floors. Commit uncertainty and reread drift latch without retry. Those implementation choices are sound; R1–R4 prevent acceptance of their complete required runtime/evidence contract.

The six parity/invariant changes are within bounded §10: context-mapper adds fail-closed reval facts; m365-database adds the reader-password canary/status row; the two action-upgrade tests add exactly the new migration; ask-remote-upgrade excludes only the newly governed Reval tables from the ancestor privilege-preservation comparison; poweroffice-envelope explicitly requires/excises one added `$reval$` block while retaining the outer transaction-control scan. No blanket assertion removal or unrelated test relaxation was found.

## Verification addendum qualification

The approved addendum SHA is exactly `59c2fd7f82020d62cbbdd070494b62fcb5cdae719e0568c98ab8d34492dc99dc`. Its qualification is supported; it is not a separate required finding:

- Independently ran the unchanged guard read-only: current `{ok:false,drift:['RC_SOURCE_DRIFT','RC_BUILD_DRIFT']}`; historical view `{ok:true,drift:[]}`. Current drift has exactly 14 allowed source deltas and the two declared historical build deltas; no admin/offline/dataset/manifest drift.
- Durable archives verify: six-overlay ZIP `2fade6636c430fd1919e6113f249db4f2a2ba6a34affedcbae4d87b542bc7619`, 244-build ZIP `b2dc34c4b3a17aca90071d8ba847015e6d2bb647ab199cdceb241c7a55b8d001`. The sealed R-C source ZIP verifies at `4cace5d30cb88d2f288e03023fe6f3330e4dffcdcca8403f9fa9f4a97fe5d3c4`; all 1252 pinned source and 244 build entries match. R-C package and working/build inventory hash algorithms recalculate correctly.
- Historical view matches pinned source (with exact accepted six overlays), build and all 120 RC5 files, has only a dependencies-only node_modules symlink, and its package-lock matches the pinned hash. Recorded Node is v25.8.1. Receipt `d90892a801800a60cf93125cdceac77cc7f8644a61c03dddc610dc8f6748c589` has identical before/after guard identities. Historical JUnit contains 110 cases, no failure/skip, with 13 per-file name inventories totaling 110; log/JUnit hashes match the frozen receipt. I inspected these results, not reran the historical tests.
- Current complete unit TAP hash `7aae404aefefc259fd695411ea2847fb4d141ec1d37ad9437caeb2e18bc36503`: 496 reported, 488 pass, eight failures, zero cancelled/skipped/todo. Seven file wrappers fail module load through bindCorpus/loadContext with CORPUS_IDENTITY_MISMATCH: cli(6 blocked), liability(27), operator(4), receipt(5), repair(13), replay(5), session(11). TAP ids are 12,13,14,16,17,18,19. Registered TAP 76 is the unchanged PTY test; its direct CLI probe separately shows the same identity exception (`ac790dfb31569394d5fc1cbd9c0af8bbb8c9e2a740d19ed21622dc05cde35392`). Its pipeline timeout is not misreported as a passing current test.
- Reconciliation is 38 current executed passes + one identity-caused executed failure + 71 blocked/unregistered logical tests = 110 historical passes; seven failed wrappers are separate runner artifacts. The unchanged per-file hashes/names and logged source/build/overlay tamper controls support that qualification. Current unit is **qualified nonzero**, never unqualified green. Current RC5 compatibility remains PENDING/NOT_ADMITTED.

## Checks inspected versus run

**Run by this reviewer:** manifest/ZIP/current-build/baseline/archive/view hash checks, both read-only guard calls, and pure in-memory/no-DB reproductions A–C. No acceptance suite, PG mutation or build was run by this reviewer.

**Frozen logged evidence inspected/hash-verified:** current typecheck and API build exit 0; 27 RS-A unit cases; current focused RS-A PG 26/26, no skip/cancel, including unmodified native O→C→S→E production chain. Native log records PostgreSQL 17.11, descriptor SHA `13de87997355e8ef5e89f35b982f48494157502eecfd15286b53bde4487969ff`, owner/runtime/reader super=false and bypassRls=false, exact postmaster start equality, and APPLIED/NO-OP closures. Timing is Docker PTY regression only: IDENTITY p50/max 5.7/8.6 ms; PAUSE_EXPORT 159.6/289.6 ms. These do not cover R1's stalled prerequisites.

Prior revision full PG 712/712 and UI 86, plus UI typecheck/Prisma generation/schema/drift/PG17 checks, are recorded **before** the bounded contract repair; they were not rerun in full on the current revision. The affected 26 PG tests/current unfiltered unit/typecheck/build reruns are reasonable regression selection for that repair, but not proof of omitted mandatory controls. Clean-copy rebuild log reproduces 202 dist JS outputs and helper SHA `9624a353768cfd528538c4c965ad462295da4f8124a17c6d9bc0118248a983c1`; mutation log shows the restored start tolerance is detected by two tests. I checked those logs/hashes without rebuilding.

## Residuals and gate limits

`loadedBinding:'UNVERIFIED'`, declared-set image digests, helper TOCTOU, Unix endpoint swaps between checks, same-UID/kernel trust and JS password-string residency are explicitly retained qualifications, not fabricated failures of full RS-D proof. Native fixture evidence is not MEASURED/live evidence. `verifiedPass`/`liveAcceptanceEligible` remain false. RS-B/C/D, policy activation, paid inference, human attestation, data/budget/customer/account/deployment admissions remain separate. Reported paid product calls: 0; reviewer made none. Any repaired source/build/evidence identity requires renewed review of that exact artifact.

## Appendix A — pure controller deadline reproduction

Run from the checkout with Node v25.8.1. No files, children or DB are created. The never-completing connect dependency represents the unbounded physical query inside the production connector.

```sh
node --input-type=module - <<'JS'
import { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createController } from './packages/reval/controller.ts';
import { encodeFrame, METADATA_FRAME_CAP } from './packages/reval/frame.ts';
import { buildRequest } from './packages/reval/envelope.ts';
const config={registrationId:randomUUID(),databaseInstanceId:randomUUID(),admissionId:randomUUID(),nativePeerHelper:'/fixed/helper',nativePeerHelperSha256:'a'.repeat(64),secretFiles:{reader:'/reader',owner:'/owner',runtime:'/runtime'},server:{mode:'NONE'},physical:{}};
const binding={registrationId:config.registrationId,serverBootId:randomUUID(),connectionId:randomUUID()};
let writes=0,connects=0;
const socket=new Duplex({read(){},write(b,e,cb){writes++;cb();}});
const deps={platform:'darwin',arch:'arm64',nodeRealpath:'/fixed/node',env:{ATLAS_REVAL_CONFIG:'/fixed/config',ATLAS_REVAL_CONNECTION_ID:binding.connectionId,ATLAS_REVAL_SERVER_BOOT_ID:binding.serverBootId},now:()=>performance.now(),wallIso:()=>new Date().toISOString(),ppid:()=>process.ppid,ttyAvailable:()=>false,loadConfig:async()=>config,verifyHelper:async()=>{},warmHelper:async()=>{},peer:async()=>({pid:process.ppid,pidversion:1,euid:process.geteuid(),hasTty:true,exeMatch:true}),digests:async()=>({buildManifestSha256:'a'.repeat(64)}),readSecret:async()=>Buffer.from('reader-only-password'),connectReader:async()=>{connects++;return new Promise(()=>{});},ownerSocket:()=>socket,exit:c=>{throw Error('exit '+c)}};
createController(deps).run().catch(e=>console.log(e.message));
setImmediate(()=>socket.push(encodeFrame(buildRequest(binding,randomUUID(),'1','SNAPSHOT',{}),METADATA_FRAME_CAP)));
setTimeout(()=>{console.log(JSON.stringify({elapsedMs:2200,connects,responseFrames:writes,expected:'response by 1800ms'}));process.exit(0)},2200);
JS
```

Observed: `{"elapsedMs":2200,"connects":1,"responseFrames":0,"expected":"response by 1800ms"}`.

## Appendix B — duplicate private S/E frames

Run from the checkout. This uses real inherited socketpairs and production libraries with synthetic spy connectors; no password file or DB is opened.

```sh
node --input-type=module - <<'JS'
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {encodeFrame,FrameDecoder,parseFrameBody,PRIVATE_FRAME_CAP} from './packages/reval/frame.ts';
for (const kind of ['S','E']) {
  const code=kind==='S'
    ? `import {RevalBridge} from './apps/api/src/reval/bridge.ts';await RevalBridge.start(process.env,{readSecret:async()=>{console.log('READ_SECRET_CALLED');return Buffer.from('synthetic-only-password');},verify:async()=>{console.log('DB_VERIFY_CALLED');return {client:{end:async()=>{}},observed:{}};},runtimeUrl:()=>''});console.log('BRIDGE_START_RETURNED');process.exit(0);`
    : `import {runExecutorProcess} from './packages/reval/owner-exec.ts';await runExecutorProcess({readSecret:async()=>{console.log('OWNER_SECRET_READ');return Buffer.from('synthetic-only-password');},connect:async()=>{console.log('OWNER_CONNECT_CALLED');return new Promise(()=>{});}});`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{cwd:process.cwd(),stdio:['ignore','pipe','pipe','pipe'],env:kind==='S'?{ATLAS_MODE:'db',ATLAS_REVAL_BRIDGE_FD:'3'}:{}});
  let out='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>out+=b);
  const dec=new FrameDecoder(PRIVATE_FRAME_CAP);
  child.stdio[3].on('data',b=>{for(const body of dec.push(b)) {
    const hello=parseFrameBody(body);if(hello.contractVersion!=='RevalChildHelloV1')continue;
    const common={registrationId:randomUUID(),databaseInstanceId:randomUUID(),endpoint:{socketDir:'/unused',port:5432,database:'atlas'},physical:{systemIdentifier:'1',databaseOid:'1',postmasterStartTime:'1',postmasterPid:'1',dataDirectory:'/unused',socketDevice:'1',socketInode:'1'}};
    const request=kind==='S'
      ? {...common,contractVersion:'RevalServerLaunchV1',serverBootId:randomUUID(),connectionId:randomUUID(),launchChallenge:randomUUID(),runtimeRole:'atlas_runtime',runtimeSecretFile:'/unused/runtime'}
      : {...common,contractVersion:'RevalOwnerExecRequestV1',helloNonce:hello.helloNonce,challenge:randomUUID(),remainingMs:500,workspaceId:'workspace',clientId:'client',actorId:'actor',admissionId:randomUUID(),expectedPolicyVersion:'1',ownerRole:'atlas_owner',ownerSecretFile:'/unused/owner'};
    const frame=encodeFrame(request,PRIVATE_FRAME_CAP);child.stdio[3].write(Buffer.concat([frame,frame]));
  }});
  child.stdio[3].on('error',()=>{});
  await new Promise(resolve=>child.on('close',exitCode=>{console.log(JSON.stringify({kind,exitCode,output:out.trim()}));resolve();}));
}
JS
```

Observed independently as individual probes: S exit 0 with both credential/verification spy messages and `BRIDGE_START_RETURNED`; E exit 20 with `OWNER_SECRET_READ` and `OWNER_CONNECT_CALLED`. Neither must reach those spies for a coalesced duplicate private request.

## Appendix C — production-wrapper authentication mapping

```sh
node --input-type=module - <<'JS'
import {randomUUID} from 'node:crypto';
import {verifyPhysicalEndpoint} from './packages/reval/physical.ts';
import {runOwnerExec} from './packages/reval/owner-exec.ts';
const r={challenge:randomUUID(),ownerSecretFile:'/unused/owner',endpoint:{socketDir:'/unused/socket',port:5432,database:'atlas'},physical:{systemIdentifier:'1',databaseOid:'1',postmasterStartTime:'1',postmasterPid:'1',dataDirectory:'/unused/data',socketDevice:'1',socketInode:'1'},ownerRole:'atlas_owner'};
const pd={realpath:async p=>p,lstat:async p=>({isDirectory:()=>!p.includes('.s.PGSQL'),isSymbolicLink:()=>false,isSocket:()=>p.includes('.s.PGSQL'),mode:0o700,dev:1,ino:1}),readFile:async()=>`1\n/unused/data\n1\n5432\n/unused/socket\n`,isPidLive:()=>true,connect:async()=>{throw Object.assign(Error('synthetic auth refusal'),{code:'28P01',severity:'FATAL'});}};
const got=await runOwnerExec(r,performance.now()+1000,{now:()=>performance.now(),readSecret:async()=>Buffer.from('synthetic-only-password'),connect:async(req,pw,ms)=>(await verifyPhysicalEndpoint({endpoint:req.endpoint,physical:req.physical,role:req.ownerRole,applicationName:'atlas-reval-e-owner',connectTimeoutMs:ms},pw,pd)).client});
console.log(JSON.stringify({outcome:got.outcome,code:got.code,expected:'OWNER_REQUIRED'}));
JS
```

Observed: `{"outcome":"REFUSED","code":"REGISTRATION_MISMATCH","expected":"OWNER_REQUIRED"}`.
