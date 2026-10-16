import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const manifest = JSON.parse(readFileSync(new URL('../docs/migration/sources.json', import.meta.url)));
assert.equal(git('rev-parse', '--is-shallow-repository'), 'false', 'History verification requires fetch-depth: 0.');
for (const source of manifest.sources) {
  assert.equal(git('rev-parse', `${source.commit}^{tree}`), source.tree);
  assert.equal(git('rev-parse', `${source.importCommit}:${source.prefix}`), source.tree, `${source.name}: exact import tree`);
  for (const commit of [source.commit, source.importCommit]) {
    assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: root }).status, 0, `${commit}: preserved ancestry`);
  }
  for (const ref of source.refs) {
    const branch = `archive/${source.name}/${ref.ref.replace('refs/heads/', '')}`;
    const candidates = [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`];
    const found = candidates.find(r => spawnSync('git', ['show-ref', '--verify', '--quiet', r], { cwd: root }).status === 0);
    assert.ok(found, `Missing archive ref: ${branch}`);
    assert.equal(git('rev-parse', found), ref.object, `${branch}: unchanged source commit`);
  }
  console.log(`${source.name}: original commits, import tree and all archive branches verified.`);
}
