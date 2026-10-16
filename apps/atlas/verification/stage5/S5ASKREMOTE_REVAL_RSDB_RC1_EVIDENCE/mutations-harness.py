# RS-D-B mutation check: each mutation is one exact replacement; the named test must FAIL with it; the file is restored after each.
import hashlib, os, subprocess, sys
ROOT = '/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1'
NODE = ['node', '--experimental-strip-types', '--no-warnings', '--test']
U = lambda *t: NODE + list(t)
M = [
 ('B01 profile: IP egress deny dropped', 'packages/reval/platform.ts', "['(version 1)', '(allow default)', '(deny network-outbound (remote ip))', ", "['(version 1)', '(allow default)', ", U('tests/reval-platform.test.ts')),
 ('B02 profile: resolver deny dropped', 'packages/reval/platform.ts', "    `(deny network-outbound (literal \"${RESOLVER_SOCKET}\"))`, '(deny process-exec)',", "    '(deny process-exec)',", U('tests/reval-platform.test.ts')),
 ('B03 profile: exec unrestricted', 'packages/reval/platform.ts', ", '(deny process-exec)',\n", ",\n", U('tests/reval-platform.test.ts')),
 ('B04 profile: path not validated', 'packages/reval/platform.ts', "if (!SAFE_PATH.test(p) || p.includes('//')", "if (p.includes('//')", U('tests/reval-platform.test.ts')),
 ('B05 enforced: resolver deny ignored', 'packages/reval/platform.ts', "f.sandboxed && f.resolverDenied;", "f.sandboxed;", U('tests/reval-platform.test.ts')),
 ('B06 enforced: pid ignored', 'packages/reval/platform.ts', "f.pid === pid && f.sandboxed", "f.sandboxed", U('tests/reval-platform.test.ts')),
 ('B07 helper: resolver check = any sandbox', 'native/reval-peer/peer.c', 'sandbox_check(pid, "network-outbound", 1, RESOLVER_SOCKET)', '(RESOLVER_SOCKET[0] ? any : 0)', U('tests/reval-platform.test.ts')),
 ('B07b helper: another socket checked', 'native/reval-peer/peer.c', 'RESOLVER_SOCKET[] = "/private/var/run/mDNSResponder";', 'RESOLVER_SOCKET[] = "/private/var/run/syslog";', U('tests/reval-platform.test.ts')),
 ('B08 helper: error answer reported as false', 'native/reval-peer/peer.c', "  if ((any != 0 && any != 1) || (resolver_denied != 0 && resolver_denied != 1)) return 72;\n", "  any = any == 1; resolver_denied = resolver_denied == 1;\n", U('tests/reval-platform.test.ts')),
 ('B09 launch: sandbox not required', 'packages/reval/server-link.ts', "    if (!sandboxEnforced(sandbox, pid) || channel.closed) return false;\n", "    if (channel.closed) return false;\n", NODE + ['--test-name-pattern=WITHOUT the pinned', 'tests/pg/reval-launch.pg.test.ts']),
 ('B10 production launcher unsandboxed', 'packages/reval/launch.ts', "  const { file, argv } = serverSandboxArgv(nodeRealpath, helperRealpath, entry, args);\n  return spawn(file, argv,", "  return spawn(nodeRealpath, [entry, ...args],", NODE + ['--test-name-pattern=real PTY', 'tests/pg/reval-launch.pg.test.ts']),
 ('B11 enforcedNow: no re-check', 'packages/reval/server-link.ts', "    return sandboxEnforced(f, pid) && this.state === 'READY';", "    return f !== null && this.state === 'READY';", U('tests/reval-platform.test.ts')),
 ('B12 enforcedNow: exited S still enforced', 'packages/reval/server-link.ts', " || pid !== this.child?.pid || this.child.exitCode !== null) return false;", " || this.child === null) return false;", U('tests/reval-platform.test.ts')),
 ('B13 drain: inventory ignored', 'packages/reval/eval-drain.ts', " || inventory !== 'COMPLETE'", "", U('tests/reval-census.test.ts')),
 ('B14 drain: failed inventory read COMPLETE', 'packages/reval/eval-drain.ts', ".catch(() => 'INCOMPLETE' as const);", ".catch(() => 'COMPLETE' as const);", U('tests/reval-census.test.ts')),
 ('B15 controller: inventory without S enforcement', 'packages/reval/controller.ts', "    if (!s || !await bounded(s.enforcedNow(), abs(until)).catch(() => false)) return 'INCOMPLETE';\n", "    if (!s) return 'INCOMPLETE';\n", NODE + ['--test-name-pattern=WITHOUT the pinned', 'tests/pg/reval-launch.pg.test.ts']),
 ('B16 dbInventory: application_name ignored', 'packages/reval/platform.ts', "(a.usename = $1 AND a.application_name = $2) OR (a.usename = $3 AND a.application_name = $4)", "(a.usename = $1 AND $2::text IS NOT NULL) OR (a.usename = $3 AND $4::text IS NOT NULL)", NODE + ['--test-name-pattern=RS-D-B DRAIN process inventory', 'tests/pg/reval-census.pg.test.ts']),
 ('B17 dbInventory: any registered role under any name', 'packages/reval/platform.ts', "(a.usename = $1 AND a.application_name = $2) OR (a.usename = $3 AND a.application_name = $4)", "(a.application_name = $2 OR a.application_name = $4)", NODE + ['--test-name-pattern=RS-D-B DRAIN process inventory', 'tests/pg/reval-census.pg.test.ts']),
 ('B18 rule: policy ref not required', 'packages/reval/proof-payloads.ts', " && p.policyEvidenceRef === SERVER_POLICY_REF;", ";", U('tests/reval-proofs.test.ts')),
 ('B19 rule: unmeasured processes ignored', 'packages/reval/proof-payloads.ts', " && p.unmeasuredProcessCount === '0'", "", U('tests/reval-proofs.test.ts')),
 ('B20 platform decoder: verified zero not enforced', 'packages/reval/proof-payloads.ts', "  if (p.countsAsVerifiedZero !== platformVerifiedZero(p)) shapeFail();\n", "", U('tests/reval-proofs.test.ts')),
 ('B21 privacy decoder: verified zero not enforced', 'packages/reval/proof-payloads.ts', "  if (p.countsAsVerifiedZero !== privacyVerifiedZero(p)) shapeFail();\n", "", U('tests/reval-proofs.test.ts')),
 ('B22 privacy rule: external evidence not required', 'packages/reval/proof-payloads.ts', "\n    && p.externalRetentionEvidenceRef !== null;", ";", U('tests/reval-proofs.test.ts')),
 ('B23 privacy rule: unreadable ignored', 'packages/reval/proof-payloads.ts', " && p.unreadableDestinationCount === '0'", "", U('tests/reval-proofs.test.ts')),
 ('B24 compose platform: COMPLETE without enforcement', 'packages/reval/platform.ts', "processCoverage: o.enforced ? 'COMPLETE' : 'UNKNOWN'", "processCoverage: 'COMPLETE'", U('tests/reval-proofs.test.ts')),
 ('B25 compose platform: unenforced components hidden', 'packages/reval/platform.ts', "unmeasuredProcessCount: String(UNENFORCED_COMPONENTS.length)", "unmeasuredProcessCount: '0'", U('tests/reval-proofs.test.ts')),
 ('B26 scanner: canaries not matched', 'packages/reval/privacy-scan.ts', "      for (const needle of canaries.needles) if (text.includes(needle)) counts.forbidden += 1;\n", "", U('tests/reval-proofs.test.ts')),
 ('B27 scanner: unknown file classified', 'packages/reval/privacy-scan.ts', "      if (!known.has(rel)) counts.newUnclassified += 1;\n", "", U('tests/reval-proofs.test.ts')),
 ('B28 scanner: journal lines unchecked', 'packages/reval/privacy-scan.ts', "if (rel === 'reval-journal.jsonl') for", "if (false) for", U('tests/reval-proofs.test.ts')),
 ('B29 compose privacy: outside destinations not counted', 'packages/reval/privacy-scan.ts', "OUTSIDE_INSPECTION.length + (o.logging", "0 + (o.logging", U('tests/reval-proofs.test.ts')),
 ('B30 PG logging: statement logging accepted', 'packages/reval/privacy-scan.ts', "(s.log_statement === 'none' || s.log_statement === 'ddl')", "true", U('tests/reval-proofs.test.ts')),
 ('B31 canaries: dataset digest unchecked', 'packages/reval/privacy-scan.ts', "  if (sha(manifestBytes) !== DATASET_MANIFEST_SHA256) throw new Error('CANARY_MANIFEST');\n", "", U('tests/reval-proofs.test.ts')),
 ('B32 canaries: case digest unchecked', 'packages/reval/privacy-scan.ts', "    if (sha(bytes) !== f.sha256) throw new Error('CANARY_CASES');\n", "", U('tests/reval-proofs.test.ts')),
 ('B33 canaries: escaped form dropped', 'packages/reval/privacy-scan.ts', "set.add(t); set.add(JSON.stringify(t).slice(1, -1));", "set.add(t);", U('tests/reval-proofs.test.ts')),
 ('B34 ProofLink: unverified S proved', 'packages/reval/eval-proofs.ts', "    if (!s || !s.verifiedAt || build === null) return fail('PLATFORM_UNVERIFIED');", "    if (build === null) return fail('PLATFORM_UNVERIFIED');", U('tests/reval-proofs.test.ts')),
 ('B35 ProofLink: enforcement not re-checked', 'packages/reval/eval-proofs.ts', "const enforced = await s.enforcedNow();", "const enforced = true;", U('tests/reval-proofs.test.ts')),
 ('B36 run: proofs during a case', 'scripts/reval-instrument/run.ts', "    if (this.#current !== null) return 'BLOCKED_CASE_IN_FLIGHT';\n    if (this.proofs.length", "    if (this.proofs.length", U('tests/reval-instrument-run.test.ts')),
 ('B37 run: privacy failure not reported', 'scripts/reval-instrument/run.ts', "      if (b.kind !== 'PRIVACY_PROOF') return `PROOF_FAILED_${(b.payload as { code: string }).code}`;\n", "", U('tests/reval-instrument-run.test.ts')),
 ('B38 receipt: proofs not decoded', 'scripts/reval-instrument/receipt.ts', "      try { decodePlatformProof(e.platform); decodePrivacyProof(e.privacy); } catch { return false; }\n", "", U('tests/reval-instrument-run.test.ts')),
 ('B39 receipt: unknown case accepted', 'scripts/reval-instrument/receipt.ts', "['afterCaseId', 'platform', 'privacy']) || !(e.afterCaseId === null || cases.some(x => x.caseId === e.afterCaseId))", "['afterCaseId', 'platform', 'privacy'])", U('tests/reval-instrument-run.test.ts')),
 ('B40 ipc: PLATFORM_PROOF kind unknown', 'scripts/reval-instrument/ipc.ts', " DRAIN: 'DRAIN', PLATFORM_PROOF: 'PLATFORM_PROOF',", " DRAIN: 'DRAIN',", U('tests/reval-instrument-census.test.ts')),
 ('B41 controller: I privacy answered as platform', 'packages/reval/eval-controller.ts', "        case 'PRIVACY_PROOF': return this.#h.proofs.privacy(until - 40);", "        case 'PRIVACY_PROOF': return this.#h.proofs.platform();", NODE + ['--test-name-pattern=D1/D2', 'tests/pg/reval-segments.pg.test.ts']),
]
env = dict(os.environ)
for line in open(f'{ROOT}/.env'):
    line = line.strip()
    if line and not line.startswith('#') and '=' in line: k, v = line.split('=', 1); env[k] = v.strip().strip('"').strip("'")
only = sys.argv[1:]
res = []
for (name, path, old, new, cmd) in M:
    if only and not any(name.startswith(o) for o in only): continue
    full = f'{ROOT}/{path}'; orig = open(full, 'rb').read(); text = orig.decode()
    if text.count(old) != 1: res.append(f'{name}: PATTERN_NOT_UNIQUE ({text.count(old)})'); continue
    try:
        open(full, 'w').write(text.replace(old, new, 1))
        p = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True, timeout=900)
        res.append(f"{name}: {'DETECTED' if p.returncode != 0 else 'SURVIVED'} ({' '.join(cmd[4:])})")
    finally:
        open(full, 'wb').write(orig)
    assert hashlib.sha256(open(full, 'rb').read()).hexdigest() == hashlib.sha256(orig).hexdigest()
    print(res[-1], flush=True)
print('SUMMARY', sum('DETECTED' in r for r in res), '/', len(res))
