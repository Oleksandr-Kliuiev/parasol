# Independent RS-A CODE bounded re-review — RC2

**Verdict: CHANGES_REQUIRED**

Artifact: **S5ASKREMOTE-REVAL-RSA-rc2**  
Exact packageHash: **cd13f162c0eabc555bff18460820127aa3b7aeef82396be6e0739726e11817df**  
Reviewer: same independent Sol initial-code-review session; explicitly requested gpt-6.1-sol / xhigh, kept for this bounded review. Effective native execution metadata is verified externally by root. No other code reviewer's report/verdict, author conversation, delegation or model launch used.

## Required findings

### RC2-F1 [P1] Keep private-channel violations effective throughout the pending reread (original R2 remains partially open)

Location: `packages/reval/pause.ts:73–83` (particularly the one-time check at line 75 and the await at line 79); `tests/reval-handshake.test.ts:101–105`.

After receiving a valid E result, C checks `channel.violated()` once, then awaits its reread. If E sends a duplicate/unsolicited result, a partial extra frame, or malformed traffic **during that await**, the strict channel closes, but C never checks the violation again. A valid reread therefore produces CLOSURE and leaves the session unlatched. This contradicts brief §2e's duplicate-frame abort and the repaired post-request uncertainty rule. The new test sends both result frames in one write and misses this interval.

Independently executed Appendix A, using actual production pauseExport/Channel and a real child socketpair, with no DB or secret file access:
```json
{"decision":{"kind":"CLOSURE","closure":{"admissionId":"<uuid>","paused":true,"policyVersion":"2","fenceEpoch":"2"}},"latched":false,"requestSent":true,"rereadStarted":true,"childOut":"DUPLICATE_SENT\n"}
```
The child sent its first valid CONFIRMED_COMMIT, sent the duplicate 75 ms later, and the reread returned after 200 ms. The child was reaped.

Required repair: retain protocol-invalid state until the closure decision and check it after the reread, immediately before accepting closure. Treat oversize private traffic as a protocol violation too; `Channel.violated()` currently excludes FRAME_TOO_LARGE. Return CONTAINMENT_UNCONFIRMED, latch, and never spawn on later PAUSE_EXPORT. Preserve the valid single-result + normal E EOF/exit path: normal executor completion must not be mistaken for a protocol violation.

Required verification: deterministic gated reread tests with a duplicate full result, a fragmented/partial extra frame and oversize/malformed traffic delivered after the first result and before reread completion; expect no closure and a persistent latch. Include a valid single-result/normal-EOF control, O-side response/sequence validation, and a subsequent PAUSE_EXPORT proving spawn count unchanged. Retain coalesced and pre-request negatives.

### RC2-F2 [P2] Restore the approved 300 ms E connection cap (new deadline regression)

Location: `packages/reval/owner-exec.ts:62`, propagated to `packages/reval/physical.ts:97–99`.

RC1 used `min(300, deadline-now)`; RC2 changes it to 500. Brief §6, `IMPLEMENTATION_BRIEF.md:243–247`, still requires E's connect timeout to be `min(300, DE-now)`. The full physical budget is passed directly to pg as connectionTimeoutMillis, so this is an actual connection allowance increase, not merely additional time for filesystem checks. No approved contract change authorizes it.

Independently executed Appendix B through runOwnerExec and verifyPhysicalEndpoint:
```json
{"suppliedBudget":500,"actualConnectTimeout":499,"authOutcome":"REFUSED","authCode":"OWNER_REQUIRED"}
```
No connection, DB query, lock or filesystem access occurred. The overall controller guard is bounded, but it does not waive this fixed sub-deadline.

Required repair: keep E's actual pg connectionTimeoutMillis at most 300 ms and within the remaining absolute executor deadline. If physical checks need a separate encompassing budget, distinguish that from the connection cap rather than extending the approved connect timeout.

Required verification: a spy through the production physical wrapper asserting the actual connection option is ≤300 and ≤remaining time, including a short remaining budget and a stalled connection; retain OWNER_REQUIRED for 28P01/28000/42501 and REGISTRATION_MISMATCH for wrong physical tuples. Run focused deadline/auth tests, then the required final suite and clean rebuild on newly frozen bytes.

## Original findings and regression assessment

- **R1 core stall/EOF defect closed:** the absolute operation guard, bounded startup/reconnect/recheck and late-client disposal address the original reproduction. An independently executed in-memory owner/controller probe with connectReader never settling now received authenticated FAILURE DEADLINE, sequence 1, at **1768 ms**, with one connect, zero S spawns and controller exit 0 after EOF. The new unit, real-backend launch and native lock-stall tests cover cancellation and late completion. RC2-F2 is the remaining new sub-deadline regression.
- **R2 partly closed:** strict private channels now reject coalesced/fragmented duplicates and unsolicited frames synchronously. Endpoint spy tests establish zero secret reads/connects for the initial duplicate cases and no connect if a duplicate arrives during a legitimate pending secret read. Controller-side pre-request negatives and coalesced result uncertainty are covered. RC2-F1 prevents closure.
- **R3 closed:** PhysicalAuthError retains only SQLSTATE; E maps 28P01/28000/42501 to OWNER_REQUIRED, while wrong physical binding remains REGISTRATION_MISMATCH. Wrapper unit controls, Docker wrong-password and native production wrong-password evidence cover the real path. Appendix B independently confirms 28P01 classification without disclosing error text.
- **R4 closed:** isolated tests now cover correct reader/S on another ready DB, forged Bound.observed, E on a distinct database containing copied logical IDs, foreign actor/admission/client references, missing client admission, existing-registration dataset mismatch, binding registration/workspace immutability, owner guard/monotonicity under replica, and already-PAUSED NO-OP with nonzero microseconds. The added ALWAYS INSERT reference checks close the replica FK gap while preserving the original scoped FKs. Positive controls make these refusals meaningful.
- Snapshot envelope sizing is now checked before send and on reread; sequence fallback reuses the same sequence. The cap/continuity controls are meaningful. Whole-row fingerprints, SQL-only preserved policy values, fence-first locking, exact committed-tuple reread and strict floors remain intact.

## Identity, scope and verification checked

Read-only checks performed before and after this review:

- All **492** manifest entries match current bytes; compact sorted JSON recomputes the exact packageHash above. Both checkout and durable RC2 ZIP contain exactly those 492 entries, without extras, missing or duplicate entries; every ZIP member matches. ZIP SHA256 **1f2c17872db17f1f7ff6d929284b2b27ff1d5755fe9eb0d61f65edf00bf6d89e**.
- All **204** build-inventory entries match current bytes and inventoryHash **f7eb7bd967e66351c31d7a23adb4db9b56cab4db55ae70b6489de39c7bef8b9d**. loadedBinding remains UNVERIFIED.
- RC2 lineage's baseline-current inventory matches; the **14** declared old-source changes are unchanged from my initial review. The **120** frozen RC5 files remain byte-exact. Architecture RC4, brief RC4, acceptance checks and addendum hashes remain unchanged: architecture **9fa16222d6c32c18d4d193b6666e078fd3624a4bdb2ccb8ab9fbd68113b08163**, brief package **e8f87336b1cf7e0ba7b18702378f3a6efb877b20e5d9aa4e9a96ee175bf85040**, addendum **59c2fd7f82020d62cbbdd070494b62fcb5cdae719e0568c98ab8d34492dc99dc**.
- Root's focused-module/test-support classifications fit existing RS-A implementation scope and the cohesive-module rule. They add no public behavior, authority or admission. They do not authorize RC2-F2's altered timeout.
- **final5**, not final3/final4, is the current evidence. Every finalSuite step log matches its recorded SHA; steps.tsv hash **7aae85d2708689e7d521a98d2de18f5b733b89104fb319eac02d7cd2c386de61**. It records successful typechecks, Prisma generation/validation, DB drift/PG17 and API build; **725/725 PG**, zero failed/cancelled/skipped/todo; **86 UI passed**. The native fixture actually ran on PG17.11 with NOSUPERUSER/NOBYPASSRLS roles, exact start equality, APPLIED and NO-OP closures, OWNER_REQUIRED x2 and cancelled physical lock stall.
- Current unfiltered unit result is **506 runner tests, 498 pass, 8 fail, 0 skipped/cancelled/todo**, exit 1. Unit-paired log SHA **a60e4c500c3962a48295ab3a2ce1b294262e41b962451d7972f4a8647167b7cd**. Seven module-load wrappers directly show CORPUS_IDENTITY_MISMATCH; TAP76 remains the registered opaque PTY timeout. The same-log companion uses the exact child argv under a real PTY and directly shows CORPUS_IDENTITY_MISMATCH, exit 1, zero receipts. Before/after source, build, RC5 and guard identities match (apart from labels). The frozen operator executes loadContext before its first prompt, consistent with the timeout at step 1. Under root's explicitly supplied verification-only causal-record decision, this is sufficient to attribute that failure; it is **indirect**, not original-test self-diagnosis or a passing test.
- RC5 reconciliation retains **38 executed logical passes + 1 executed logical failure + 71 blocked unregistered = 110 historical logical tests**, plus seven failed wrappers. Per-file inventories/counts are retained; blocked tests are never called current passes. Current guard independently returns only RC_SOURCE_DRIFT/RC_BUILD_DRIFT. Tamper source/build/overlay checks are present and passed in final5; the unrelated source and build negatives are isolated.
- The historical view independently verifies **1252 source / 244 build / 120 RC5** entries, with exactly six approved pinned admin overlays and only the dependency node_modules symlink. Its unchanged guard independently returns ok true/drift empty. Durable overlay/build ZIP hashes remain exactly **2fade6636c430fd1919e6113f249db4f2a2ba6a34affedcbae4d87b542bc7619** / **b2dc34c4b3a17aca90071d8ba847015e6d2bb647ab199cdceb241c7a55b8d001**. Historical receipt SHA **d90892a801800a60cf93125cdceac77cc7f8644a61c03dddc610dc8f6748c589** and retained log/XML hashes match; XML contains **110 passes**, no failures/skips. Historical tests were not rerun for RC2.
- final5 clean-copy reproducibility log SHA **ce62b0d77f3080fe07e5fdb3811c57dbb4b7afdb43f6fe5a3f98115c898e5647** records 203 current production JS outputs byte-identical and native helper SHA **9624a353768cfd528538c4c965ad462295da4f8124a17c6d9bc0118248a983c1** equal in checkout/rebuild/copy; operator assets unchanged. This is inspected evidence, not a reviewer-run build.
- PTY harness now signals O with SIGHUP, waits for its descendant tree, reports forced survivors, and tests assert none; native negative sessions explicitly quit. Normal SIGHUP closes O's channel, exercising C's existing owner-EOF cleanup. Launch EOF controls assert C/S/backend termination. Final5 records no survivors, and a read-only current process scan found no production reval processes. Killing a terminal emulator without an actual hangup/owner EOF remains the disclosed residual; that does not waive the tested EOF obligation.
- final3 was superseded by four test-only teardown fixes; final4 was interrupted and is not counted complete. final5's before/after identities match. The disclosed root interruption/recovery does not substitute for final5 results or constitute a model-role approval.

**Not run by this reviewer:** builds, migrations, role provisioning, PG/native/UI/unit suites, mutation suites, historical tests, or any DB mutation. I inspected their frozen evidence and ran only read-only hash/lineage/guard checks plus no-DB pure/child-process probes. No repo mutation, product inference, paid call or activation occurred. Only this report was written.

Residuals: same-UID/kernel/helper trust and TOCTOU/socket races; JS password strings; backend teardown can await an external superuser shared-catalog lock; receive-time S phases without a launch-frame nonce; per-statement E timeout formula; loadedBinding UNVERIFIED pending RS-D; RC5 compatibility NOT_ADMITTED/PENDING; RS-B/C/D and data/budget/customer/deployment remain separate. None closes the two findings above.

## Appendix A — standalone delayed-duplicate reproduction

Run from the frozen checkout. It reads production modules, uses synthetic wrappers and one short-lived Node child, and reaps the child; no DB, helper, credential file or checkout write.

```sh
node --experimental-strip-types --no-warnings --input-type=module <<'JS'
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pauseExport, reapExecutor } from './packages/reval/pause.ts';
import { wrapperOf, PHYSICAL } from './tests/support/reval-controller-harness.ts';
const source = `const {Socket}=require('node:net');
const {randomUUID}=require('node:crypto');
const s=new Socket({fd:3,readable:true,writable:true});
s.on('error',()=>{}); let b=Buffer.alloc(0);
function enc(x){const v=Buffer.from(JSON.stringify(x));const h=Buffer.alloc(4);
h.writeUInt32BE(v.length);return Buffer.concat([h,v]);}
s.on('data',c=>{b=Buffer.concat([b,c]);
if(b.length>=4 && b.length>=4+b.readUInt32BE(0)){
const r=JSON.parse(b.subarray(4,4+b.readUInt32BE(0)));b=Buffer.alloc(0);
const out=enc({contractVersion:'RevalOwnerExecResultV1',challenge:r.challenge,
outcome:'CONFIRMED_COMMIT',revisionApplied:true,policyVersion:'2',fenceEpoch:'2',code:null});
s.write(out);setTimeout(()=>{s.write(out);process.stdout.write('DUPLICATE_SENT\\n');},75);
}});
s.write(enc({contractVersion:'RevalChildHelloV1',kind:'EXECUTOR',helloNonce:randomUUID()}));
setInterval(()=>{},1000);`;
let child; let childOut='';
const ids={reg:randomUUID(),inst:randomUUID(),adm:randomUUID(),boot:'',conn:''};
const config={registrationId:ids.reg,databaseInstanceId:ids.inst,workspaceId:'ws',
clientId:'cl',actorId:'ac',admissionId:ids.adm,nativePeerHelper:'/unused',
roles:{owner:'o'},secretFiles:{owner:'/unused'},
endpoint:{socketDir:'/unused',port:5432,database:'db'},physical:PHYSICAL};
const deps={now:()=>performance.now(),nodeRealpath:'/node',
spawnExecutor:()=>{child=spawn(process.execPath,['-e',source],
{stdio:['ignore','pipe','ignore','pipe']});
child.stdout.on('data',b=>childOut+=b);return child;},
peer:async()=>({pid:child.pid,pidversion:1,euid:process.geteuid(),
ppid:process.pid,startSec:1,startUsec:0,hasTty:false,exeMatch:true})};
let rereadStarted=false;
const ctx={deps,config,latched:false,spawns:0,lastChild:null,requestSent:false,
reread:async()=>{rereadStarted=true;await new Promise(r=>setTimeout(r,200));
const w=wrapperOf(ids,0);Object.assign(w.snapshot,
{policyState:'PAUSED',policyVersion:'2',fenceEpoch:'2'});return w;}};
try {const d=await pauseExport(ctx,{admissionId:ids.adm,expectedPolicyVersion:'1',
policyFloor:'1',fenceFloor:'1'},performance.now());
console.log(JSON.stringify({decision:d,latched:ctx.latched,
requestSent:ctx.requestSent,rereadStarted,childOut}));}
finally {console.log('reaped',await reapExecutor(child));}
JS
```

## Appendix B — standalone connection-cap/auth reproduction

All filesystem facts and the connector are synthetic spies. No file is read and no socket is opened.

```sh
node --experimental-strip-types --no-warnings --input-type=module <<'JS'
import { runOwnerExec } from './packages/reval/owner-exec.ts';
import { verifyPhysicalEndpoint } from './packages/reval/physical.ts';
const physical={systemIdentifier:'1',databaseOid:'2',postmasterStartTime:'3',
postmasterPid:'4',dataDirectory:'/d',socketDevice:'5',socketInode:'6'};
const endpoint={socketDir:'/s',port:5432,database:'db'};
let suppliedBudget;let options;
const deps={realpath:async p=>p,
lstat:async p=>({isDirectory:()=>!p.includes('.s.PGSQL'),
isSymbolicLink:()=>false,isSocket:()=>p.includes('.s.PGSQL'),mode:0o700,dev:5,ino:6}),
readFile:async()=>['4','/d','3','5432','/s',''].join('\n'),isPidLive:()=>true,
connect:async o=>{options=o;
throw Object.assign(new Error('private-error-text'),{code:'28P01',severity:'FATAL'});}};
const out=await runOwnerExec({challenge:'probe',ownerSecretFile:'/unused'},
performance.now()+1200,{now:()=>performance.now(),
readSecret:async()=>Buffer.from('Password1234567890'),
connect:async(_r,p,budgetMs)=>{suppliedBudget=budgetMs;
return (await verifyPhysicalEndpoint({endpoint,physical,role:'owner',
applicationName:'probe',budgetMs},p,deps)).client;}});
console.log(JSON.stringify({suppliedBudget,actualConnectTimeout:options.connectionTimeoutMillis,
authOutcome:out.outcome,authCode:out.code}));
JS
```
