#!/usr/bin/env bash
# Self-check of the look gate (scripts/keepaway-look-check.sh): the real tree passes; an emoji in a drawn module fails; an emoji in
# action-icons.ts, the one module that holds every emoji, passes; a hex colour in that module still fails. It works on a copy in a
# temp folder, so the plugin tree is never edited. Exit 0 when every case behaves as stated, 1 otherwise.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
gate="$here/scripts/keepaway-look-check.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/keepaway-look-selftest-XXXXXX")"
trap 'rm -rf -- "$work"' EXIT

failed=0

# A fresh copy of the gate and the hooks, so each case starts from a clean tree.
fresh_copy() {
  rm -rf -- "$work/scripts" "$work/hooks"
  mkdir -p "$work/scripts" "$work/hooks"
  cp "$gate" "$work/scripts/"
  cp "$here"/hooks/* "$work/hooks/"
}

# expect <label> <want: pass|fail> : run the gate on the copy and check its exit code.
expect() {
  local label="$1" want="$2" status=0
  bash "$work/scripts/keepaway-look-check.sh" > /dev/null 2>&1 || status=$?
  if { [ "$want" = pass ] && [ "$status" -eq 0 ]; } || { [ "$want" = fail ] && [ "$status" -eq 1 ]; }; then
    echo "keepaway-look-selftest: ok - $label"
  else
    echo "keepaway-look-selftest: FAILED - $label (exit $status, wanted $want)" >&2
    failed=1
  fi
}

fresh_copy
expect "the real tree is clean" pass

fresh_copy
printf "export const STRAY = '\xf0\x9f\x94\x84'\n" >> "$work/hooks/pane.tsx"
expect "an emoji in a drawn module fails" fail

fresh_copy
printf "export const ICON = '\xf0\x9f\x9f\xa2'\n" >> "$work/hooks/action-icons.ts"
expect "an emoji in action-icons.ts passes (the one icon module)" pass

fresh_copy
printf "export const TINT = '#a1b2c3'\n" >> "$work/hooks/action-icons.ts"
expect "a hex colour in action-icons.ts still fails" fail

exit "$failed"
