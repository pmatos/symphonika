#!/usr/bin/env bash
# Invoked by semantic-release (@semantic-release/exec prepareCmd) with the next
# version. Bumps package.json/package-lock.json, installs deps, builds dist/,
# and stages the release tarball + checksum under release-upload/ for
# @semantic-release/github.
set -euo pipefail
VERSION="${1:?usage: prepare.sh <version>}"

npm version "${VERSION}" --no-git-tag-version --allow-same-version
npm ci
npm run build

STAGE="symphonika-${VERSION}"
rm -rf release-upload
mkdir -p "release-upload/${STAGE}"
cp -r dist "release-upload/${STAGE}/dist"
cp package.json package-lock.json "release-upload/${STAGE}/"
tar -czf "release-upload/${STAGE}.tar.gz" -C release-upload "${STAGE}"
rm -rf "release-upload/${STAGE:?}"
( cd release-upload && sha256sum -- *.tar.gz > SHA256SUMS.txt )
ls -la release-upload
