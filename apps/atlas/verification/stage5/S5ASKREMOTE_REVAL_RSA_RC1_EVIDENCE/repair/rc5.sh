#!/bin/zsh
cd /Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1
O=/tmp/atlas-reval-rsa/checks/repair
/tmp/atlas-reval-rsa/checks/pty-probe.sh > $O/pty-probe.log 2>&1
node --experimental-strip-types --test --test-reporter=tap --test-reporter-destination=$O/rc5-current.tap --test-reporter=junit --test-reporter-destination=$O/rc5-current.xml tests/ask-remote-eval-corpus.test.ts tests/ask-remote-eval-execution-cli.test.ts tests/ask-remote-eval-execution-liability.test.ts tests/ask-remote-eval-execution-operator.test.ts tests/ask-remote-eval-execution-pty.test.ts tests/ask-remote-eval-execution-receipt.test.ts tests/ask-remote-eval-execution-repair.test.ts tests/ask-remote-eval-execution-replay.test.ts tests/ask-remote-eval-execution-session.test.ts tests/ask-remote-eval-fixtures.test.ts tests/ask-remote-eval-offline.test.ts tests/ask-remote-eval-supervisor.test.ts tests/context-budget.test.ts
echo "exit=$?" > $O/rc5-current.exit
