import path from "node:path";

import type { DoctorProjectReport, DoctorReport } from "./doctor.js";
import type { IssuePollStatus } from "./issue-polling.js";
import type { RuntimeReloadStatus } from "./reload.js";
import type { ProjectState, RunStatus, RunStore } from "./run-store.js";
import {
  planWorkspacePaths,
  type WorkspacePathInputs
} from "./workspace-paths.js";

export type StatusSnapshot = {
  configPath: string;
  doctorErrors: string[];
  issuePolling: IssuePollStatus;
  projectStates: ProjectState[];
  projects: DoctorProjectReport[];
  reload: RuntimeReloadStatus;
  runs: {
    active: RunStatus[];
    failed: RunStatus[];
    recent: RunStatus[];
    stale: RunStatus[];
  };
  stateRoot: string;
};

export type BuildStatusSnapshotInput = {
  configDir?: string;
  configPath: string;
  doctorReport?: DoctorReport;
  issuePollStatus: IssuePollStatus;
  projectsByName?: ReadonlyMap<string, WorkspacePathInputs["project"]>;
  reloadStatus?: RuntimeReloadStatus;
  runStore: RunStore;
  stateRoot: string;
};

const ACTIVE_STATES = new Set([
  "queued",
  "preparing_workspace",
  "running",
  "waiting"
]);

export function buildStatusSnapshot(
  input: BuildStatusSnapshotInput
): StatusSnapshot {
  const allRuns = input.runStore
    .listRuns()
    .map((run) => fillMissingWorkspacePlan(run, input));
  const active = allRuns.filter((run) => ACTIVE_STATES.has(run.state));
  const failed = allRuns.filter((run) => run.state === "failed");
  const stale = allRuns.filter((run) => run.state === "stale");
  const recent = allRuns
    .filter((run) => run.state === "succeeded" || run.state === "cancelled")
    .slice(0, 20);

  return {
    configPath: input.configPath,
    doctorErrors: input.doctorReport?.errors ?? [],
    issuePolling: input.issuePollStatus,
    projectStates: input.runStore.listProjectStates(),
    projects: input.doctorReport?.projects ?? [],
    reload: input.reloadStatus ?? emptyReloadStatus(),
    runs: {
      active,
      failed,
      recent,
      stale
    },
    stateRoot: input.stateRoot
  };
}

function fillMissingWorkspacePlan(
  run: RunStatus,
  input: BuildStatusSnapshotInput
): RunStatus {
  if (run.branchName.length > 0 && run.workspacePath.length > 0) {
    return run;
  }
  const project = input.projectsByName?.get(run.project);
  if (project === undefined) {
    return run;
  }
  const plan = planWorkspacePaths({
    configDir: input.configDir ?? path.dirname(input.configPath),
    issue: {
      number: run.issueNumber,
      title: run.issueTitle
    },
    project
  });
  return {
    ...run,
    branchName: run.branchName.length === 0 ? plan.branchName : run.branchName,
    workspacePath:
      run.workspacePath.length === 0 ? plan.workspacePath : run.workspacePath
  };
}

function emptyReloadStatus(): RuntimeReloadStatus {
  return {
    errors: [],
    lastAttemptedAt: null,
    lastLoadedAt: null,
    ok: true,
    usingLastKnownGood: false
  };
}
