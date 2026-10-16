#!/bin/zsh
# ONE paired record (root resolution of Opus F5.2): identities BEFORE → the complete unfiltered current unit run (TAP) →
# the direct child probe with the EXACT argv of tests/ask-remote-eval-execution-pty.test.ts under a real pty → identities AFTER.
cd /Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1
export ATLAS_REVAL_RC5_HISTORICAL_VIEW=/tmp/atlas-reval-rsa/historical-rc5-view-v2
NODE=$(node -p process.execPath)
echo "=== BEFORE $(date -u +%FT%TZ)"; python3 -I /tmp/atlas-reval-rsa/checks/rc2/identity.py before
echo "=== UNIT node=$NODE $($NODE --version) cmd: node --experimental-strip-types --test --test-reporter=tap tests/*.test.ts ($(ls tests/*.test.ts | wc -l | tr -d ' ') files)"
$NODE --experimental-strip-types --test --test-reporter=tap tests/*.test.ts; U=$?
echo "=== UNIT_EXIT $U"
D=$(mktemp -d /tmp/reval-pty-probe.XXXX); mkdir -m 700 $D/r; : > $D/in
ARGV=("$NODE" --experimental-strip-types --no-warnings scripts/ask-remote-eval-execution/cli.ts session --receipt-dir $D/r)
echo "=== PROBE argv (exact child argv of the PTY test, receipt dir varies): ${ARGV[*]}"
/usr/bin/script -q /dev/null "${ARGV[@]}" < $D/in > $D/out 2>&1; P=$?
tr -d '\r' < $D/out | sed 's/[^[:print:]]//g' | grep -E "R-EVAL EXECUTION INSTRUMENT|ExecError|code: '|    at "
echo "=== PROBE_EXIT $P receipts=$(ls $D/r | wc -l | tr -d ' ')"; rm -rf $D
echo "=== AFTER $(date -u +%FT%TZ)"; python3 -I /tmp/atlas-reval-rsa/checks/rc2/identity.py after
exit $U
