import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { LatestRelease } from "./release-client.js";

const execFile = promisify(execFileCallback);

// Narrower than `typeof fetch`: this module only ever calls with a plain
// string URL, so the injectable seam is just that -- easier to fake in
// tests than the full string|URL|Request overload set.
export type FetchFn = (url: string) => Promise<Response>;

export type DownloadAndVerifyResult =
  | { kind: "verified"; archivePath: string }
  | { kind: "checksum-mismatch"; expected: string; actual: string }
  | { kind: "error"; error: string };

// Download scratch + checksum-verification evidence live under
// <stateRoot>/update/download/<version>/ -- small, disposable, and separate
// from the staging TREE (stageExtractedRelease, below), which must be a
// sibling of the install directory so its final rename into place (ADR
// 0079's cutover) stays on one filesystem. state.root is operator-
// configurable and not guaranteed to share a filesystem with the install
// path (SPEC §7.1), so only this disposable evidence lives there.
export async function downloadAndVerify(input: {
  release: LatestRelease;
  stateRoot: string;
  fetchImpl?: FetchFn;
}): Promise<DownloadAndVerifyResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const downloadDir = path.join(
    input.stateRoot,
    "update",
    "download",
    input.release.version
  );
  await mkdir(downloadDir, { recursive: true });
  const archivePath = path.join(downloadDir, input.release.tarballAsset.name);

  let tarballBytes: Buffer;
  try {
    const response = await fetchImpl(input.release.tarballAsset.url);
    if (!response.ok) {
      return {
        kind: "error",
        error: `download failed: HTTP ${response.status} for ${input.release.tarballAsset.url}`
      };
    }
    tarballBytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return {
      kind: "error",
      error: `download failed: ${errorMessage(error)}`
    };
  }

  let checksumsText: string;
  try {
    const response = await fetchImpl(input.release.checksumsAsset.url);
    if (!response.ok) {
      return {
        kind: "error",
        error: `checksum download failed: HTTP ${response.status} for ${input.release.checksumsAsset.url}`
      };
    }
    checksumsText = await response.text();
  } catch (error) {
    return {
      kind: "error",
      error: `checksum download failed: ${errorMessage(error)}`
    };
  }

  const expectedHex = parseChecksum(
    checksumsText,
    input.release.tarballAsset.name
  );
  if (expectedHex === undefined) {
    return {
      kind: "error",
      error: `${input.release.checksumsAsset.name} has no entry for ${input.release.tarballAsset.name}`
    };
  }

  const actualHex = createHash("sha256").update(tarballBytes).digest("hex");
  if (actualHex !== expectedHex) {
    return {
      kind: "checksum-mismatch",
      expected: expectedHex,
      actual: actualHex
    };
  }

  // Only written to disk once verified: a checksum failure never leaves a
  // downloaded artifact behind for a later step to accidentally trust.
  await writeFile(archivePath, tarballBytes);
  return { kind: "verified", archivePath };
}

// sha256sum's own output format: "<hex>  <filename>" (or "<hex> *<filename>"
// for binary mode), one entry per line. Deliberately NOT reshaping
// src/content-hash.ts's `contentHash` (its "sha256:<hex>" convention is for
// a different call site -- string content hashing, not binary checksum
// verification against a third-party tool's output format).
function parseChecksum(
  checksumsText: string,
  fileName: string
): string | undefined {
  for (const line of checksumsText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(trimmed);
    if (match !== null && match[2] === fileName) {
      return match[1]!.toLowerCase();
    }
  }
  return undefined;
}

export type StageResult =
  { kind: "staged"; stagingPath: string } | { kind: "error"; error: string };

export type ExtractTarballFn = (input: {
  archivePath: string;
  destDir: string;
}) => Promise<void>;
export type RunNpmCiFn = (cwd: string) => Promise<void>;

export function stagingDirName(version: string): string {
  return `.symphonika-staging-${version}`;
}

// Stages the extracted, npm-ci'd tree as a SIBLING of the install directory
// (installParentDir is <install>'s parent), never under state.root -- see
// downloadAndVerify's comment on why. Always wipes and rebuilds the staging
// tree fresh from the already checksum-verified archive rather than trying
// to trust a possibly-partial tree left by an earlier crash: extraction +
// npm ci is a local, no-network operation, so there is no cost worth paying
// to make partial-tree resumption safe.
export async function stageExtractedRelease(input: {
  archivePath: string;
  version: string;
  installParentDir: string;
  extractTarball?: ExtractTarballFn;
  runNpmCi?: RunNpmCiFn;
}): Promise<StageResult> {
  const stagingPath = path.join(
    input.installParentDir,
    stagingDirName(input.version)
  );
  const extractTarball = input.extractTarball ?? defaultExtractTarball;
  const runNpmCi = input.runNpmCi ?? defaultRunNpmCi;

  await rm(stagingPath, { force: true, recursive: true });
  await mkdir(stagingPath, { recursive: true });

  try {
    await extractTarball({
      archivePath: input.archivePath,
      destDir: stagingPath
    });
  } catch (error) {
    return {
      kind: "error",
      error: `extraction failed: ${errorMessage(error)}`
    };
  }

  try {
    await runNpmCi(stagingPath);
  } catch (error) {
    return { kind: "error", error: `npm ci failed: ${errorMessage(error)}` };
  }

  return { kind: "staged", stagingPath };
}

// `tar` is a universal system utility present on any host this daemon can
// realistically run on (unlike `npm`, whose location is version-manager-
// specific), so it resolves via PATH -- but ENOENT is translated into an
// explicit message rather than left as a bare spawn error.
async function defaultExtractTarball(input: {
  archivePath: string;
  destDir: string;
}): Promise<void> {
  try {
    await execFile("tar", [
      "-xzf",
      input.archivePath,
      "-C",
      input.destDir,
      // release.yml packages a single top-level symphonika-<version>/
      // directory; strip it so files land directly under destDir.
      "--strip-components=1"
    ]);
  } catch (error) {
    if (isEnoent(error)) {
      throw new Error("tar not found on PATH; cannot extract release archive", {
        cause: error
      });
    }
    throw error;
  }
}

// The daemon's own ExecStart PATH is baked in at `service install` time
// (buildDaemonPath, src/service.ts:176) and may not carry a usable `npm`.
// Resolve it explicitly next to the running node binary -- the same
// directory an npm-managed install normally ships npm alongside node --
// rather than relying on PATH lookup.
async function defaultRunNpmCi(cwd: string): Promise<void> {
  const npmPath = resolveNpmPath();
  try {
    await execFile(npmPath, ["ci", "--omit=dev"], { cwd });
  } catch (error) {
    if (isEnoent(error)) {
      throw new Error(`no npm found next to node at ${npmPath}`, {
        cause: error
      });
    }
    throw error;
  }
}

function resolveNpmPath(): string {
  const nodeDir = path.dirname(process.execPath);
  return path.join(nodeDir, process.platform === "win32" ? "npm.cmd" : "npm");
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

// Called each check cycle so abandoned/superseded download and staging
// directories from earlier attempts don't accumulate unboundedly.
// keepVersion === undefined prunes everything (used once no update is
// in flight at all).
export async function pruneStaleDownloads(input: {
  stateRoot: string;
  keepVersion: string | undefined;
}): Promise<void> {
  const downloadRoot = path.join(input.stateRoot, "update", "download");
  await pruneSiblings(downloadRoot, (name) =>
    name !== input.keepVersion ? name : undefined
  );
}

export async function pruneStaleStagingDirs(input: {
  installParentDir: string;
  keepVersion: string | undefined;
}): Promise<void> {
  const stalePattern = /^\.symphonika-staging-(.+)$/;
  await pruneSiblings(input.installParentDir, (name) => {
    const match = stalePattern.exec(name);
    if (match === null || match[1] === input.keepVersion) {
      return undefined;
    }
    return name;
  });
}

async function pruneSiblings(
  root: string,
  matchStale: (name: string) => string | undefined
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .map((name) => matchStale(name))
      .filter((name): name is string => name !== undefined)
      .map((name) =>
        rm(path.join(root, name), { force: true, recursive: true })
      )
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
