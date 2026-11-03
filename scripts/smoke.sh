#!/usr/bin/env bash
# Clean-machine smoke test of the CLI package (ALIGN L19; copied into the public mirror as scripts/smoke.sh).
#
#   smoke.sh <version>      npx <package>@<version> from the npm registry (the name from packages/cli/package.json)
#   smoke.sh --tarball      npm pack of packages/cli (a release build: ALIGN_DEFAULT_SERVER must be an https origin;
#                           a placeholder that resolves nowhere is used when it is unset), then the same from the tarball
#   smoke.sh --tgz <file>   the same from a tarball already packed (the mirror's workflow: the one it publishes)
#
# Each run uses a fresh HOME and an empty npm cache, so nothing from this machine helps: `align --version` must print
# the expected version and `align init --help` must succeed. The packed bundle must not contain the dev-server
# fallback. Prints what it checks; no secrets are involved.
set -euo pipefail
export LC_ALL=C

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
[ -f "$root/packages/cli/package.json" ] || root="$(cd "$here/.." && pwd)" # inside the mirror: scripts/smoke.sh
cli="$root/packages/cli"
name="$(node -p "require('$cli/package.json').name")"

usage() {
  echo "usage: smoke.sh <version> | --tarball | --tgz <file>" >&2
  exit 2
}
[ "$#" -eq 1 ] || { [ "$#" -eq 2 ] && [ "$1" = "--tgz" ]; } || usage

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/home" "$work/cache" "$work/run"
run() {
  # A fresh HOME and npm cache; the PATH keeps node and npm only.
  env -i PATH="$(dirname "$(command -v node)"):/usr/bin:/bin" HOME="$work/home" \
    npm_config_cache="$work/cache" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false \
    "$@"
}

if [ "$1" = "--tarball" ] || [ "$1" = "--tgz" ]; then
  if [ "$1" = "--tgz" ]; then
    [ "$#" -eq 2 ] || usage
    tgz="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
    [ -f "$tgz" ] || usage
  else
    server="${ALIGN_DEFAULT_SERVER:-https://smoke.invalid}"
    (cd "$cli" && ALIGN_DEFAULT_SERVER="$server" ALIGN_RELEASE=1 npm pack --silent --pack-destination "$work" >/dev/null)
    tgz="$(ls "$work"/*.tgz)"
  fi
  version="$(tar -xOzf "$tgz" package/package.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"
  # Not `tar | grep -q`: under pipefail grep -q's early exit SIGPIPEs tar on a large bundle, so a match read as "no
  # match" and the check passed (L43). The bundle goes to a file and grep reads it whole.
  tar -xOzf "$tgz" package/dist/align.mjs > "$work/align.mjs.check"
  if grep -q "http://localhost:3000" "$work/align.mjs.check"; then
    echo "smoke: the packed bundle carries the dev-server fallback" >&2
    exit 1
  fi
  pkg=("--package=$tgz")
  echo "smoke: $(basename "$tgz") ($version)"
else
  version="$1"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || usage
  pkg=("--package=$name@$version")
  echo "smoke: $name@$version from the registry"
fi

cd "$work/run"
got="$(run npm exec --yes "${pkg[@]}" -- align --version)"
if [ "$got" != "$version" ]; then
  echo "smoke: align --version printed '$got', expected '$version'" >&2
  exit 1
fi
echo "smoke: align --version → $got"
help="$(run npm exec --yes "${pkg[@]}" -- align init --help)"
case "$help" in
  *"--no-backfill"*) echo "smoke: align init --help ok" ;;
  *)
    echo "smoke: align init --help did not describe init" >&2
    exit 1
    ;;
esac
echo "smoke: ok"
