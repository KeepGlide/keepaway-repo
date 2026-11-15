#!/usr/bin/env bash
# The release version check of KeepAway Repo (keepaway-repo): the version in plugins/keepaway-repo/.claude-plugin/plugin.json is the one
# every other place that names it must carry: the marketplace entry, the README badge, Status line and Tests line (both languages), the
# CHANGELOG header line and its top released entry, and the supported version in SECURITY.md. Each mismatch is named on its own line.
# Usage: keepaway-version-check.sh [repo-root]. The root defaults to the repository that holds this script; the self-check passes a copy.
# Exit 0 when every place agrees, 1 on a mismatch, 2 when the check cannot run (a file is missing or no version is read).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
root="${1:-$here}"

manifest="$root/plugins/keepaway-repo/.claude-plugin/plugin.json"
marketplace="$root/.claude-plugin/marketplace.json"
readme_en="$root/README.md"
readme_pt="$root/README.pt-BR.md"
changelog="$root/CHANGELOG.md"
security="$root/SECURITY.md"

for file in "$manifest" "$marketplace" "$readme_en" "$readme_pt" "$changelog" "$security"; do
  if [ ! -f "$file" ]; then
    echo "keepaway-version-check: missing ${file#"$root"/}" >&2
    exit 2
  fi
done

version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest")"
version="${version%%$'\n'*}"
if [ -z "$version" ]; then
  echo "keepaway-version-check: no version in ${manifest#"$root"/}" >&2
  exit 2
fi

# The version as a shields.io badge writes it: every hyphen is doubled (0.2.0-beta.26 becomes 0.2.0--beta.26).
badge="$(printf '%s' "$version" | sed 's/-/--/g')"

failed=0
fail() {
  echo "keepaway-version-check: ${1#"$root"/}: $2 (plugin.json says $version)" >&2
  failed=1
}

# The marketplace entry's version.
market_version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$marketplace")"
market_version="${market_version%%$'\n'*}"
if [ "$market_version" != "$version" ]; then
  fail "$marketplace" "the marketplace entry says ${market_version:-no version}"
fi

# The README badge and Status line, and the Tests section line, in each language.
for readme in "$readme_en" "$readme_pt"; do
  if ! grep -qF -- "-$badge-" "$readme"; then
    fail "$readme" "the version badge does not carry $version"
  fi
  if ! grep -qF -- "Beta (\`$version\`)" "$readme"; then
    fail "$readme" "the Status line does not carry $version"
  fi
  tests_section="$(awk '/^## /{ on = ($0 ~ /(Tests|Testes)$/) } on' "$readme")"
  if ! grep -qF -- "on the $version tree" <<< "$tests_section" &&
     ! grep -qF -- "na árvore $version " <<< "$tests_section"; then
    fail "$readme" "the Tests section line does not carry $version"
  fi
done

# The CHANGELOG header line and its top released entry.
if ! grep -qF -- "is $version." "$changelog"; then
  fail "$changelog" "the header line does not carry $version"
fi
top_entry="$(grep -m 1 '^## \[[0-9]' "$changelog" || true)"
case "$top_entry" in
  "## [$version]"*) ;;
  *) fail "$changelog" "the top released entry is '${top_entry:-none}'" ;;
esac

# The supported version in the SECURITY.md table.
if ! grep -qF -- "\`$version\` (latest" "$security"; then
  fail "$security" "the supported version does not carry $version"
fi

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "keepaway-version-check: every checked place carries $version"
