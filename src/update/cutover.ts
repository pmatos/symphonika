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

  const orphanedPreviousPath = `${previousPath}.orphaned`;

  // Self-heal a leftover from a hard crash (SIGKILL, power loss -- not
  // anything this module's own try/catch could trap) partway through an
  // earlier attempt's rename-aside-then-restore-or-remove dance below. Its
  // mere presence is the only signal available: if previousPath was
  // already recreated since (a later attempt completed), the orphan is
  // stale and gets discarded; otherwise it IS the real previous
  // generation and gets restored before this attempt proceeds.
  if (await pathExists(orphanedPreviousPath)) {
    if (await pathExists(previousPath)) {
      await rm(orphanedPreviousPath, { force: true, recursive: true });
    } else {
      await rename(orphanedPreviousPath, previousPath);
    }
  }

  // Exactly one prior generation is kept: a second successful cutover
  // replaces the older .previous rather than attempting rename() onto an
  // existing non-empty directory, which fails with ENOTEMPTY/EEXIST. The
  // older generation is moved aside (not deleted) before either swap
  // rename runs, and only removed once both renames have succeeded -- so a
  // failure partway through (e.g. rename(installPath, previousPath)
  // throwing EPERM/EBUSY) never destroys the one rollback generation the
  // operator still has, even though no cutover actually happened.
  let hadPreviousGeneration = true;
  try {
    await rename(previousPath, orphanedPreviousPath);
  } catch {
    hadPreviousGeneration = false;
  }

  try {
    await rename(installPath, previousPath);
    await rename(stagingPath, installPath);
  } catch (error) {
    // Best-effort: restore the prior generation to its expected path so a
    // failed cutover doesn't also strand it under a name
    // `symphonika service rollback` doesn't know to look for.
    if (hadPreviousGeneration) {
      await rename(orphanedPreviousPath, previousPath).catch(() => undefined);
    }
    return { kind: "error", error: errorMessage(error) };
  }

  if (hadPreviousGeneration) {
    await rm(orphanedPreviousPath, { force: true, recursive: true });
  }

  return { kind: "cut-over", installPath };
}

async function refuseIfGitCheckout(
  installPath: string
): Promise<string | undefined> {
  try {
    await access(path.join(installPath, ".git"));
  } catch (error) {
    // ENOENT (no .git present) is the only outcome that means "safe to
    // proceed". Any other error (e.g. EACCES) is indistinguishable from
    // "yes, .git is there" as far as this safety check can tell, so it
    // must fail closed and refuse rather than silently permit a cutover
    // that could rename aside a live development checkout.
    if (isEnoent(error)) {
      return undefined;
    }
    return (
      `refusing to cut over: could not determine whether ${installPath} is ` +
      `a development checkout (${errorMessage(error)}); resolve the error ` +
      "and retry"
    );
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

  // Same guard cutOverStagedRelease applies: a `.previous` directory next
  // to a development checkout (leftover from an earlier real install/
  // rollback test, or a misresolved scriptPath) must not be silently
  // rotated in over a live working tree.
  const gitGuardReason = await refuseIfGitCheckout(installPath);
  if (gitGuardReason !== undefined) {
    return { kind: "error", error: gitGuardReason };
  }

  if (!(await pathExists(previousPath))) {
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
  /^TimeoutStartSec=.*$/m,
  // Name only, no value: the env-file path is baked from the install-time
  // config selection (`--config` / XDG_CONFIG_HOME), so comparing values
  // would flag every `--config` install as template drift. Presence is the
  // structural signal -- a unit installed before the env file existed has
  // no EnvironmentFile= line at all.
  /^EnvironmentFile=/m
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

  const differs = STRUCTURAL_MARKERS.some(
    (pattern) =>
      pattern.exec(stagedUnitContent)?.[0] !==
      pattern.exec(installedUnitContent)?.[0]
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
// "# <path>\n<content>\n". Select the section by matching its header path
// against "symphonika.service" rather than assuming file order -- that
// decouples this parser from runServiceInstall's internal file-list
// ordering entirely.
//
// The header line is always an absolute path (`# ${file.path}`), so the
// split pattern requires a "/" right after "# " -- otherwise the rendered
// unit's own embedded "# ..." comment lines (renderServiceUnit in
// src/service.ts is full of them) match too, splitting mid-section instead
// of only at file headers.
function extractServiceUnitSection(printOutput: string): string | undefined {
  const parts = printOutput.split(/^(# \/.*)$/m);
  for (let index = 1; index < parts.length; index += 2) {
    if (parts[index]!.endsWith("symphonika.service")) {
      return parts[index + 1]?.trim();
    }
  }
  return undefined;
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

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
