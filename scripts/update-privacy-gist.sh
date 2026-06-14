#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
policy_file="${root_dir}/lurkloot-privacy-policy.md"
gist_id="${LURKLOOT_PRIVACY_GIST_ID:-24177c19981a50c0ab3aefc70e4ffdb9}"
gist_filename="${LURKLOOT_PRIVACY_GIST_FILENAME:-lurkloot-privacy-policy.md}"

if [[ ! -f "${policy_file}" ]]; then
  echo "Missing privacy policy file: ${policy_file}" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI is required: https://cli.github.com/" >&2
  exit 1
fi

tmp_payload="$(mktemp)"
trap 'rm -f "${tmp_payload}"' EXIT

node - "${policy_file}" "${gist_filename}" > "${tmp_payload}" <<'NODE'
const fs = require("node:fs");

const [, , policyFile, gistFilename] = process.argv;
const content = fs.readFileSync(policyFile, "utf8");

process.stdout.write(JSON.stringify({
  files: {
    [gistFilename]: { content },
  },
}));
NODE

gh api --method PATCH "/gists/${gist_id}" --input "${tmp_payload}" >/dev/null
echo "Updated https://gist.github.com/jamezrin/${gist_id}"
