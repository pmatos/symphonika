#!/usr/bin/env bash
# Run `symphonika smoke` against the local checkout, after preflighting the
# tools and credentials that the configured provider and tracker need.
#
# Usage: scripts/smoke.sh [--config <path>] [extra args forwarded to npm run smoke]
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

CONFIG_PATH="symphonika.yml"
FORWARDED_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      CONFIG_PATH="$2"
      shift 2
      ;;
    --config=*)
      CONFIG_PATH="${1#*=}"
      shift
      ;;
    *)
      FORWARDED_ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ ! -f "${CONFIG_PATH}" ]]; then
  echo "smoke: config not found at ${CONFIG_PATH}" >&2
  exit 1
fi

require_bin() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "smoke: missing required binary: $1" >&2
    echo "       install it and try again" >&2
    exit 1
  fi
}

require_bin git
require_bin node
require_bin npm

if [[ ! -d node_modules ]]; then
  echo "smoke: installing dependencies"
  npm ci
fi

# Resolve the provider binaries to require from the chosen config so a Claude
# config doesn't fail the preflight just because Codex is missing (and vice
# versa). Symphonika v1 supports both Codex and Claude providers.
mapfile -t PROVIDER_BINS < <(node -e '
  const fs = require("fs");
  const yaml = require("yaml");
  const cfg = yaml.parse(fs.readFileSync(process.argv[1], "utf8"));
  const projects = Array.isArray(cfg.projects) ? cfg.projects : [];
  const providers = (cfg.providers && typeof cfg.providers === "object") ? cfg.providers : {};
  const seen = new Set();
  for (const project of projects) {
    if (project && project.disabled === true) continue;
    const name = project && project.agent && project.agent.provider;
    const command = name && providers[name] && providers[name].command;
    if (typeof command !== "string" || command.trim() === "") continue;
    const binary = command.trim().split(/\s+/)[0];
    if (binary && !seen.has(binary)) {
      seen.add(binary);
      process.stdout.write(binary + "\n");
    }
  }
' "${CONFIG_PATH}")

if [[ ${#PROVIDER_BINS[@]} -eq 0 ]]; then
  echo "smoke: could not resolve any provider binary from ${CONFIG_PATH}" >&2
  echo "       check that projects[].agent.provider matches a providers[] entry with a command" >&2
  exit 1
fi

for bin in "${PROVIDER_BINS[@]}"; do
  require_bin "$bin"
done

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  if command -v gh >/dev/null 2>&1 && gh auth token >/dev/null 2>&1; then
    GITHUB_TOKEN="$(gh auth token)"
    export GITHUB_TOKEN
    echo "smoke: GITHUB_TOKEN sourced from gh CLI"
  else
    echo "smoke: GITHUB_TOKEN is not set and gh CLI is not authenticated" >&2
    echo "       export GITHUB_TOKEN=... or run 'gh auth login'" >&2
    exit 1
  fi
fi

exec npm run --silent smoke -- --config "${CONFIG_PATH}" "${FORWARDED_ARGS[@]}"
