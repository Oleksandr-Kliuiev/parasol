#!/bin/zsh
# Mutation check (temp copies only; the checkout is never modified): each mutation undoes ONE RC2 repair; its tests must FAIL.
cd /Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1
LOG=/tmp/atlas-reval-rsa/checks/rc3/mutation/mutation.log; : > $LOG
mutate() { # name file python-replacement-old python-replacement-new tests...
  local name=$1 file=$2 old=$3 new=$4; shift 4
  local M=$(mktemp -d /tmp/reval-mut.XXXX)
  git ls-files -co --exclude-standard -z | grep -zv '^dist/' | rsync -a --from0 --files-from=- ./ $M/; ln -s "$PWD/node_modules" $M/node_modules
  python3 -c "import sys;p=sys.argv[1];s=open(p).read();o=sys.argv[2];n=sys.argv[3];assert s.count(o)==1,('MUTATION ANCHOR',o);open(p,'w').write(s.replace(o,n))" "$M/$file" "$old" "$new" || { echo "$name ANCHOR-MISSING" >> $LOG; rm -rf $M; return; }
  (cd $M && node --experimental-strip-types --test --test-timeout=60000 "$@" > $M/out.log 2>&1); local rc=$?
  local f=$(grep -E '^ℹ fail' $M/out.log | head -1)
  echo "$name exit=$rc $f :: $(grep -E '^✖ ' $M/out.log | head -3 | tr '\n' ' ' | cut -c1-300)" >> $LOG
  rm -rf $M
}
mutate F1-no-post-reread-check packages/reval/pause.ts "    if (channel.violated()) return closeAnd(fail('CONTAINMENT_UNCONFIRMED', true));" "    void fail;" tests/reval-reread-window.test.ts
mutate F1-oversize-not-violation packages/reval/channel.ts "reason === 'PROTOCOL' || reason === 'FRAME_TOO_LARGE';" "reason === 'PROTOCOL';" tests/reval-reread-window.test.ts
mutate F2-cap-500 packages/reval/owner-exec.ts "export const E_CONNECT_TIMEOUT_MS = 300;" "export const E_CONNECT_TIMEOUT_MS = 500;" tests/reval-physical-peer.test.ts
mutate F2-cap-ignored packages/reval/physical.ts "  const connectMs = Math.max(1, Math.min(left, exp.connectTimeoutMs ?? left));" "  const connectMs = left;" tests/reval-physical-peer.test.ts
echo DONE >> $LOG
