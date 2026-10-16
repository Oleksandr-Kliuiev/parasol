# RS-D-C mutation check: each mutation is one exact replacement; the named test must FAIL with it; the file is restored after each.
import hashlib, os, subprocess, sys
ROOT = '/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1'
NODE = ['node', '--experimental-strip-types', '--no-warnings', '--test']
U = lambda *t: NODE + list(t)
M = [
 ('D01 identity: RS-D-B files not expected', 'scripts/reval-instrument/identity.ts', "  if (rsdb) { put([...entries(rsdb.changed), ...entries(rsdb.added)], 'RSDB_FILES'); deltas(rsdbSeal); }\n", '', U('tests/reval-instrument-identity.test.ts')),
 ('D02 inventory: outputs not pinned', 'scripts/reval-instrument/identity.ts', "    if (want === undefined || fileSha(path) !== want) flag('BUILD_DRIFT');", "    if (want === undefined) flag('BUILD_DRIFT');", U('tests/reval-instrument-identity.test.ts')),
 ('D03 inventory: set equality unchecked', 'scripts/reval-instrument/identity.ts', ' || inventory.size !== rebuiltSet.size || [...rebuiltSet].some(p => !inventory.has(p))', '', U('tests/reval-instrument-identity.test.ts')),
 ('D04 inventory: order/duplicates unchecked', 'scripts/reval-instrument/identity.ts', '    if (paths.some((p, i) => i > 0 && paths[i - 1]! >= p)) return null; // sorted, unique\n', '', U('tests/reval-instrument-identity.test.ts')),
 ('D05 inventory: closed schema unchecked', 'scripts/reval-instrument/identity.ts', "Object.keys(o).sort().join(',') !== 'contractVersion,outputs' || ", '', U('tests/reval-instrument-identity.test.ts')),
 ('D06 inventory: candidate outputs kept', 'scripts/reval-instrument/identity.ts', '  return [...set].filter(p => !candidate.has(p)).sort();', '  return [...set].sort();', U('tests/reval-instrument-identity.test.ts')),
 ('D07 identity: RS-D-B seal status unchecked', 'scripts/reval-instrument/identity.ts', ", [rsdbSeal, ANCHORS.rsdbManifest, 'rsdbSeal']] as const) {", '] as const) {', U('tests/reval-instrument-identity.test.ts')),
 ('D08 run: expired-uncollected not distinguished', 'scripts/reval-instrument/run.ts', "      return stopped('TERMINAL_EXPIRED_UNCOLLECTED');", "      return stopped('CENSUS_CHANGED_UNEXPECTEDLY');", U('tests/reval-instrument-run.test.ts')),
 ('D09 run: expired-uncollected check dropped', 'scripts/reval-instrument/run.ts', '    if (BigInt(preCensus.uncollectedTerminalCount) > (this.#lastPost === null ? 0n : BigInt(this.#lastPost.uncollectedTerminalCount))) {', '    if (false) {', U('tests/reval-instrument-run.test.ts')),
 ('D10 run: another build accepted', 'scripts/reval-instrument/run.ts', '    if (build !== this.build.buildManifestSha256) {', '    if (false) {', U('tests/reval-instrument-run.test.ts')),
 ('D11 run: no IDENTITY before GO', 'scripts/reval-instrument/run.ts', "    // RS-D-C: the run's build (C's IDENTITY) — before anything is consumed.\n    const bound = await this.#bindBuild(); if (bound !== null) return bound;\n", '', U('tests/reval-instrument-run.test.ts')),
 ('D12 run: proof of another build accepted', 'scripts/reval-instrument/run.ts', '\n      || platform.buildManifestSha256 !== this.build!.buildManifestSha256', '', U('tests/reval-instrument-run.test.ts')),
 ('D13 receipt: proof build unchecked', 'scripts/reval-instrument/receipt.ts', '      if (pl.buildManifestSha256 !== (r.build as { buildManifestSha256: string }).buildManifestSha256) return false;\n', '', U('tests/reval-instrument-run.test.ts')),
 ('D14 receipt: proofs without build', 'scripts/reval-instrument/receipt.ts', ' || (r.proofs.length > 0 && r.build === null)', '', U('tests/reval-instrument-run.test.ts')),
 ('D15 receipt: expired-uncollected not in effective', 'scripts/reval-instrument/receipt.ts', " || run.armStop === 'TERMINAL_EXPIRED_UNCOLLECTED'\n", '\n', U('tests/reval-instrument-run.test.ts')),
 ('D16 receipt: build-change not in effective', 'scripts/reval-instrument/receipt.ts', "        || run.armStop === 'BUILD_CHANGED' || ms.some(", '        || ms.some(', U('tests/reval-instrument-run.test.ts')),
 ('D17 profile: PG socket directory instead of the exact file', 'packages/reval/platform.ts', '(remote unix-socket (path-literal "${safe(p.pgSocket)}"))', '(remote unix-socket (subpath "${safe(dirname(p.pgSocket))}"))', U('tests/reval-platform.test.ts')),
 ("D18 sandbox paths: C's journal/instrument socket writable", 'packages/reval/platform.ts', ', ...C_OWNED.map(n => join(dir, n))] };', '] };', U('tests/reval-platform.test.ts')),
 ('D19 sandbox paths: config file writable', 'packages/reval/platform.ts', 'real(f.runtime), real(configPath), ', 'real(f.runtime), ', U('tests/reval-platform.test.ts')),
 ('D20 console refusal: no security headers', 'apps/api/src/reval/evaluation.ts', '      for (const [name, value] of Object.entries(OPERATOR_HEADERS)) res.setHeader(name, value);\n', '', ['/bin/sh', '-c', 'set -a; . ./.env; set +a; npm run api:build >/dev/null 2>&1 && exec node --experimental-strip-types --no-warnings --test --test-name-pattern=N1: tests/pg/reval-eval-console.pg.test.ts', 'S-dist-rebuilt']),
 ('D21 console refusal: Host not checked', 'apps/api/src/reval/evaluation.ts', '      if (hosts !== 1 || req.headers.host !== `127.0.0.1:${o.port}`) {', '      if (false) {', ['/bin/sh', '-c', 'set -a; . ./.env; set +a; npm run api:build >/dev/null 2>&1 && exec node --experimental-strip-types --no-warnings --test --test-name-pattern=N1: tests/pg/reval-eval-console.pg.test.ts', 'S-dist-rebuilt']),
 ('D22 console refusal: duplicated Host accepted', 'apps/api/src/reval/evaluation.ts', '      if (hosts !== 1 || req.headers.host', '      if (req.headers.host', ['/bin/sh', '-c', 'set -a; . ./.env; set +a; npm run api:build >/dev/null 2>&1 && exec node --experimental-strip-types --no-warnings --test --test-name-pattern=N1: tests/pg/reval-eval-console.pg.test.ts', 'S-dist-rebuilt']),
 ('D23 durableWrite: no directory fsync', 'scripts/reval-instrument/receipt.ts', '    try { fsyncSync(dfd); } finally { closeSync(dfd); }\n  } catch (e) {', '    closeSync(dfd);\n  } catch (e) {', U('tests/reval-fsync.test.ts')),
 ('D24 logging: all-databases overrides missed', 'packages/reval/privacy-scan.ts', '        AND s.setdatabase IN (0, (SELECT d.oid', '        AND s.setdatabase IN ((SELECT d.oid', NODE + ['--test-name-pattern=RS-D-B DRAIN process inventory', 'tests/pg/reval-census.pg.test.ts']),
 ('D25 run: pair refresh not enforced', 'scripts/reval-instrument/run.ts', "    if (this.#pairedAtMono !== null && this.#d.mono() - this.#pairedAtMono > PAIR_REFRESH_MS) return 'BLOCKED_PAIR_REFRESH_REQUIRED';\n", '', U('tests/reval-instrument-run.test.ts')),
 ('D26 run: a new pair-id does not reset the pair time', 'scripts/reval-instrument/run.ts', 'set pairId(v: string | null) { this.#pairId = v; this.#pairedAtMono = v === null ? null : this.#d.mono(); }', 'set pairId(v: string | null) { this.#pairId = v; if (this.#pairedAtMono === null) this.#pairedAtMono = this.#d.mono(); }', U('tests/reval-instrument-run.test.ts')),
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
