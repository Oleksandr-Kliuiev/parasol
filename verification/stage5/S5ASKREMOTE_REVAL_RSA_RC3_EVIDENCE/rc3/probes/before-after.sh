#!/bin/zsh
# Causal before/after for Sol RC2 Appendix A (delayed duplicate during the reread) and Appendix B (E connect cap): the
# reviewer's probes, verbatim, run (1) in a temp view = checkout sources overlaid with the FROZEN RC2 package
# (S5ASKREMOTE_REVAL_RSA_RC2_PACKAGE.zip, 492 entries) and (2) in the current checkout. No DB, no checkout write.
cd /Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1
P=/tmp/atlas-reval-rsa/checks/rc3/probes
V=$(mktemp -d /tmp/reval-rc2view.XXXX)/src; mkdir -p $V
git ls-files -co --exclude-standard -z | grep -zv '^dist/' | rsync -a --from0 --files-from=- ./ $V/
unzip -oq verification/stage5/S5ASKREMOTE_REVAL_RSA_RC2_PACKAGE.zip -d $V; ln -s "$PWD/node_modules" $V/node_modules
echo "RC2 view: pause.ts $(shasum -a 256 $V/packages/reval/pause.ts | cut -c1-16) owner-exec.ts $(shasum -a 256 $V/packages/reval/owner-exec.ts | cut -c1-16)"
for x in A B; do echo "== RC2 (frozen) appendix $x"; (cd $V && node --experimental-strip-types --no-warnings --input-type=module < $P/sol-rc2-appendix-$x.mjs 2>&1); done
echo "CURRENT: pause.ts $(shasum -a 256 packages/reval/pause.ts | cut -c1-16) owner-exec.ts $(shasum -a 256 packages/reval/owner-exec.ts | cut -c1-16)"
for x in A B; do echo "== CURRENT appendix $x"; node --experimental-strip-types --no-warnings --input-type=module < $P/sol-rc2-appendix-$x.mjs 2>&1; done
rm -rf "$(dirname $V)"; echo cleaned
