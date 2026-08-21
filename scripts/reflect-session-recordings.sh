#!/usr/bin/env bash

set -o pipefail

usage() {
  cat <<'EOF'
Usage: scripts/reflect-session-recordings.sh <session-folder-name> [session-folder-name ...]

Runs every package.json script whose name ends in ":reflect" for each supplied
Jarvis session recording folder. Pass folder names only, not absolute paths.

Example:
  scripts/reflect-session-recordings.sh \
    session-2026-08-20T20-00-09-537Z_22mpkc \
    session-2026-08-21T07-53-27-414Z_g4wb2i
EOF
}

fail_usage() {
  printf 'Error: %s\n\n' "$1" >&2
  usage >&2
  exit 64
}

if (( $# == 0 )); then
  fail_usage "provide at least one session folder name"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
SESSION_ROOT="${JARVIS_SESSION_RECORDINGS_DIR:-${HOME}/Library/Application Support/dev.seasonsg.jarvis/meeting-session-recordings}"
NODE_BIN="${NODE_BIN:-node}"
NPM_BIN="${NPM_BIN:-npm}"

if [[ ! -d "$SESSION_ROOT" ]]; then
  printf 'Error: session recording root does not exist: %s\n' "$SESSION_ROOT" >&2
  exit 66
fi
SESSION_ROOT="$(cd "$SESSION_ROOT" && pwd -P)"

session_names=()
session_directories=()
for session_name in "$@"; do
  case "$session_name" in
    ""|"."|".."|*/*)
      fail_usage "session arguments must be folder names without path separators: $session_name"
      ;;
  esac

  session_directory="$SESSION_ROOT/$session_name"
  if [[ ! -d "$session_directory" ]]; then
    printf 'Error: session recording folder does not exist: %s\n' "$session_directory" >&2
    exit 66
  fi
  session_directory="$(cd "$session_directory" && pwd -P)"
  case "$session_directory" in
    "$SESSION_ROOT"/*) ;;
    *)
      printf 'Error: session folder resolves outside the recording root: %s\n' "$session_name" >&2
      exit 66
      ;;
  esac

  duplicate=false
  for existing_directory in "${session_directories[@]}"; do
    if [[ "$existing_directory" == "$session_directory" ]]; then
      duplicate=true
      break
    fi
  done
  if [[ "$duplicate" == true ]]; then
    continue
  fi

  session_names+=("$session_name")
  session_directories+=("$session_directory")
done

reflection_commands=()
while IFS= read -r command_name; do
  if [[ -n "$command_name" ]]; then
    reflection_commands+=("$command_name")
  fi
done < <(
  "$NODE_BIN" -e '
    const packageJson = require(process.argv[1]);
    for (const name of Object.keys(packageJson.scripts ?? {})) {
      if (name.endsWith(":reflect")) process.stdout.write(`${name}\n`);
    }
  ' "$REPO_ROOT/package.json"
)

if (( ${#reflection_commands[@]} == 0 )); then
  printf 'Error: package.json does not define any scripts ending in ":reflect".\n' >&2
  exit 70
fi

passed=0
failed=0
failures=()
total=$(( ${#session_directories[@]} * ${#reflection_commands[@]} ))
current=0

cd "$REPO_ROOT" || exit 70
for session_index in "${!session_directories[@]}"; do
  session_name="${session_names[$session_index]}"
  session_directory="${session_directories[$session_index]}"
  for command_name in "${reflection_commands[@]}"; do
    current=$((current + 1))
    printf '\n==> [%d/%d] %s :: %s\n' "$current" "$total" "$session_name" "$command_name"
    if "$NPM_BIN" run "$command_name" -- --session "$session_directory"; then
      passed=$((passed + 1))
    else
      failed=$((failed + 1))
      failures+=("$session_name :: $command_name")
      printf 'Reflection failed: %s :: %s\n' "$session_name" "$command_name" >&2
    fi
  done
done

printf '\nReflection summary: %d passed, %d failed across %d session(s) and %d command(s).\n' \
  "$passed" "$failed" "${#session_directories[@]}" "${#reflection_commands[@]}"

if (( failed > 0 )); then
  printf 'Failed reflections:\n' >&2
  for failure in "${failures[@]}"; do
    printf '  - %s\n' "$failure" >&2
  done
  exit 1
fi
