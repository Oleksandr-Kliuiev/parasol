#!/bin/zsh
# R-EVAL RS-A RC2 COMPLETE required suite (Opus RC1 F5), sequential on the FINAL repaired source; every step's command,
# exit code, duration and log sha256 recorded in steps.tsv. Docker PG17 test admin + the REQUIRED native fixture (no skip).
cd /Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1
export ATLAS_PG_ADMIN_URL=postgresql://atlas:atlas_local_only@localhost:5432/atlas
export ATLAS_REVAL_NATIVE_PG_FIXTURE=/tmp/atlas-reval-rsa/native-pg-fixture.json
export ATLAS_REVAL_RC5_HISTORICAL_VIEW=/tmp/atlas-reval-rsa/historical-rc5-view-v2
OUT=/tmp/atlas-reval-rsa/checks/rc2/final4
: > $OUT/steps.tsv
step() { local name=$1; shift; local t0=$(date +%s); "$@" > $OUT/$name.log 2>&1; local rc=$?; local t1=$(date +%s);
  echo -e "$name\t$rc\t$((t1-t0))s\t$(shasum -a 256 $OUT/$name.log | cut -d' ' -f1)\t$*" >> $OUT/steps.tsv; }
step typecheck npm run -s typecheck
step ui-typecheck npm run -s ui:typecheck
step db-generate npm run -s db:generate
step schema-validate npm run -s schema:validate
step db-drift npm run -s db:check:drift
step db-pg17 npm run -s db:check:pg17
step api-build npm run -s api:build
step unit-paired /tmp/atlas-reval-rsa/checks/rc2/unit-paired.sh
step rc5-files node --experimental-strip-types --test --test-reporter=tap --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=$OUT/rc5-files.xml tests/ask-remote-eval-corpus.test.ts tests/ask-remote-eval-execution-cli.test.ts tests/ask-remote-eval-execution-liability.test.ts tests/ask-remote-eval-execution-operator.test.ts tests/ask-remote-eval-execution-pty.test.ts tests/ask-remote-eval-execution-receipt.test.ts tests/ask-remote-eval-execution-repair.test.ts tests/ask-remote-eval-execution-replay.test.ts tests/ask-remote-eval-execution-session.test.ts tests/ask-remote-eval-fixtures.test.ts tests/ask-remote-eval-offline.test.ts tests/ask-remote-eval-supervisor.test.ts tests/context-budget.test.ts
step test-pg npm run -s test:pg
step test-ui npm run -s test:ui
echo DONE >> $OUT/steps.tsv
