#!/usr/bin/env bash
# The system packages Playwright's browsers need on the CI runner, without depending on one Ubuntu mirror's speed.
# The packages are kept between runs in CACHE_DIR (actions/cache restores and saves it), so most runs fetch nothing; apt
# checks each kept package against the signed archive index, as it does a download. What is missing comes from the
# runner's own mirror, and from archive.ubuntu.com once that has taken FIRST_MIRROR_SECONDS: twice on 22.10.2026 the
# runner's mirror sent the 115 MB at 45 kB/s and the browser job lost 40 of its 45 minutes here.
# Usage: browser-packages.sh CACHE_DIR   (needs sudo and apps/crm/web/node_modules)
set -euo pipefail

archives=${1:?package cache directory}
first=${FIRST_MIRROR_SECONDS:-240}
second=${SECOND_MIRROR_SECONDS:-300}
web=$(cd "$(dirname "$0")/../../web" && pwd)
apt_options=(-o "Dir::Cache::Archives=$archives" -o "APT::Keep-Downloaded-Packages=true")

sudo mkdir -p "$archives/partial"
sudo apt-get update -qq
# Playwright's own account of what is missing: `apt-get install -s` over its package list, printed one "  package" a line
# (it exits 1 when something is missing, which is the case this script is for).
mapfile -t packages < <(cd "$web" && npx playwright install-deps --dry-run chromium firefox webkit \
  | sed -n 's/^  \([^[:space:]]\{1,\}\)$/\1/p' || true)

fetch() {
  sudo timeout --kill-after=15 "$1" apt-get "${apt_options[@]}" install --download-only -y -qq --no-install-recommends "${packages[@]}"
}

if [[ ${#packages[@]} -eq 0 ]]; then
  echo "The browsers' system packages are all installed."
else
  echo "Fetching ${#packages[@]} system packages for the browsers into $archives"
  if ! fetch "$first"; then
    echo "::warning::The runner's Ubuntu mirror did not deliver the browsers' packages within ${first}s; the rest comes from archive.ubuntu.com."
    # GitHub's Ubuntu runners name their mirror, azure.archive.ubuntu.com, in apt's sources.
    sources=$(grep -rlE 'azure\.archive\.ubuntu\.com' /etc/apt || true)
    if [[ -n "$sources" ]]; then
      xargs sudo sed -i -E 's#azure\.archive\.ubuntu\.com#archive.ubuntu.com#g' <<<"$sources"
    else
      echo "::warning::apt's sources name no azure.archive.ubuntu.com, so the second attempt uses the same mirror."
    fi
    sudo apt-get update -qq
    if ! fetch "$second"; then
      echo "::error::Neither the runner's Ubuntu mirror (${first}s) nor archive.ubuntu.com (${second}s) delivered the browsers' system packages."
      exit 1
    fi
  fi
  # Everything is in the cache now: the install downloads nothing.
  sudo apt-get "${apt_options[@]}" install -y -qq --no-install-recommends "${packages[@]}"
fi

# Versions the archive no longer offers leave the cache, so it does not grow from run to run, and the files become the
# runner's again for actions/cache to save them.
sudo apt-get "${apt_options[@]}" autoclean -qq
sudo chown -R "$(id -u):$(id -g)" "$archives"
