#!/usr/bin/env bash
# The docs honesty check of KeepAway Repo (keepaway-repo): every binary the hooks run through $.process.run, and every command a sh -c
# script runs, must be named in the "Security and privacy" sections of README.md and README.pt-BR.md and in SECURITY.md. When a hooks file
# makes a model call ($.model.complete), each of those texts must describe the model calls. The binaries are parsed from the hooks source,
# never listed here, so a new one fails the check until the docs name it. Each miss is named on its own line with the file that runs it.
# Usage: keepaway-docs-check.sh [repo-root]. The root defaults to the repository that holds this script; the self-check passes a copy.
# Exit 0 when every binary and model call is named, 1 on a miss, 2 when the check cannot run (a file is missing, or a run call or a
# sh -c script is not a literal the check can read).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
root="${1:-$here}"
hooks="$root/plugins/keepaway-repo/hooks"
readme_en="$root/README.md"
readme_pt="$root/README.pt-BR.md"
security="$root/SECURITY.md"

cannot() {
  echo "keepaway-docs-check: $1" >&2
  exit 2
}

[ -d "$hooks" ] || cannot "missing ${hooks#"$root"/}"
for file in "$readme_en" "$readme_pt" "$security"; do
  [ -f "$file" ] || cannot "missing ${file#"$root"/}"
done

shopt -s nullglob
sources=("$hooks"/*.ts "$hooks"/*.tsx)
shopt -u nullglob
[ "${#sources[@]}" -gt 0 ] || cannot "no hooks source in ${hooks#"$root"/}"

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  printf '%s' "${s%"${s##*[![:space:]]}"}"
}

# The text of a quoted literal item; fails when the item is not one.
literal() {
  local s
  s="$(trim "$1")"
  case "$s" in
    \'*\' | \"*\") printf '%s' "${s:1:${#s}-2}"; return 0 ;;
  esac
  return 1
}

# The script text of a sh -c call: a literal, or the template of a `const NAME = ...` in the hooks sources.
sh_script() {
  local item line
  item="$(trim "$1")"
  if literal "$item"; then return 0; fi
  [[ "$item" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
  line="$(grep -hE "^(export )?const ${item} = \`" "${sources[@]}" || true)"
  line="${line%%$'\n'*}"
  [ -n "$line" ] || return 1
  line="${line#*= \`}"
  printf '%s' "${line%\`*}"
}

declare -A runs=()
model_files=""
note() {
  case ", ${runs[$1]:-}, " in
    *", $2, "*) ;;
    *) runs[$1]="${runs[$1]:+${runs[$1]}, }$2" ;;
  esac
}

for source in "${sources[@]}"; do
  name="${source#"$root"/}"
  flat="$(tr '\n' ' ' < "$source")"
  calls_total="$({ grep -oF '.run(' <<< "$flat" || true; } | wc -l)"
  mapfile -t calls < <({ grep -oE '\.run\( *\[[^]]*\]' <<< "$flat" || true; })
  if [ "${#calls[@]}" -ne "$calls_total" ]; then
    cannot "$name: a run call that is not an array literal, so its binary cannot be read"
  fi
  for call in "${calls[@]}"; do
    inner="${call#*\[}"
    inner="${inner%\]}"
    IFS=',' read -r -a items <<< "$inner"
    if ! binary="$(literal "${items[0]}")" || [[ ! "$binary" =~ ^[A-Za-z0-9._-]+$ ]]; then
      cannot "$name: a run call whose binary is not a plain literal ($call)"
    fi
    note "$binary" "$name"
    if [ "$binary" = sh ] && [ "$(trim "${items[1]:-}")" = "'-c'" ]; then
      script="$(sh_script "${items[2]:-}")" || cannot "$name: a sh -c script the check cannot read (${items[2]:-})"
      while IFS= read -r word; do
        note "$word" "$name (in a sh -c script)"
      done < <(printf '%s\n' "$script" | sed -E 's/[|;&]/\n/g; s/^[[:space:]]*//' | awk 'NF { print $1 }' | grep -E '^[A-Za-z][A-Za-z0-9._-]*$' || true)
    fi
  done
  if grep -qF -- "\$.model.complete" "$source"; then
    model_files="${model_files}${model_files:+, }${name}"
  fi
done

failed=0

# The Security and privacy section of a README, from its heading to the next second-level heading.
section_of() {
  awk '/^## / { on = ($0 ~ /(Security and privacy|Segurança e privacidade)$/) } on' "$1"
}

check_doc() {
  local label="$1" text="$2" bin model_re="model call|ao modelo|\$\.model\.complete"
  if [ -z "$text" ]; then
    echo "keepaway-docs-check: $label: no Security and privacy section" >&2
    failed=1
    return
  fi
  for bin in $(printf '%s\n' "${!runs[@]}" | sort); do
    if ! grep -qF -e "\`${bin}\`" -e "\`${bin} " <<< "$text"; then
      echo "keepaway-docs-check: $label: \`${bin}\` is not named (run by ${runs[$bin]})" >&2
      failed=1
    fi
  done
  if [ -n "$model_files" ] && ! grep -qiE "$model_re" <<< "$text"; then
    echo "keepaway-docs-check: $label: the model calls (in ${model_files}) are not described" >&2
    failed=1
  fi
}

check_doc "README.md" "$(section_of "$readme_en")"
check_doc "README.pt-BR.md" "$(section_of "$readme_pt")"
check_doc "SECURITY.md" "$(cat "$security")"

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "keepaway-docs-check: every binary the hooks run (${#runs[@]}) and every model call is named in the privacy docs"
