#!/bin/zsh
cd /Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1
export ATLAS_REVAL_RC5_HISTORICAL_VIEW=/tmp/atlas-reval-rsa/historical-rc5-view-v2
O=/tmp/atlas-reval-rsa/checks/repair
npm run -s typecheck > $O/typecheck.log 2>&1; echo "typecheck=$?" > $O/unit.steps
node --experimental-strip-types --test --test-reporter=tap tests/*.test.ts > $O/unit.log 2>&1; echo "unit=$?" >> $O/unit.steps
