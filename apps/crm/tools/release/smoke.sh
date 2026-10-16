#!/usr/bin/env bash
# Smoke test of a deployed crm-web (DEV-05): more than "health 200". Read-only and anonymous — it signs nobody in and
# writes nothing. Checks that the process and its dependencies are ready, the SPA and its assets are served with the
# security headers, every API and admin surface refuses an anonymous caller, and the sign-in goes to the expected Entra
# app registration. Writes the result as JSON (for the deployment record) and exits 1 on any failed check.
#
# Usage: smoke.sh BASE_URL OUT.json [--entra-client-id CLIENT_ID] [--insecure]
#   --entra-client-id  expect /bff/login to redirect to login.microsoftonline.com with this client id (Entra mode)
#   --insecure         accept an untrusted certificate (local development certificate only)
set -o pipefail

base="${1%/}"
out="$2"
if [[ -z "$base" || -z "$out" ]]; then
  echo "usage: smoke.sh BASE_URL OUT.json [--entra-client-id ID] [--insecure]" >&2
  exit 2
fi
shift 2
client=""
curl_args=(--silent --show-error --max-time 30)
while [[ $# -gt 0 ]]; do
  case "$1" in
    --entra-client-id) client="$2"; shift 2 ;;
    --insecure) curl_args+=(--insecure); shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
passed=()
failed=()

# fetch NAME METHOD PATH [CURL ARGS...]: response body, headers and status into $work/NAME.{body,headers,status}
fetch() {
  local name=$1 method=$2 path=$3; shift 3
  curl "${curl_args[@]}" -X "$method" -o "$work/$name.body" -D "$work/$name.headers" -w '%{http_code}' \
    -H 'Accept: application/json, text/html' "$@" "$base$path" > "$work/$name.status" 2> "$work/$name.error" || echo "000" > "$work/$name.status"
}
status_of() { cat "$work/$1.status"; }
header_of() { grep -i "^$2:" "$work/$1.headers" | tail -1 | cut -d' ' -f2- | tr -d '\r'; }
record() { if [[ "$2" == ok ]]; then passed+=("$1"); else failed+=("$1: $3"); fi; }
expect_status() { # NAME METHOD PATH ALLOWED...
  local name=$1 method=$2 path=$3; shift 3
  fetch "$name" "$method" "$path"
  local actual; actual=$(status_of "$name")
  for allowed in "$@"; do
    if [[ "$actual" == "$allowed" ]]; then record "$name" ok; return 0; fi
  done
  record "$name" fail "$method $path answered $actual, expected $*"
  return 1
}

expect_status live GET /health/live 200
if expect_status ready GET /health/ready 200; then
  grep -q "Healthy" "$work/ready.body" || record ready-body fail "/health/ready did not report Healthy"
fi

# The SPA, its entry script and the headers that protect it.
if expect_status spa GET / 200; then
  grep -q 'id="root"' "$work/spa.body" || record spa-root fail "/ is not the CRM single-page app"
  [[ "$(header_of spa Content-Security-Policy)" == *"default-src 'self'"* ]] || record spa-csp fail "no Content-Security-Policy on /"
  [[ "$(header_of spa X-Content-Type-Options)" == nosniff ]] || record spa-nosniff fail "no X-Content-Type-Options: nosniff on /"
  asset=$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' "$work/spa.body" | head -1)
  if [[ -n "$asset" ]]; then
    expect_status spa-asset GET "$asset" 200
  else
    record spa-asset fail "/ references no /assets/index-*.js"
  fi
fi
if [[ "$base" == https://* && "$base" != https://localhost* ]]; then
  if [[ -n "$(header_of spa Strict-Transport-Security)" ]]; then record hsts ok; else record hsts fail "no Strict-Transport-Security"; fi
fi

# Nothing behind the sign-in answers an anonymous caller: the API with 401, a mutation without the CSRF header with 403,
# the monitoring and admin pages with 401/403 or a redirect to the sign-in.
expect_status api-anonymous GET /api/v1/customers/organizations 401
expect_status api-write-without-csrf POST /api/v1/customers/organizations 403
fetch api-write-anonymous POST /api/v1/customers/organizations -H 'X-CSRF: 1' -H 'Content-Type: application/json' --data '{}'
if [[ "$(status_of api-write-anonymous)" == 401 ]]; then
  record api-write-anonymous ok
else
  record api-write-anonymous fail "anonymous POST with the CSRF header answered $(status_of api-write-anonymous), expected 401"
fi
expect_status bff-user-anonymous GET /bff/user 401
for page in /health/integrations /admin/jobs; do
  name="anonymous${page//\//-}"
  fetch "$name" GET "$page"
  code=$(status_of "$name"); location=$(header_of "$name" Location)
  if [[ "$code" == 401 || "$code" == 403 || ( "$code" == 302 && ( "$location" == */bff/login* || "$location" == https://login.microsoftonline.com/* ) ) ]]; then
    record "$name" ok
  else
    record "$name" fail "GET $page answered $code ${location:+to $location}, expected 401/403 or the sign-in"
  fi
done

# The sign-in goes to the app registration of this environment.
if [[ -n "$client" ]]; then
  fetch login GET "/bff/login?returnUrl=%2F"
  location=$(header_of login Location)
  if [[ "$(status_of login)" == 302 && "$location" == https://login.microsoftonline.com/* && "$location" == *"client_id=$client"* ]]; then
    record entra-login ok
  else
    record entra-login fail "/bff/login answered $(status_of login) to ${location:-no location}, expected Entra with client_id=$client"
  fi
fi

result=pass
[[ ${#failed[@]} -gt 0 ]] && result=fail
{
  printf '{\n  "result": "%s",\n  "baseUrl": "%s",\n  "checkedAt": "%s",\n  "passed": [' "$result" "$base" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  sep=""; for item in "${passed[@]}"; do printf '%s"%s"' "$sep" "$item"; sep=", "; done
  printf '],\n  "failed": ['
  sep=""; for item in "${failed[@]}"; do printf '%s"%s"' "$sep" "${item//\"/\'}"; sep=", "; done
  printf ']\n}\n'
} > "$out"

echo "smoke $base: $result (${#passed[@]} passed, ${#failed[@]} failed)"
for item in "${failed[@]}"; do echo "  FAILED $item"; done
[[ "$result" == pass ]]
