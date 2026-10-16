#!/bin/zsh
# Helper reproducibility (two checkout builds) + clean production copy (git ls-files -co --exclude-standard minus dist/,
# node_modules symlinked, no network): api:build + build-peer; compare the full dist/{apps,packages} JS inventory and helper.
cd /Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1
for i in 1 2; do node --experimental-strip-types scripts/reval-server/build-peer.ts; echo "checkout build-peer $i exit=$?"; done
echo "checkout helper: $(shasum -a 256 dist/native/reval-peer | cut -d' ' -f1)"
git diff --check; echo "git diff --check exit=$?"
git ls-files -o --exclude-standard -- packages/reval scripts/reval-server native/reval-peer apps/api/src/reval prisma tests packages/graph/reval-role.ts | xargs grep -lE '[[:blank:]]$'; echo "trailing-ws-scan exit=$? (1 = none)"
C=$(mktemp -d /tmp/reval-clean.XXXX)/src; mkdir -p $C
git ls-files -co --exclude-standard -z | grep -zv '^dist/' | rsync -a --from0 --files-from=- ./ $C/
ln -s "$PWD/node_modules" $C/node_modules
( cd $C && npm run -s api:build; echo "clean api:build exit=$?"; node --experimental-strip-types scripts/reval-server/build-peer.ts; echo "clean build-peer exit=$?" )
echo "clean helper: $(shasum -a 256 $C/dist/native/reval-peer | cut -d' ' -f1)"
a=$(cd dist && find apps packages -type f -name '*.js' | sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1); b=$(cd $C/dist && find apps packages -type f -name '*.js' | sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1)
echo "dist apps+packages JS inventory files=$(cd dist && find apps packages -type f -name '*.js' | wc -l | tr -d ' ') checkout=$a clean=$b equal=$([ $a = $b ] && echo true || echo false)"
for f in apps/api/src/main.js apps/api/src/reval/bridge.js packages/graph/runtime-role.js packages/reval/controller.js packages/reval/physical.js packages/reval/channel.js packages/reval/deadline.js packages/reval/pause.js packages/reval/server-link.js packages/reval/owner-exec.js packages/reval/snapshot-reader.js; do
  echo "$f $(shasum -a 256 dist/$f | cut -d' ' -f1) $(shasum -a 256 $C/dist/$f | cut -d' ' -f1)"; done
rm -rf "$(dirname $C)"; echo cleaned
