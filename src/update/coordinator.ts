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
// A forced cycle reports its outcome to an operator waiting on
// `symphonika update`, and the restart it then requests SIGTERMs this
// process's whole cgroup (see restartService below). Pausing between the
// two lets the /api/update-now response reach the CLI first, so the
// operator sees "updated X -> Y" instead of a dropped connection.
const DEFAULT_FORCED_RESTART_GRACE_MS = 500;

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
      // narrows this race to the enqueue round trip but cannot close it:
      // systemd can still SIGTERM the child before it reports success. The
      // coordinator therefore treats that signal after a completed cutover
      // as the expected unit-shutdown path. Real post-restart health has to
      // be judged after the fact (daemon-health / systemd's own
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
  forcedRestartGraceMs?: number;
  isSelfUpdateEnabled: () => boolean;
  logger?: Logger;
  ops: UpdateOps;
  sleepImpl?: (ms: number) => Promise<void>;
};

// The phase a cycle was entering when `self_update` was toggled off
// mid-flight, so a halted forced run says where it stopped.
export type UpdatePhase =
  "cutting-over" | "draining" | "smoke-checking" | "staging";

// Outcome vocabulary for an operator-forced cycle (`symphonika update`).
// Every branch a cycle can end -- or pause observably -- at gets its own
// variant, so the CLI never has to infer "nothing happened" from silence;
// that ambiguity is what #582 set out to remove.
export type UpdateActionResult =
  | { kind: "disabled" }
  | { kind: "in-progress" }
  | { kind: "up-to-date"; version: string }
  | {
      currentVersion: string;
      kind: "available";
      latestVersion: string;
      selfUpdateEnabled: boolean;
    }
  | { kind: "skipped"; reason: string }
  | { kind: "halted"; phase: UpdatePhase }
  | {
      fromVersion: string;
      inFlight: number;
      kind: "draining";
      toVersion: string;
    }
  | {
      fromVersion: string;
      kind: "updated";
      restart: "requested" | "unavailable";
      toVersion: string;
    }
  | { kind: "refused"; reason: string }
  | { kind: "error"; error: string };

type ReportOutcome = (outcome: UpdateActionResult) => void;

const noReport: ReportOutcome = () => {};

// Fire-and-forget state machine (mirrors launchWork's own per-tick-promise
// pattern in src/daemon.ts): idle -> checking -> staging -> smoke-checking
// -> draining -> cutting-over -> restarting. Re-checks
// isSelfUpdateEnabled() at every phase transition so toggling self_update
// to false mid-flight halts before the next phase (SPEC §5.1's defensive
// reload precedent). Any failure clears the drain flag before reporting,
// so a failed update never leaves new dispatch permanently refused.
//
// Two drivers share that one machine: tick() on the daemon's poll interval
// (rate-limited to checkIntervalMs), and runNow() for an operator-forced
// `symphonika update`. They differ only in what the cycle does with its
// outcome -- a tick logs and notifies, a forced run additionally reports
// each branch back to its caller -- so there is exactly one ladder to keep
// correct.
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
    void this.runCycle({ forced: false, report: noReport }).finally(() => {
      this.inProgress = false;
      this.draining = false;
    });
  }

  // Operator-forced cycle (`symphonika update`), bypassing the check
  // interval that otherwise makes a fresh release invisible for up to six
  // hours. Resolves at the cycle's first reportable checkpoint rather than
  // at its end: a cycle that reaches the drain gate with work in flight can
  // legitimately run for hours, and blocking the caller for that whole
  // window would be indistinguishable from a hang. The cycle itself always
  // runs to completion in the background, exactly as a tick-driven one does.
  runNow(): Promise<UpdateActionResult> {
    if (!this.enabled()) {
      return Promise.resolve({ kind: "disabled" });
    }
    if (this.inProgress) {
      return Promise.resolve({ kind: "in-progress" });
    }
    this.lastCheckAtMs = Date.now();
    this.inProgress = true;

    let settle: ReportOutcome | undefined;
    const reported = new Promise<UpdateActionResult>((resolve) => {
      settle = resolve;
    });
    const report: ReportOutcome = (outcome) => {
      settle?.(outcome);
      settle = undefined;
    };

    void this.runCycle({ forced: true, report }).finally(() => {
      this.inProgress = false;
      this.draining = false;
      // Safety net only: runCycle catches everything and reports on every
      // exit path, so this fires only if a later edit adds one that does
      // not. Reporting a generic error beats leaving the caller hanging.
      report({
        error: "update cycle finished without reporting an outcome",
        kind: "error"
      });
    });

    return reported;
  }

  // Dry run for `symphonika update --check`: answers "is there a newer
  // release?" without downloading, staging, or cutting anything over.
  // Deliberately ignores `self_update` -- knowing an update exists is
  // useful precisely when auto-update is off -- and reports the flag's
  // state instead so the caller can say why nothing would happen.
  async checkNow(): Promise<UpdateActionResult> {
    const latest = await this.input.ops.getLatestRelease();
    if (latest.kind !== "release") {
      return this.reportUnavailableRelease(latest);
    }
    if (!isNewerVersion(this.input.currentVersion, latest.release.version)) {
      return { kind: "up-to-date", version: this.input.currentVersion };
    }
    return {
      currentVersion: this.input.currentVersion,
      kind: "available",
      latestVersion: latest.release.version,
      selfUpdateEnabled: this.enabled()
    };
  }

  private enabled(): boolean {
    return this.input.isSelfUpdateEnabled();
  }

  // "skipped" (no token) and "error" (API failure) are both non-fatal and
  // retried on the next check cycle -- neither is a reason to page anyone,
  // so they stay out of DaemonHealthNotifier. They do get logged: before
  // #582 they returned in silence, which made "no token configured" and
  // "nothing to do" indistinguishable in the journal.
  private reportUnavailableRelease(
    result: Exclude<GetLatestReleaseResult, { kind: "release" }>
  ): UpdateActionResult {
    if (result.kind === "skipped") {
      this.input.logger?.warn(
        { reason: result.reason },
        "symphonika self-update: release check skipped"
      );
      return { kind: "skipped", reason: result.reason };
    }
    this.input.logger?.warn(
      { error: result.error },
      "symphonika self-update: release check failed"
    );
    return { error: result.error, kind: "error" };
  }

  private async runCycle(options: {
    forced: boolean;
    report: ReportOutcome;
  }): Promise<void> {
    try {
      const latest = await this.input.ops.getLatestRelease();
      if (latest.kind !== "release") {
        options.report(this.reportUnavailableRelease(latest));
        return;
      }
      if (!isNewerVersion(this.input.currentVersion, latest.release.version)) {
        await this.input.ops.pruneStale(undefined);
        options.report({
          kind: "up-to-date",
          version: this.input.currentVersion
        });
        return;
      }
      if (!this.enabled()) {
        options.report({ kind: "halted", phase: "staging" });
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
        options.report({ kind: "halted", phase: "staging" });
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
        options.report({ kind: "halted", phase: "smoke-checking" });
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
        options.report({ kind: "halted", phase: "draining" });
        return;
      }

      // From here on, new dispatch is refused (drain gate in
      // src/daemon.ts's launchWork/fireRoutine) until countInFlight()
      // reaches zero. Existing runs are never cancelled -- only new
      // admission is blocked, per decision #2.
      this.draining = true;
      const inFlight = this.input.activeRuns.countInFlight();
      if (inFlight > 0) {
        // The one non-terminal checkpoint: a forced run answers here
        // instead of holding the operator's terminal open for however long
        // the live runs take.
        options.report({
          fromVersion: this.input.currentVersion,
          inFlight,
          kind: "draining",
          toVersion: latest.release.version
        });
      }
      await this.waitForDrain();
      if (!this.enabled()) {
        options.report({ kind: "halted", phase: "cutting-over" });
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
        if (cutOver.kind === "refused") {
          // Reported apart from "error": a refusal (the install path is a
          // git checkout, say) is a stable condition the operator has to
          // resolve, not a transient failure that a retry might clear. It
          // still travels the failure path below, so DaemonHealthNotifier
          // sees exactly what it saw before #582.
          options.report({ kind: "refused", reason: cutOver.reason });
        }
        throw new Error(
          cutOver.kind === "refused" ? cutOver.reason : cutOver.error
        );
      }

      await this.input.ops.pruneStale(latest.release.version);
      this.input.daemonHealthNotifier.observeUpdateFailure({ broken: false });

      const systemdAvailable = await this.input.ops.isSystemdAvailable();
      options.report({
        fromVersion: this.input.currentVersion,
        kind: "updated",
        restart: systemdAvailable ? "requested" : "unavailable",
        toVersion: latest.release.version
      });
      if (!systemdAvailable) {
        this.input.logger?.warn(
          "symphonika self-update: cut over to " +
            `${latest.release.version} but no systemd --user session is ` +
            "available; restart the daemon manually to run the new build"
        );
        return;
      }
      if (options.forced) {
        await this.sleep(
          this.input.forcedRestartGraceMs ?? DEFAULT_FORCED_RESTART_GRACE_MS
        );
      }
      try {
        await this.input.ops.restartService();
      } catch (error) {
        if (wasTerminatedByExternalSignal(error, "SIGTERM")) {
          this.input.logger?.info(
            { err: error },
            "symphonika self-update: restart request interrupted by expected unit shutdown after successful cutover"
          );
        } else {
          this.input.logger?.warn(
            { err: error },
            "symphonika self-update: automatic restart request failed after successful cutover; restart the daemon manually to run the new build"
          );
        }
      }
    } catch (error) {
      options.report({ error: errorMessage(error), kind: "error" });
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
    const pollIntervalMs =
      this.input.drainPollIntervalMs ?? DEFAULT_DRAIN_POLL_INTERVAL_MS;
    while (this.enabled() && this.input.activeRuns.countInFlight() > 0) {
      await this.sleep(pollIntervalMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return (this.input.sleepImpl ?? defaultSleep)(ms);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wasTerminatedByExternalSignal(
  error: unknown,
  signal: NodeJS.Signals
): boolean {
  return (
    error instanceof Error &&
    "killed" in error &&
    error.killed === false &&
    "signal" in error &&
    error.signal === signal
  );
}
