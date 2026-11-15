#!/usr/bin/env bash
# Self-check of the version check (scripts/keepaway-version-check.sh): the real tree passes; a planted mismatch in each checked place fails
# and names its file. It works on a copy of the six checked files in a temp folder, so the real files are never edited. Exit 0 when every
# case behaves as stated, 1 otherwise.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
check="$here/plugins/keepaway-repo/scripts/keepaway-version-check.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/keepaway-version-selftest-XXXXXX")"
trap 'rm -rf -- "$work"' EXIT

failed=0
tree="$work/tree"

# A fresh copy of the checked files, so each case starts from the real text.
fresh_copy() {
  rm -rf -- "$tree"
  mkdir -p "$tree/plugins/keepaway-repo/.claude-plugin" "$tree/.claude-plugin"
  cp "$here/plugins/keepaway-repo/.claude-plugin/plugin.json" "$tree/plugins/keepaway-repo/.claude-plugin/"
  cp "$here/.claude-plugin/marketplace.json" "$tree/.claude-plugin/"
  cp "$here/README.md" "$here/README.pt-BR.md" "$here/CHANGELOG.md" "$here/SECURITY.md" "$tree/"
}

# expect_pass <label> : the check exits 0 on the copy.
expect_pass() {
  local label="$1" status=0
  bash "$check" "$tree" > /dev/null 2>&1 || status=$?
  if [ "$status" -eq 0 ]; then
    echo "keepaway-version-selftest: ok - $label"
  else
    echo "keepaway-version-selftest: FAILED - $label (exit $status, wanted 0)" >&2
    failed=1
  fi
}

# expect_fail <label> <file name> : the check exits 1 and its output names the file.
expect_fail() {
  local label="$1" named="$2" status=0 output
  output="$(bash "$check" "$tree" 2>&1)" || status=$?
  if [ "$status" -eq 1 ] && grep -qF -- "$named" <<< "$output"; then
    echo "keepaway-version-selftest: ok - $label"
  else
    echo "keepaway-version-selftest: FAILED - $label (exit $status, wanted 1 naming $named)" >&2
    failed=1
  fi
}

fresh_copy
expect_pass "the real tree is consistent"

fresh_copy
sed -i 's/"version": "0\.2\.0-beta\.26"/"version": "0.2.0-beta.25"/' "$tree/.claude-plugin/marketplace.json"
expect_fail "a marketplace entry with another version fails" "marketplace.json"

fresh_copy
sed -i '0,/0\.2\.0--beta\.26/s//0.2.0--beta.25/' "$tree/README.pt-BR.md"
expect_fail "a README badge with another version fails" "README.pt-BR.md"

fresh_copy
sed -i 's/^## \[0\.2\.0-beta\.26\]/## [0.2.0-beta.25]/' "$tree/CHANGELOG.md"
expect_fail "a CHANGELOG top released entry with another version fails" "CHANGELOG.md"

fresh_copy
sed -i "s/\`0\.2\.0-beta\.26\` (latest/\`0.2.0-beta.25\` (latest/" "$tree/SECURITY.md"
expect_fail "a SECURITY.md supported version with another version fails" "SECURITY.md"

exit "$failed"
