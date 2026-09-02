#!/bin/bash
set -euo pipefail

input=$(cat)
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')

if [[ -z "$file_path" || ! -f "$file_path" ]]; then
  exit 0
fi

case "$file_path" in
  *.ts|*.tsx|*.js|*.jsx) ;;
  *) exit 0 ;;
esac

cd "$CLAUDE_PROJECT_DIR"

"./node_modules/.bin/prettier" --write "$file_path" >/dev/null 2>&1 || true

lint_output=$("./node_modules/.bin/eslint" --fix "$file_path" 2>&1) || {
  printf '%s\n' "$lint_output" >&2
  exit 2
}

exit 0
