#!/bin/sh

case "${1:-}" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *Password*) printf '%s\n' "${GITHUB_TOKEN:?GITHUB_TOKEN is required}" ;;
  *) exit 1 ;;
esac
