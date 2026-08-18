import { execFile as execFileCallback } from "node:child_process";
import { rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import type { Logger } from "pino";

import { probeSystemdRunAvailable } from "../lifecycle/process-scope.js";
import {
  checkUnitRegenerationNeeded,
  cutOverStagedRelease,
  deriveInstallPaths
} from "./cutover.js";
import { isNewerVersion, OctokitReleaseClient } from "./release-client.js";
import type { GetLatestReleaseResult } from "./release-client.js";
import {
  downloadAndVerify,
  pruneStaleDownloads,
  pruneStaleStagingDirs,
  stageExtractedRelease
} from "./stage.js";
import type { SelfCheckResult } from "./self-check.js";

const execFile = promisify(execFileCallback);

// Fixed internal cadence, not configurable in this slice -- self_update
// stays a plain boolean (ADR 0079 decision #2).
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_DRAIN_POLL_INTERVAL_MS = 5_000;
const RESTART_TIMEOUT_MS = 10_000;
const SELF_CHECK_TIMEOUT_MS = 60_000;

export type UpdateOps = {
  getLatestRelease(): Promise<GetLatestReleaseResult>;
  downloadAndVerify(
    release: import("./release-client.js").LatestRelease
  ): ReturnType<typeof downloadAndVerify>;
  stageExtractedRelease(
    archivePath: string,
    version: string
  ): ReturnType<typeof stageExtractedRelease>;
  runStagedSelfCheck(
    stagingPath: string,
    version: string
  ): Promise<SelfCheckResult>;
  cutOver(version: string): ReturnType<typeof cutOverStagedRelease>;
  checkUnitRegenerationNeeded(
    stagingPath: string
  ): ReturnType<typeof checkUnitRegenerationNeeded>;
  pruneStale(keepVersion: string | undefined): Promise<void>;
  isSystemdAvailable(): Promise<boolean>;
  restartService(): Promise<void>;
};

export function createDefaultUpdateOps(input: {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  scriptPath: string;
  stateRoot: string;
}): UpdateOps {
  const releaseClient = new OctokitReleaseClient(input.env);
  const { installParentDir } = deriveInstallPaths(input.scriptPath);

  return {
    getLatestRelease: () => releaseClient.getLatestRelease(),
    downloadAndVerify: (release) =>
      downloadAndVerify({ release, stateRoot: input.stateRoot }),
    stageExtractedRelease: (archivePath, version) =>
      stageExtractedRelease({ archivePath, installParentDir, version }),
    runStagedSelfCheck: (stagingPath, version) =>
      runStagedSelfCheck({
        scriptPath: input.scriptPath,
        stagingPath,
        stateRoot: input.stateRoot,
        version
      }),
    cutOver: (version) =>
      cutOverStagedRelease({ scriptPath: input.scriptPath, version }),
    checkUnitRegenerationNeeded: (stagingPath) =>
      checkUnitRegenerationNeeded({
        env: input.env,
        homeDir: input.homeDir,
        stagingPath
      }),
    pruneStale: async (keepVersion) => {
      // Disjoint directory trees -- independently safe to prune concurrently.
      await Promise.all([
        pruneStaleDownloads({ keepVersion, stateRoot: input.stateRoot }),
        pruneStaleStagingDirs({ installParentDir, keepVersion })
      ]);
    },
    isSystemdAvailable: () => probeSystemdRunAvailable({ env: input.env }),
    restartService: async () => {
      // --no-block: this call runs from inside the very unit being
      // restarted, under the default KillMode=control-group, so systemd
      // SIGTERMs the whole cgroup -- daemon and this systemctl child alike
      // -- as part of the restart job. A blocking call would race its own
      // death: the child (and often this very process) can be killed
      // before observing job success, surfacing a spurious update-failed
      // notification for a restart that actually succeeded, or simply
      // never resuming because the calling process is gone. --no-block
      // sidesteps the race by only waiting for systemd to *enqueue* the
      // job, not for it to finish -- which is the most this call could
      // ever meaningfully observe anyway, since the process asking the
      // question is the one about to be replaced. Real post-restart health
      // has to be judged after the fact (daemon-health / systemd's own
      // Restart=on-failure + watchdog), not from this call's result.
      // `timeout` only guards the enqueue step itself hanging (e.g. a
      // wedged --user D-Bus manager), matching every other unattended
      // systemctl call in this codebase (see
      // src/lifecycle/process-scope.ts) -- it does not, and cannot, guard
      // whether the restart job itself later succeeds.
      await execFile(
        "systemctl",
        ["--user", "restart", "--no-block", "symphonika.service"],
        { timeout: RESTART_TIMEOUT_MS }
      );
    }
  };
}

async function runStagedSelfCheck(input: {
  scriptPath: string;
  stagingPath: string;
  stateRoot: string;
  version: string;
}): Promise<SelfCheckResult> {
  const throwawayStateRoot = path.join(
    input.stateRoot,
    "update",
    "self-check",
    `${input.version}-${randomBytes(4).toString("hex")}`
  );
  const cliPath = path.join(input.stagingPath, "dist", "cli.js");
  try {
    await execFile(
      process.execPath,
      [cliPath, "daemon", "--self-check", throwawayStateRoot],
      { timeout: SELF_CHECK_TIMEOUT_MS }
    );
    return { errors: [], ok: true };
  } catch (error) {
    return { errors: [errorMessage(error)], ok: false };
  } finally {
    await rm(throwawayStateRoot, { force: true, recursive: true });
  }
}

export type UpdateCoordinatorInput = {
  activeRuns: { countInFlight(): number };
  checkIntervalMs?: number;
  currentVersion: string;
  daemonHealthNotifier: {
    observeUpdateFailure(input: { broken: boolean; detail?: string }): void;
  };
  drainPollIntervalMs?: number;
  isSelfUpdateEnabled: () => boolean;
  logger?: Logger;
  ops: UpdateOps;
  sleepImpl?: (ms: number) => Promise<void>;
};

// Tick-driven, fire-and-forget state machine (mirrors launchWork's own
// per-tick-promise pattern in src/daemon.ts): idle -> checking -> staging ->
// smoke-checking -> draining -> cutting-over -> restarting. Re-checks
// isSelfUpdateEnabled() at every phase transition so toggling self_update
// to false mid-flight halts before the next phase (SPEC §5.1's defensive
// reload precedent). Any failure clears the drain flag before reporting,
// so a failed update never leaves new dispatch permanently refused.
export class UpdateCoordinator {
  private draining = false;
  private inProgress = false;
  private lastCheckAtMs: number | undefined;

  constructor(private readonly input: UpdateCoordinatorInput) {}

  isDrainRequested(): boolean {
    return this.draining;
  }

  tick(): void {
    if (this.inProgress || !this.input.isSelfUpdateEnabled()) {
      return;
    }
    const checkIntervalMs =
      this.input.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    const now = Date.now();
    if (
      this.lastCheckAtMs !== undefined &&
      now - this.lastCheckAtMs < checkIntervalMs
    ) {
      return;
    }
    this.lastCheckAtMs = now;
    this.inProgress = true;
    void this.runCycle().finally(() => {
      this.inProgress = false;
      this.draining = false;
    });
  }

  private enabled(): boolean {
    return this.input.isSelfUpdateEnabled();
  }

  private async runCycle(): Promise<void> {
    try {
      const latest = await this.input.ops.getLatestRelease();
      if (latest.kind !== "release") {
        // "skipped" (no token) and "error" (API failure) are both
        // non-fatal, retried on the next check cycle -- neither is a
        // reason to page anyone.
        return;
      }
      if (!isNewerVersion(this.input.currentVersion, latest.release.version)) {
        await this.input.ops.pruneStale(undefined);
        return;
      }
      if (!this.enabled()) {
        return;
      }

      const downloaded = await this.input.ops.downloadAndVerify(latest.release);
      if (downloaded.kind !== "verified") {
        throw new Error(
          downloaded.kind === "checksum-mismatch"
            ? `checksum mismatch: expected ${downloaded.expected}, got ${downloaded.actual}`
            : downloaded.error
        );
      }
      if (!this.enabled()) {
        return;
      }

      const staged = await this.input.ops.stageExtractedRelease(
        downloaded.archivePath,
        latest.release.version
      );
      if (staged.kind !== "staged") {
        throw new Error(staged.error);
      }
      if (!this.enabled()) {
        return;
      }

      const smokeCheck = await this.input.ops.runStagedSelfCheck(
        staged.stagingPath,
        latest.release.version
      );
      if (!smokeCheck.ok) {
        throw new Error(
          `staged build failed self-check: ${smokeCheck.errors.join("; ")}`
        );
      }
      if (!this.enabled()) {
        return;
      }

      // From here on, new dispatch is refused (drain gate in
      // src/daemon.ts's launchWork/fireRoutine) until countInFlight()
      // reaches zero. Existing runs are never cancelled -- only new
      // admission is blocked, per decision #2.
      this.draining = true;
      await this.waitForDrain();
      if (!this.enabled()) {
        return;
      }

      const unitCheck = await this.input.ops.checkUnitRegenerationNeeded(
        staged.stagingPath
      );
      if (unitCheck.needed) {
        this.input.logger?.warn(
          { reason: unitCheck.reason },
          "symphonika self-update: unit regeneration recommended"
        );
      }

      const cutOver = await this.input.ops.cutOver(latest.release.version);
      if (cutOver.kind !== "cut-over") {
        throw new Error(
          cutOver.kind === "refused" ? cutOver.reason : cutOver.error
        );
      }

      await this.input.ops.pruneStale(latest.release.version);
      this.input.daemonHealthNotifier.observeUpdateFailure({ broken: false });

      const systemdAvailable = await this.input.ops.isSystemdAvailable();
      if (!systemdAvailable) {
        this.input.logger?.warn(
          "symphonika self-update: cut over to " +
            `${latest.release.version} but no systemd --user session is ` +
            "available; restart the daemon manually to run the new build"
        );
        return;
      }
      await this.input.ops.restartService();
    } catch (error) {
      this.input.daemonHealthNotifier.observeUpdateFailure({
        broken: true,
        detail: errorMessage(error)
      });
      this.input.logger?.error({ err: error }, "symphonika self-update failed");
      // Unlike the up-to-date and post-cutover success paths, a failed
      // cycle never otherwise reaches pruneStale -- without this, a host
      // that keeps failing (e.g. no working native-module toolchain) would
      // accumulate one orphaned download and staging tree per new release
      // indefinitely. Best-effort: a prune failure must never mask the
      // update failure already being reported above.
      try {
        await this.input.ops.pruneStale(undefined);
      } catch (pruneError) {
        this.input.logger?.error(
          { err: pruneError },
          "symphonika self-update: pruning stale artifacts after a failed cycle also failed"
        );
      }
    }
  }

  private async waitForDrain(): Promise<void> {
    const sleep = this.input.sleepImpl ?? defaultSleep;
    const pollIntervalMs =
      this.input.drainPollIntervalMs ?? DEFAULT_DRAIN_POLL_INTERVAL_MS;
    while (this.enabled() && this.input.activeRuns.countInFlight() > 0) {
      await sleep(pollIntervalMs);
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
