#!/usr/bin/env bash
# The look gate of KeepTrack (keeptrack-repo-pane): the drawn code (hooks/*.ts and *.tsx, except logo.ts and keepglide.ts, which hold the
# colours of the two marks: the repo work product mark and the KeepGlide mark) takes its colours from the engine's theme keys and
# draws no emoji. action-icons.ts is exempt from the emoji scan only: it holds the band's terminal emoji, which Sophia asked for.
# Exit 0 when clean, 1 on a hex colour, a colour function or an emoji, 2 when the gate cannot run (no module found, or grep fails).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# A hex colour: a hash, 3 to 8 hex digits, at least one of them a letter (so a PR or issue number such as #106 is not one).
hex_colour='#(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{3,8}\b'
colour_function='(?i)\b(?:rgba?|hsla?)\('
# Emoji and pictographic blocks; the symbols the pane uses (●, ○, ◐, ▪, ├, └, ↗, ←, ⎇) sit outside them.
emoji='[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}\x{2B00}-\x{2BFF}]'

shopt -s nullglob
files=()
emoji_files=()
for file in "$here"/hooks/*.ts "$here"/hooks/*.tsx; do
  case "$(basename "$file")" in logo.ts | keepglide.ts) continue ;; esac
  files+=("$file")
  case "$(basename "$file")" in action-icons.ts) ;; *) emoji_files+=("$file") ;; esac
done
if [ "${#files[@]}" -eq 0 ]; then
  echo "keeptrack-look-check: no hooks module found under $here/hooks" >&2
  exit 2
fi

failed=0

# grep exits 0 on a match, 1 on none, anything else is a gate failure. The files to scan follow the pattern.
scan() {
  local label="$1" pattern="$2" status=0
  shift 2
  LC_ALL=C.UTF-8 grep -nP -- "$pattern" "$@" || status=$?
  case "$status" in
    0) echo "keeptrack-look-check: $label found (see above)" >&2; failed=1 ;;
    1) ;;
    *) echo "keeptrack-look-check: grep failed ($status) while checking $label" >&2; exit 2 ;;
  esac
}

scan "a hex colour" "$hex_colour" "${files[@]}"
scan "a colour function" "$colour_function" "${files[@]}"
scan "an emoji" "$emoji" "${emoji_files[@]}"

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "keeptrack-look-check: ${#files[@]} module(s) clean"
