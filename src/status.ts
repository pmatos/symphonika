import type { DoctorProjectReport, DoctorReport } from "./doctor.js";
import type { IssuePollStatus } from "./issue-polling.js";
import type { RunStatus, RunStore } from "./run-store.js";

export type StatusSnapshot = {
  configPath: string;
  doctorErrors: string[];
  issuePolling: IssuePollStatus;
  projects: DoctorProjectReport[];
  runs: {
    active: RunStatus[];
    failed: RunStatus[];
    recent: RunStatus[];
    stale: RunStatus[];
  };
  stateRoot: string;
};

export type BuildStatusSnapshotInput = {
  configPath: string;
  doctorReport?: DoctorReport;
  issuePollStatus: IssuePollStatus;
  runStore: RunStore;
  stateRoot: string;
};

const ACTIVE_STATES = new Set([
  "queued",
  "preparing_workspace",
  "running",
  "input_required"
]);

export function buildStatusSnapshot(
  input: BuildStatusSnapshotInput
): StatusSnapshot {
  const allRuns = input.runStore.listRuns();
  const active = allRuns.filter((run) => ACTIVE_STATES.has(run.state));
  const failed = allRuns.filter((run) => run.state === "failed");
  const stale = allRuns.filter((run) => run.state === "stale");
  const recent = allRuns
    .filter(
      (run) => run.state === "succeeded" || run.state === "cancelled"
    )
    .slice(0, 20);

  return {
    configPath: input.configPath,
    doctorErrors: input.doctorReport?.errors ?? [],
    issuePolling: input.issuePollStatus,
    projects: input.doctorReport?.projects ?? [],
    runs: {
      active,
      failed,
      recent,
      stale
    },
    stateRoot: input.stateRoot
  };
}
