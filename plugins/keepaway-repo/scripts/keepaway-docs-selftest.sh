#!/usr/bin/env bash
# Self-check of the docs honesty check (scripts/keepaway-docs-check.sh): the real tree passes; a planted wget in a hooks copy fails and
# names wget; glab removed from the README Security section fails and names glab and README.md; the model-call wording removed from
# SECURITY.md fails and names SECURITY.md. It works on a copy in a temp folder, so the real files are never edited. Exit 0 when every case
# behaves as stated, 1 otherwise.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
check="$here/plugins/keepaway-repo/scripts/keepaway-docs-check.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/keepaway-docs-selftest-XXXXXX")"
trap 'rm -rf -- "$work"' EXIT

failed=0
tree="$work/tree"

# A fresh copy of the hooks and the three docs, so each case starts from the real text.
fresh_copy() {
  rm -rf -- "$tree"
  mkdir -p "$tree/plugins/keepaway-repo"
  cp -R "$here/plugins/keepaway-repo/hooks" "$tree/plugins/keepaway-repo/"
  cp "$here/README.md" "$here/README.pt-BR.md" "$here/SECURITY.md" "$tree/"
}

# expect_pass <label> : the check exits 0 on the copy.
expect_pass() {
  local label="$1" status=0
  bash "$check" "$tree" > /dev/null 2>&1 || status=$?
  if [ "$status" -eq 0 ]; then
    echo "keepaway-docs-selftest: ok - $label"
  else
    echo "keepaway-docs-selftest: FAILED - $label (exit $status, wanted 0)" >&2
    failed=1
  fi
}

# expect_fail <label> <named...> : the check exits 1 and its output names every given item.
expect_fail() {
  local label="$1" status=0 output named
  shift
  output="$(bash "$check" "$tree" 2>&1)" || status=$?
  if [ "$status" -ne 1 ]; then
    echo "keepaway-docs-selftest: FAILED - $label (exit $status, wanted 1)" >&2
    failed=1
    return
  fi
  for named in "$@"; do
    if ! grep -qF -- "$named" <<< "$output"; then
      echo "keepaway-docs-selftest: FAILED - $label (output does not name $named)" >&2
      failed=1
      return
    fi
  done
  echo "keepaway-docs-selftest: ok - $label"
}

fresh_copy
expect_pass "the real tree names every binary the hooks run and every model call"

fresh_copy
echo "export const plantedProbe = () => \$.process.run(['wget', 'x'])" >> "$tree/plugins/keepaway-repo/hooks/register.tsx"
expect_fail "a planted wget in a hooks file fails and names wget" wget register.tsx

fresh_copy
sed -i "/\`glab\` calls to GitLab/d" "$tree/README.md"
expect_fail "glab removed from the README Security section fails and names glab and README.md" glab README.md

fresh_copy
sed -i "s/model call/model work/g" "$tree/SECURITY.md"
expect_fail "the model-call wording removed from SECURITY.md fails and names SECURITY.md" SECURITY.md

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "keepaway-docs-selftest: every case behaves as stated"
