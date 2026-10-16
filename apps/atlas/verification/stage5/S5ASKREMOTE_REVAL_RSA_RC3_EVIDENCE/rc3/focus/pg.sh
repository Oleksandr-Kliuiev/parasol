#!/bin/zsh
# Focused RS-A PG run (args: test files). Docker admin + native fixture; log name from $1 label.
cd /Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1
export ATLAS_PG_ADMIN_URL=postgresql://atlas:atlas_local_only@localhost:5432/atlas
export ATLAS_REVAL_NATIVE_PG_FIXTURE=/tmp/atlas-reval-rsa/native-pg-fixture.json
L=/tmp/atlas-reval-rsa/checks/rc3/focus/$1; shift
npm run -s api:build > $L.build.log 2>&1 || { echo "build=$?" > $L.exit; exit 1; }
node --experimental-strip-types --test "$@" > $L.log 2>&1
echo "exit=$?" > $L.exit
