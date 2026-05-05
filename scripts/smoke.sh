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

# `codex` is the provider declared in symphonika.yml. If you switch to claude,
# require `claude` here instead.
require_bin codex

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

if [[ ! -d node_modules ]]; then
  echo "smoke: installing dependencies"
  npm ci
fi

exec npm run --silent smoke -- --config "${CONFIG_PATH}" "${FORWARDED_ARGS[@]}"
