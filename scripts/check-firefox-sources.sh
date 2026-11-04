#!/usr/bin/env bash
# Proves that the Firefox sources archive rebuilds the Firefox add-on exactly,
# as Firefox Add-ons reviewers do with it: extract it into an empty directory,
# follow BUILDING.md, and compare the output with the add-on zip file by file.
#
# Usage: scripts/check-firefox-sources.sh <sources.zip> <firefox.zip>
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <sources.zip> <firefox.zip>" >&2
  exit 2
fi

sources_zip=$(realpath "$1")
firefox_zip=$(realpath "$2")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir "$work/sources" "$work/expected"
unzip -q "$sources_zip" -d "$work/sources"
unzip -q "$firefox_zip" -d "$work/expected"

test -f "$work/sources/BUILDING.md" || {
  echo "sources archive has no BUILDING.md" >&2
  exit 1
}

(
  cd "$work/sources"
  pnpm install --frozen-lockfile
  pnpm build:firefox
) >"$work/build.log" 2>&1 || {
  cat "$work/build.log" >&2
  echo "the sources archive did not build" >&2
  exit 1
}

if ! diff -r "$work/sources/packages/extension/.output/firefox-mv2" "$work/expected"; then
  echo "the sources archive rebuilt a different add-on" >&2
  exit 1
fi
echo "the sources archive rebuilds the Firefox add-on exactly"
