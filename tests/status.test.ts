import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { IssueSnapshot, IssuePollStatus } from "../src/issue-polling.js";
import { openRunStore } from "../src/run-store.js";
import { buildStatusSnapshot } from "../src/status.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-status-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

function sampleIssue(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    body: "",
    created_at: "",
    id: 1,
    labels: [],
    number: 1,
    priority: 99,
    state: "open",
    title: "issue",
    updated_at: "",
    url: "",
    ...overrides
  };
}

function emptyPollStatus(): IssuePollStatus {
  return {
    candidateIssues: [],
    errors: [],
    filteredIssues: [],
    projects: []
  };
}

describe("buildStatusSnapshot", () => {
  it("groups runs by lifecycle state", async () => {
    const stateRoot = await makeTempRoot();
    const runStore = openRunStore({ stateRoot });
    try {
      runStore.createRun({
        id: "r-active",
        issue: sampleIssue({ number: 10 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      runStore.updateRunState("r-active", "running");
      runStore.createRun({
        id: "r-recent",
        issue: sampleIssue({ number: 11 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      runStore.updateRunState("r-recent", "succeeded");
      runStore.createRun({
        id: "r-failed",
        issue: sampleIssue({ number: 12 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      runStore.updateRunState("r-failed", "failed");
      runStore.createRun({
        id: "r-stale",
        issue: sampleIssue({ number: 13 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      runStore.updateRunState("r-stale", "stale");

      const snapshot = buildStatusSnapshot({
        configPath: "/tmp/symphonika.yml",
        issuePollStatus: emptyPollStatus(),
        runStore,
        stateRoot
      });

      expect(snapshot.runs.active.map((r) => r.id)).toEqual(["r-active"]);
      expect(snapshot.runs.recent.map((r) => r.id)).toEqual(["r-recent"]);
      expect(snapshot.runs.failed.map((r) => r.id)).toEqual(["r-failed"]);
      expect(snapshot.runs.stale.map((r) => r.id)).toEqual(["r-stale"]);
      expect(snapshot.projects).toEqual([]);
      expect(snapshot.doctorErrors).toEqual([]);
    } finally {
      runStore.close();
    }
  });

  it("includes durable project cursor state", async () => {
    const stateRoot = await makeTempRoot();
    const runStore = openRunStore({ stateRoot });
    try {
      runStore.syncProjectStates([{ name: "alpha", weight: 3 }]);
      runStore.recordProjectPollOutcome({
        candidateIssues: 1,
        fetchedIssues: 2,
        filteredIssues: 1,
        ok: true,
        projectName: "alpha"
      });

      const snapshot = buildStatusSnapshot({
        configPath: "/tmp/symphonika.yml",
        issuePollStatus: emptyPollStatus(),
        runStore,
        stateRoot
      });

      expect(snapshot.projectStates).toHaveLength(1);
      expect(snapshot.projectStates[0]).toMatchObject({
        lastCandidateIssues: 1,
        lastFetchedIssues: 2,
        lastFilteredIssues: 1,
        lastPollOk: true,
        projectName: "alpha",
        validationState: "valid",
        weight: 3
      });
    } finally {
      runStore.close();
    }
  });

  it("fills missing run branch and workspace fields from the deterministic path plan", async () => {
    const stateRoot = await makeTempRoot();
    const configDir = await makeTempRoot();
    const runStore = openRunStore({ stateRoot });
    try {
      runStore.createRun({
        id: "r-planned",
        issue: sampleIssue({
          number: 146,
          title: "Extract pure workspace paths"
        }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      runStore.updateRunState("r-planned", "running");

      const snapshot = buildStatusSnapshot({
        configDir,
        configPath: path.join(configDir, "symphonika.yml"),
        issuePollStatus: emptyPollStatus(),
        projectsByName: new Map([
          [
            "alpha",
            {
              name: "Alpha Project",
              workspace: {
                root: "./workspaces/alpha"
              }
            }
          ]
        ]),
        runStore,
        stateRoot
      });

      expect(snapshot.runs.active[0]).toMatchObject({
        branchName: "sym/alpha-project/146-extract-pure-workspace-paths",
        workspacePath: path.join(
          configDir,
          "workspaces",
          "alpha",
          "issues",
          "146-extract-pure-workspace-paths"
        )
      });
    } finally {
      runStore.close();
    }
  });
});
