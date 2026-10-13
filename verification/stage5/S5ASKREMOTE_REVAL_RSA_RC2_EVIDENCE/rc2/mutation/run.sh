#!/bin/zsh
# Mutation check (temp copies only; the checkout is never modified): each mutation undoes ONE RC2 repair; its tests must FAIL.
cd /Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1
LOG=/tmp/atlas-reval-rsa/checks/rc2/mutation/mutation.log; : > $LOG
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
mutate R1-no-guard packages/reval/controller.ts "const guard = setTimeout(() => onExpired(op, d.request), Math.max(0, op.until - GUARD_MARGIN_MS - deps.now()));" "const guard = setTimeout(() => undefined, 0);" tests/reval-deadline.test.ts
mutate R1-unbounded packages/reval/deadline.ts "  const left = until - performance.now();" "  return work; const left = until - performance.now();" tests/reval-deadline.test.ts tests/reval-physical-peer.test.ts
mutate R2-not-strict packages/reval/channel.ts "this.strict = options.strict === true;" "this.strict = false;" tests/reval-handshake.test.ts
mutate R3-auth-lost packages/reval/physical.ts "return s === '28P01' || s === '28000' || s === '42501' ? new PhysicalAuthError(s) : new PhysicalMismatchError('connect');" "void s; return new PhysicalMismatchError('connect');" tests/reval-physical-peer.test.ts
mutate F1-two-sequences packages/reval/controller.ts "owner.send(buildResponse(state.binding, r, seq, 'CONTROLLER', config.databaseInstanceId, 'FAILURE', { code: 'CENSUS_LIMIT_EXCEEDED' }, deps.wallIso()));" "owner.send(buildResponse(state.binding, r, state.send.take(), 'CONTROLLER', config.databaseInstanceId, 'FAILURE', { code: 'CENSUS_LIMIT_EXCEEDED' }, deps.wallIso()));" tests/reval-deadline.test.ts
mutate F1-no-reader-cap packages/reval/snapshot-reader.ts "  try { encodeFrame(worst, METADATA_FRAME_CAP); return true; }" "  try { void worst; return true; }" tests/reval-payloads.test.ts tests/reval-handshake.test.ts tests/reval-deadline.test.ts
echo DONE >> $LOG
