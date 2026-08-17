import { execFile as execFileCallback } from "node:child_process";
import { access, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { userUnitDir } from "../service.js";
import { stagingDirName } from "./stage.js";

const execFile = promisify(execFileCallback);

export type InstallPaths = {
  installPath: string;
  installParentDir: string;
  previousPath: string;
};

// <install> is dirname(dirname(scriptPath)) -- scriptPath is the resolved
// dist/cli.js the running daemon was launched from (mirrors
// defaultScriptPath's own import.meta.url resolution in src/service.ts:364,
// itself the mechanism ADR 0055 chose to avoid a hardcoded install layout).
// No new config field: keeps self_update boolean-only (ADR 0079 decision #2).
export function deriveInstallPaths(scriptPath: string): InstallPaths {
  const installPath = path.dirname(path.dirname(scriptPath));
  const installParentDir = path.dirname(installPath);
  return {
    installPath,
    installParentDir,
    // A sibling with a suffixed name, NOT a subdirectory of installPath --
    // renaming a directory into its own subdirectory is invalid.
    previousPath: `${installPath}.previous`
  };
}

export type CutoverResult =
  | { kind: "cut-over"; installPath: string }
  | { kind: "refused"; reason: string }
  | { kind: "error"; error: string };

// Cuts a staged, already checksum-verified and smoke-checked tree into the
// live install path. Two rename()s, each atomic on the same filesystem
// (mirrors src/http/save-pipeline.ts's writeFileAtomic same-directory-
// rename idiom, scaled from a file to a directory): (1) installPath ->
// previousPath, (2) stagingPath -> installPath. Ordering means a crash
// between the two leaves the OLD build fully intact under previousPath and
// no installPath -- recoverable via `symphonika service rollback` -- never
// a half-written installPath.
export async function cutOverStagedRelease(input: {
  scriptPath: string;
  version: string;
}): Promise<CutoverResult> {
  const { installPath, installParentDir, previousPath } = deriveInstallPaths(
    input.scriptPath
  );
  const stagingPath = path.join(
    installParentDir,
    stagingDirName(input.version)
  );

  const gitGuardReason = await refuseIfGitCheckout(installPath);
  if (gitGuardReason !== undefined) {
    return { kind: "refused", reason: gitGuardReason };
  }

  try {
    // Exactly one prior generation is kept: a second successful cutover
    // replaces the older .previous rather than attempting rename() onto an
    // existing non-empty directory, which fails with ENOTEMPTY/EEXIST.
    await rm(previousPath, { force: true, recursive: true });
    await rename(installPath, previousPath);
    await rename(stagingPath, installPath);
  } catch (error) {
    return { kind: "error", error: errorMessage(error) };
  }

  return { kind: "cut-over", installPath };
}

async function refuseIfGitCheckout(
  installPath: string
): Promise<string | undefined> {
  try {
    await access(path.join(installPath, ".git"));
  } catch {
    return undefined;
  }
  return (
    `refusing to cut over: ${installPath} contains .git -- this looks like ` +
    "a development checkout, not an installed release, and cutover would " +
    "rename the working tree aside. Self-update only targets a release install."
  );
}

export type RollbackResult =
  | { kind: "rolled-back"; installPath: string }
  | { kind: "no-previous-generation" }
  | { kind: "error"; error: string };

// Manual recovery: swaps .previous back into place. The broken installPath
// is kept aside (suffixed .failed, itself rotated the same way .previous
// is) rather than deleted -- forensic value over reversibility isn't a
// tradeoff worth making for a rarely-invoked recovery command.
export async function rollbackToPreviousRelease(
  scriptPath: string
): Promise<RollbackResult> {
  const { installPath, previousPath } = deriveInstallPaths(scriptPath);
  const failedPath = `${installPath}.failed`;

  let previousExists = true;
  try {
    await access(previousPath);
  } catch {
    previousExists = false;
  }
  if (!previousExists) {
    return { kind: "no-previous-generation" };
  }

  try {
    await rm(failedPath, { force: true, recursive: true });
    await rename(installPath, failedPath);
    await rename(previousPath, installPath);
  } catch (error) {
    return { kind: "error", error: errorMessage(error) };
  }

  return { kind: "rolled-back", installPath };
}

// Structural markers only (mirrors src/doctor.ts's checkInstalledUnitDrift:
// it deliberately can't byte-compare whole unit files, since ExecStart/PATH
// are baked in from install-time environment). This answers a narrower
// question than doctor's drift check: not "has the installed unit rotted",
// but "does the STAGED build's own rendered unit differ from what's
// installed" -- the signal that a release changed the unit template itself,
// distinct from an ordinary content-only release that needs no unit change
// at all (ADR 0079 decision #3).
const STRUCTURAL_MARKERS: readonly RegExp[] = [
  /^Slice=.*$/m,
  /^Type=.*$/m,
  /^NotifyAccess=.*$/m,
  /^WatchdogSec=.*$/m,
  /^TimeoutStartSec=.*$/m
];

export type UnitRegenerationCheck =
  { needed: true; reason: string } | { needed: false };

// Never blocks cutover -- only logs a recommendation. Any failure to
// determine the staged unit's content (spawn failure, no installed unit
// yet, unparseable --print output) is treated as "not needed" rather than
// surfaced as an error, since this check's only effect is an operator
// hint, not a safety gate.
export async function checkUnitRegenerationNeeded(input: {
  stagingPath: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  runStagedServiceInstallPrint?: (stagingPath: string) => Promise<string>;
}): Promise<UnitRegenerationCheck> {
  const runPrint =
    input.runStagedServiceInstallPrint ?? defaultRunStagedServiceInstallPrint;

  const installedUnitPath = path.join(
    userUnitDir(input.homeDir, input.env),
    "symphonika.service"
  );
  let installedUnitContent: string;
  try {
    installedUnitContent = await readFile(installedUnitPath, "utf8");
  } catch {
    return { needed: false };
  }

  let stagedOutput: string;
  try {
    stagedOutput = await runPrint(input.stagingPath);
  } catch {
    return { needed: false };
  }
  const stagedUnitContent = extractServiceUnitSection(stagedOutput);
  if (stagedUnitContent === undefined) {
    return { needed: false };
  }

  const stagedMarkers = STRUCTURAL_MARKERS.map(
    (pattern) => pattern.exec(stagedUnitContent)?.[0]
  );
  const installedMarkers = STRUCTURAL_MARKERS.map(
    (pattern) => pattern.exec(installedUnitContent)?.[0]
  );
  const differs = stagedMarkers.some(
    (value, index) => value !== installedMarkers[index]
  );

  return differs
    ? {
        needed: true,
        reason:
          "the new release's systemd unit template differs from the " +
          "installed unit; run `symphonika service install --force` and " +
          "`systemctl --user restart symphonika.service` after this update"
      }
    : { needed: false };
}

// `service install --print` (src/cli.ts) writes each file as
// "# <path>\n<content>\n". The .service unit is written first
// (runServiceInstall's file order); take the first section only.
function extractServiceUnitSection(printOutput: string): string | undefined {
  const sections = printOutput.split(/^# .*$/m).slice(1);
  return sections[0]?.trim();
}

async function defaultRunStagedServiceInstallPrint(
  stagingPath: string
): Promise<string> {
  const cliPath = path.join(stagingPath, "dist", "cli.js");
  const { stdout } = await execFile(process.execPath, [
    cliPath,
    "service",
    "install",
    "--print"
  ]);
  return stdout;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
