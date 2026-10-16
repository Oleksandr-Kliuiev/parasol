#!/bin/zsh
cd /Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1
export ATLAS_PG_ADMIN_URL=postgresql://atlas:atlas_local_only@localhost:5432/atlas
export ATLAS_REVAL_NATIVE_PG_FIXTURE=/tmp/atlas-reval-rsa/native-pg-fixture.json
node --experimental-strip-types --test tests/pg/reval-roles.pg.test.ts tests/pg/reval-snapshot.pg.test.ts tests/pg/reval-upgrade-guard.pg.test.ts tests/pg/reval-closure.pg.test.ts tests/pg/reval-launch.pg.test.ts tests/pg/reval-native-unix.pg.test.ts > /tmp/atlas-reval-rsa/checks/repair/pg-focused.log 2>&1
echo "exit=$?" > /tmp/atlas-reval-rsa/checks/repair/pg-focused.exit
