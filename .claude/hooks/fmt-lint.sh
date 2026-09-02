#!/bin/bash
set -euo pipefail

input=$(cat)
file_path=$(printf '%s' "$input" | node -e '
  let data = "";
  process.stdin.on("data", (chunk) => { data += chunk; });
  process.stdin.on("end", () => {
    process.stdout.write(JSON.parse(data).tool_input?.file_path ?? "");
  });
')

if [[ -z "$file_path" || ! -f "$file_path" ]]; then
  exit 0
fi

case "$file_path" in
  *.ts|*.tsx|*.js|*.jsx) ;;
  *) exit 0 ;;
esac

cd "$CLAUDE_PROJECT_DIR"

format_output=$("./node_modules/.bin/prettier" --write "$file_path" 2>&1) || {
  printf '%s\n' "$format_output" >&2
  exit 2
}

lint_output=$("./node_modules/.bin/eslint" --fix "$file_path" 2>&1) || {
  printf '%s\n' "$lint_output" >&2
  exit 2
}

exit 0
