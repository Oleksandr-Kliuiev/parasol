# RS-D-C (rc3) mutation check: each mutation is one exact replacement; the named test must FAIL with it; the file is restored after each.
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
 ('D11 run: no IDENTITY before GO', 'scripts/reval-instrument/run.ts', "    // RS-D-C: the run's build (C's IDENTITY) — before anything is consumed.\n    const bound = await this.#bindBuild(); if (bound !== null) return bound;\n", '', U('tests/reval-instrument-run.test.ts')),
 ('D12 run: proof of another build accepted', 'scripts/reval-instrument/run.ts', '\n      || platform.buildManifestSha256 !== this.build!.buildManifestSha256', '', U('tests/reval-instrument-run.test.ts')),
 ('D13 receipt: proof build unchecked', 'scripts/reval-instrument/receipt.ts', '      if (pl.buildManifestSha256 !== (r.build as { buildManifestSha256: string }).buildManifestSha256) return false;\n', '', U('tests/reval-instrument-run.test.ts')),
 ('D14 receipt: proofs without build', 'scripts/reval-instrument/receipt.ts', ' || (r.proofs.length > 0 && r.build === null)', '', U('tests/reval-instrument-run.test.ts')),
 ('D15 receipt: expired-uncollected not in effective', 'scripts/reval-instrument/receipt.ts', " || run.armStop === 'TERMINAL_EXPIRED_UNCOLLECTED'\n", '\n', U('tests/reval-instrument-run.test.ts')),
 ('D17 profile: PG socket directory instead of the exact file', 'packages/reval/platform.ts', '(remote unix-socket (path-literal "${safe(p.pgSocket)}"))', '(remote unix-socket (subpath "${safe(dirname(p.pgSocket))}"))', U('tests/reval-platform.test.ts')),
 ('D18 sandbox paths: C\'s journal/instrument socket writable (rc3 form)', 'packages/reval/platform.ts', ', ...C_OWNED.map(n => join(dir, n))];', '];', U('tests/reval-platform.test.ts')),
 ('D19 sandbox paths: config file writable', 'packages/reval/platform.ts', 'real(f.runtime), real(configPath), ', 'real(f.runtime), ', U('tests/reval-platform.test.ts')),
 ('D20 console refusal: no security headers', 'apps/api/src/reval/evaluation.ts', '      for (const [name, value] of Object.entries(OPERATOR_HEADERS)) res.setHeader(name, value);\n', '', ['/bin/sh', '-c', 'set -a; . ./.env; set +a; npm run api:build >/dev/null 2>&1 && exec node --experimental-strip-types --no-warnings --test --test-name-pattern=N1: tests/pg/reval-eval-console.pg.test.ts', 'S-dist-rebuilt']),
 ('D21 console refusal: Host not checked', 'apps/api/src/reval/evaluation.ts', '      if (hosts !== 1 || req.headers.host !== `127.0.0.1:${o.port}`) {', '      if (false) {', ['/bin/sh', '-c', 'set -a; . ./.env; set +a; npm run api:build >/dev/null 2>&1 && exec node --experimental-strip-types --no-warnings --test --test-name-pattern=N1: tests/pg/reval-eval-console.pg.test.ts', 'S-dist-rebuilt']),
 ('D22 console refusal: duplicated Host accepted', 'apps/api/src/reval/evaluation.ts', '      if (hosts !== 1 || req.headers.host', '      if (req.headers.host', ['/bin/sh', '-c', 'set -a; . ./.env; set +a; npm run api:build >/dev/null 2>&1 && exec node --experimental-strip-types --no-warnings --test --test-name-pattern=N1: tests/pg/reval-eval-console.pg.test.ts', 'S-dist-rebuilt']),
 ('D23 durableWrite: no directory fsync', 'scripts/reval-instrument/receipt.ts', '    try { fsyncSync(dfd); } finally { closeSync(dfd); }\n  } catch (e) {', '    closeSync(dfd);\n  } catch (e) {', U('tests/reval-fsync.test.ts')),
 ('D24 logging: all-databases overrides missed', 'packages/reval/privacy-scan.ts', '        AND s.setdatabase IN (0, (SELECT d.oid', '        AND s.setdatabase IN ((SELECT d.oid', NODE + ['--test-name-pattern=RS-D-B DRAIN process inventory', 'tests/pg/reval-census.pg.test.ts']),
 ('E01 build: IDENTITY asked before every GO again', 'scripts/reval-instrument/run.ts', '    if (this.build !== null) return null;\n', '', U('tests/reval-instrument-run.test.ts')),
 ('E02 IDENTITY continuity loss only retryable', 'scripts/reval-instrument/run.ts', '      return this.#continuity(`FAILURE_${code}`) ?? `BLOCKED_C_IDENTITY_${code}`;', '      return `BLOCKED_C_IDENTITY_${code}`;', U('tests/reval-instrument-run.test.ts')),
 ('E03 previous-terminal continuity loss only retryable', 'scripts/reval-instrument/run.ts', '      const lost = this.#continuity(`FAILURE_${code}`); if (lost !== null) return lost;\n', '', U('tests/reval-instrument-run.test.ts')),
 ('E04 pair bound from the typing time', 'scripts/reval-instrument/run.ts', 'this.#pairGoUntilMono = this.#d.mono() + (expires - PAIR_NONCE_MS + PAIR_MAX_MS - CASE_PAIR_RESERVE_MS - this.#d.wallMs());', 'this.#pairGoUntilMono = this.#d.mono() + (PAIR_MAX_MS - CASE_PAIR_RESERVE_MS);', U('tests/reval-instrument-run.test.ts')),
 ('E05 pair case reserve ignored', 'scripts/reval-instrument/run.ts', ' - CASE_PAIR_RESERVE_MS - this.#d.wallMs());', ' - this.#d.wallMs());', U('tests/reval-instrument-run.test.ts')),
 ('E06 pair guard dropped', 'scripts/reval-instrument/run.ts', "    if (this.#pairGoUntilMono === null || this.#d.mono() > this.#pairGoUntilMono) return 'BLOCKED_PAIR_REFRESH_REQUIRED';\n", '', U('tests/reval-instrument-run.test.ts')),
 ('E07 PAIR_ACK paired:false unchecked', 'scripts/reval-instrument/run.ts', ' || o.paired !== false', '', U('tests/reval-instrument-run.test.ts')),
 ('E08 PAIR_ACK keys unchecked', 'scripts/reval-instrument/run.ts', "keys !== 'expiresAt,pairId,paired' || ", '', U('tests/reval-instrument-run.test.ts')),
 ('E09 profile: ancestors not protected (rc3 form)', 'packages/reval/platform.ts', 'writeDenied: [root, ...files, ...ancestors] };', 'writeDenied: [root, ...files] };', U('tests/reval-platform.test.ts')),
 ('E10 profile: the immediate parent directories not protected (rc3 form)', 'packages/reval/platform.ts', 'for (let a = dirname(p); ', 'for (let a = dirname(dirname(p)); ', U('tests/reval-platform.test.ts')),
 ('F01 profile: only the config path\'s ancestors (the rc2 rule)', 'packages/reval/platform.ts', 'for (const p of [root, ...files])', 'for (const p of [real(configPath)])', U('tests/reval-platform.test.ts')),
 ('F02 profile: the project root\'s ancestors dropped', 'packages/reval/platform.ts', 'for (const p of [root, ...files])', 'for (const p of files)', U('tests/reval-platform.test.ts')),
 ('F03 profile: the in-tree filter dropped', 'packages/reval/platform.ts', 'if (!inTree(a)) ancestors.add(a)', 'ancestors.add(a)', U('tests/reval-platform.test.ts')),
 ('E11 production wiring: another path as config', 'packages/reval/deps.ts', 'serverSandboxPaths(config, configPath,', 'serverSandboxPaths(config, config.server.apiEntry,', U('tests/reval-platform.test.ts')),
 ('E12 proofs without IDENTITY', 'scripts/reval-instrument/run.ts', "    if (this.proofs.length >= MAX_PROOFS) return 'BLOCKED_PROOF_LIMIT';\n    const bound = await this.#bindBuild(); if (bound !== null) return bound;\n", "    if (this.proofs.length >= MAX_PROOFS) return 'BLOCKED_PROOF_LIMIT';\n", U('tests/reval-instrument-run.test.ts')),
 ('E13 build binding not persisted', 'scripts/reval-instrument/run.ts', '    this.build = Object.freeze({ buildManifestSha256: build });\n    return this.#d.persist() ? null :', '    this.build = Object.freeze({ buildManifestSha256: build });\n    return true ? null :', U('tests/reval-instrument-run.test.ts')),
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
    if text.count(old) != 1: res.append(f'{name}: PATTERN_NOT_UNIQUE ({text.count(old)})'); print(res[-1], flush=True); continue
    try:
        open(full, 'w').write(text.replace(old, new, 1))
        p = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True, timeout=900)
        res.append(f"{name}: {'DETECTED' if p.returncode != 0 else 'SURVIVED'} ({' '.join(cmd[4:])})")
    finally:
        open(full, 'wb').write(orig)
    assert hashlib.sha256(open(full, 'rb').read()).hexdigest() == hashlib.sha256(orig).hexdigest()
    print(res[-1], flush=True)
print('SUMMARY', sum('DETECTED' in r for r in res), '/', len(res))
