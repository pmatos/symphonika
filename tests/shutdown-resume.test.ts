import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  emptyIssuePollStatus,
  type GitHubIssuesApi,
  type IssuePollStatus,
  type IssueSnapshot
} from "../src/issue-polling.js";
import { ActiveRunRegistry } from "../src/lifecycle/active-runs.js";
import {
  RunController,
  type RunControllerProjectConfig,
  type ScheduleHandler
} from "../src/lifecycle/run-controller.js";
import { resumeShutdownCancelledRuns } from "../src/lifecycle/shutdown-resume.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const logger = pino({ enabled: false });

const project: RunControllerProjectConfig = {
  mode: "dispatch",
  agent: { provider: "codex" },
  issue_filters: {
    labels_all: ["agent-ready"],
    labels_none: ["blocked", "needs-human", "sym:stale"],
    states: ["open"]
  },
  workspace: {
    git: {
      base_branch: "main",
      remote: "git@github.com:pmatos/symphonika.git"
    },
    root: "./.symphonika/workspaces/symphonika"
  },
  workflow: { format: "auto", path: "./WORKFLOW.md" },
  name: "symphonika",
  priority: { default: 99, labels: {} },
  tracker: {
    kind: "github",
    owner: "pmatos",
    repo: "symphonika",
    token: "$GITHUB_TOKEN"
  }
};

function snapshot(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    body: "",
    created_at: "2025-01-01T00:00:00Z",
    id: 1,
    labels: ["agent-ready", "sym:claimed"],
    number: 7,
    priority: 1,
    state: "open",
    title: "fixture",
    updated_at: "2025-01-01T00:00:00Z",
    url: "https://example/7",
    ...overrides
  };
}

function pollStatusWithFiltered(issues: IssueSnapshot[]): IssuePollStatus {
  const status = emptyIssuePollStatus();
  status.filteredIssues = issues.map((issue) => ({
    issue,
    project: project.name,
    reasons: ["has operational label sym:claimed"],
    repository: { owner: "pmatos", repo: "symphonika" }
  }));
  return status;
}

function seedShutdownCancelledRun(
  store: RunStore,
  input: { currentStateId?: string; issueNumber?: number; runId?: string } = {}
): string {
  const runId = input.runId ?? "run-killed";
  store.createRun({
    id: runId,
    issue: snapshot(
      input.issueNumber === undefined ? {} : { number: input.issueNumber }
    ),
    projectName: project.name,
    providerCommand: "codex exec",
    providerName: "codex"
  });
  if (input.currentStateId !== undefined) {
    store.setRunCurrentState(runId, input.currentStateId);
  }
  store.markCancelRequested(runId, "daemon_shutdown");
  store.updateRunState(runId, "cancelled");
  return runId;
}

async function withRunStore<T>(
  fn: (store: RunStore) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-shutdown-resume-")
  );
  const store = openRunStore({ stateRoot: root });
  try {
    return await fn(store);
  } finally {
    store.close();
    await rm(root, { force: true, recursive: true });
  }
}

function controller(input: {
  activeRuns: ActiveRunRegistry;
  githubIssuesApi: GitHubIssuesApi;
  runStore: RunStore;
  schedule: ScheduleHandler;
}): RunController {
  return new RunController({
    activeRuns: input.activeRuns,
    agentProviders: {},
    configDir: "/tmp/symphonika-config",
    env: { GITHUB_TOKEN: "secret" },
    githubIssuesApi: input.githubIssuesApi,
    projectsLoader: () => Promise.resolve(new Map([[project.name, project]])),
    providersLoader: () =>
      Promise.resolve({
        claude: { command: "claude" },
        codex: { command: "codex exec" }
      }),
    runStore: input.runStore,
    schedule: input.schedule,
    stateRoot: "/tmp/symphonika-state"
  });
}

describe("resumeShutdownCancelledRuns", () => {
  it("schedules a state advance at the killed run's workflow state", async () => {
    await withRunStore(async (store) => {
      const runId = seedShutdownCancelledRun(store, {
        currentStateId: "implement"
      });
      const activeRuns = new ActiveRunRegistry();
      const schedule = vi.fn();
      const removeLabelsFromIssue = vi.fn().mockResolvedValue(undefined);
      const githubIssuesApi: GitHubIssuesApi = {
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue
      };

      const outcomes = await resumeShutdownCancelledRuns({
        activeRuns,
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi,
        logger,
        pollStatus: pollStatusWithFiltered([snapshot()]),
        projects: new Map([[project.name, project]]),
        runController: controller({
          activeRuns,
          githubIssuesApi,
          runStore: store,
          schedule
        }),
        runStore: store
      });

      expect(outcomes).toEqual([
        {
          issueNumber: 7,
          kind: "resumed",
          project: project.name,
          runId
        }
      ]);
      expect(schedule).toHaveBeenCalledTimes(1);
      expect(schedule).toHaveBeenCalledWith(
        expect.objectContaining({
          issueNumber: 7,
          kind: "state_advance",
          projectName: project.name,
          runId
        })
      );
      // The issue never reached sym:stale, so nothing is removed.
      expect(removeLabelsFromIssue).not.toHaveBeenCalled();
    });
  });

  it("clears a sym:stale verdict left by an earlier boot when it resumes", async () => {
    await withRunStore(async (store) => {
      seedShutdownCancelledRun(store, { currentStateId: "implement" });
      const activeRuns = new ActiveRunRegistry();
      const schedule = vi.fn();
      const removeLabelsFromIssue = vi.fn().mockResolvedValue(undefined);
      const githubIssuesApi: GitHubIssuesApi = {
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue
      };

      await resumeShutdownCancelledRuns({
        activeRuns,
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi,
        logger,
        pollStatus: pollStatusWithFiltered([
          snapshot({ labels: ["agent-ready", "sym:claimed", "sym:stale"] })
        ]),
        projects: new Map([[project.name, project]]),
        runController: controller({
          activeRuns,
          githubIssuesApi,
          runStore: store,
          schedule
        }),
        runStore: store
      });

      expect(schedule).toHaveBeenCalledTimes(1);
      expect(removeLabelsFromIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          issueNumber: 7,
          labels: ["sym:stale"],
          owner: "pmatos",
          repo: "symphonika"
        })
      );
    });
  });

  it("releases the claim instead of resuming when no workflow state was persisted", async () => {
    await withRunStore(async (store) => {
      const runId = seedShutdownCancelledRun(store);
      const activeRuns = new ActiveRunRegistry();
      const schedule = vi.fn();
      const removeLabelsFromIssue = vi.fn().mockResolvedValue(undefined);
      const githubIssuesApi: GitHubIssuesApi = {
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue
      };

      const outcomes = await resumeShutdownCancelledRuns({
        activeRuns,
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi,
        logger,
        pollStatus: pollStatusWithFiltered([
          snapshot({ labels: ["agent-ready", "sym:claimed", "sym:stale"] })
        ]),
        projects: new Map([[project.name, project]]),
        runController: controller({
          activeRuns,
          githubIssuesApi,
          runStore: store,
          schedule
        }),
        runStore: store
      });

      expect(outcomes).toEqual([
        {
          issueNumber: 7,
          kind: "claim_released",
          project: project.name,
          runId
        }
      ]);
      expect(schedule).not.toHaveBeenCalled();
      expect(removeLabelsFromIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          issueNumber: 7,
          labels: ["sym:claimed", "sym:stale"]
        })
      );
      // Declined, so a later tick does not release the labels all over again.
      expect(store.listResumableShutdownRuns()).toEqual([]);
    });
  });

  it("keeps the run resumable when the release label write fails", async () => {
    await withRunStore(async (store) => {
      seedShutdownCancelledRun(store);
      const activeRuns = new ActiveRunRegistry();
      const schedule = vi.fn();
      const githubIssuesApi: GitHubIssuesApi = {
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockRejectedValue(new Error("boom"))
      };

      const outcomes = await resumeShutdownCancelledRuns({
        activeRuns,
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi,
        logger,
        pollStatus: pollStatusWithFiltered([snapshot()]),
        projects: new Map([[project.name, project]]),
        runController: controller({
          activeRuns,
          githubIssuesApi,
          runStore: store,
          schedule
        }),
        runStore: store
      });

      expect(outcomes).toEqual([]);
      expect(store.listResumableShutdownRuns()).toHaveLength(1);
    });
  });

  it("skips an issue that already has live or scheduled work", async () => {
    await withRunStore(async (store) => {
      seedShutdownCancelledRun(store, { currentStateId: "implement" });
      const activeRuns = new ActiveRunRegistry();
      activeRuns.register({
        cancel: () => Promise.resolve(),
        issueNumber: 7,
        projectName: project.name,
        runId: "run-live"
      });
      const schedule = vi.fn();
      const githubIssuesApi: GitHubIssuesApi = {
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      };

      const outcomes = await resumeShutdownCancelledRuns({
        activeRuns,
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi,
        logger,
        pollStatus: pollStatusWithFiltered([snapshot()]),
        projects: new Map([[project.name, project]]),
        runController: controller({
          activeRuns,
          githubIssuesApi,
          runStore: store,
          schedule
        }),
        runStore: store
      });

      expect(outcomes).toEqual([]);
      expect(schedule).not.toHaveBeenCalled();
    });
  });

  it("defers a disabled project without declining the run", async () => {
    await withRunStore(async (store) => {
      seedShutdownCancelledRun(store, { currentStateId: "implement" });
      const activeRuns = new ActiveRunRegistry();
      const schedule = vi.fn();
      const githubIssuesApi: GitHubIssuesApi = {
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      };

      const outcomes = await resumeShutdownCancelledRuns({
        activeRuns,
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi,
        logger,
        pollStatus: pollStatusWithFiltered([snapshot()]),
        projects: new Map([[project.name, { ...project, disabled: true }]]),
        runController: controller({
          activeRuns,
          githubIssuesApi,
          runStore: store,
          schedule
        }),
        runStore: store
      });

      expect(outcomes).toEqual([]);
      expect(schedule).not.toHaveBeenCalled();
      expect(store.listResumableShutdownRuns()).toHaveLength(1);
    });
  });

  it("defers an issue the poll snapshot does not carry", async () => {
    await withRunStore(async (store) => {
      seedShutdownCancelledRun(store, { currentStateId: "implement" });
      const activeRuns = new ActiveRunRegistry();
      const schedule = vi.fn();
      const githubIssuesApi: GitHubIssuesApi = {
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      };

      const outcomes = await resumeShutdownCancelledRuns({
        activeRuns,
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi,
        logger,
        pollStatus: emptyIssuePollStatus(),
        projects: new Map([[project.name, project]]),
        runController: controller({
          activeRuns,
          githubIssuesApi,
          runStore: store,
          schedule
        }),
        runStore: store
      });

      expect(outcomes).toEqual([]);
      expect(schedule).not.toHaveBeenCalled();
      expect(store.listResumableShutdownRuns()).toHaveLength(1);
    });
  });

  it("skips when the project tracker token env var is unset", async () => {
    await withRunStore(async (store) => {
      seedShutdownCancelledRun(store, { currentStateId: "implement" });
      const activeRuns = new ActiveRunRegistry();
      const schedule = vi.fn();
      const githubIssuesApi: GitHubIssuesApi = {
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      };

      const outcomes = await resumeShutdownCancelledRuns({
        activeRuns,
        env: {},
        githubIssuesApi,
        logger,
        pollStatus: pollStatusWithFiltered([snapshot()]),
        projects: new Map([[project.name, project]]),
        runController: controller({
          activeRuns,
          githubIssuesApi,
          runStore: store,
          schedule
        }),
        runStore: store
      });

      expect(outcomes).toEqual([]);
      expect(schedule).not.toHaveBeenCalled();
    });
  });
});
