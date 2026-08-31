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
import { detectStaleClaims } from "../src/lifecycle/stale-claims.js";
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
  input: {
    currentStateId?: string;
    issueNumber?: number;
    runId?: string;
    url?: string;
  } = {}
): string {
  const runId = input.runId ?? "run-killed";
  store.createRun({
    id: runId,
    issue: snapshot({
      ...(input.issueNumber === undefined ? {} : { number: input.issueNumber }),
      ...(input.url === undefined ? {} : { url: input.url })
    }),
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
  fn: (store: RunStore, root: string) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-shutdown-resume-")
  );
  const store = openRunStore({ stateRoot: root });
  try {
    return await fn(store, root);
  } finally {
    store.close();
    await rm(root, { force: true, recursive: true });
  }
}

function controller(input: {
  activeRuns: ActiveRunRegistry;
  githubIssuesApi: GitHubIssuesApi;
  // Kept inside the test's own mkdtemp directory rather than a fixed /tmp
  // path: nothing here writes through these, but a hardcoded OS-temp path is
  // both a collision risk across concurrent runs and a CodeQL
  // js/insecure-temporary-file finding.
  root: string;
  runStore: RunStore;
  schedule: ScheduleHandler;
}): RunController {
  return new RunController({
    activeRuns: input.activeRuns,
    agentProviders: {},
    configDir: path.join(input.root, "config"),
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
    stateRoot: path.join(input.root, "state")
  });
}

describe("resumeShutdownCancelledRuns", () => {
  it("schedules a state advance at the killed run's workflow state", async () => {
    await withRunStore(async (store, root) => {
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
          root,
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
    await withRunStore(async (store, root) => {
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
          root,
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
    await withRunStore(async (store, root) => {
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
          root,
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

  it("does not let stale detection re-strand an issue whose claim it just released", async () => {
    await withRunStore(async (store, root) => {
      seedShutdownCancelledRun(store);
      const activeRuns = new ActiveRunRegistry();
      const schedule = vi.fn();
      const addLabelsToIssue = vi.fn().mockResolvedValue(undefined);
      const githubIssuesApi: GitHubIssuesApi = {
        addLabelsToIssue,
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      };
      // Both passes share one snapshot, exactly as the daemon's reconcile
      // tick hands the same issuePollStatus to each of them in turn.
      const pollStatus = pollStatusWithFiltered([snapshot()]);
      const shared = {
        activeRuns,
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi,
        logger,
        pollStatus,
        projects: new Map([[project.name, project]]),
        runStore: store
      };

      const outcomes = await resumeShutdownCancelledRuns({
        ...shared,
        runController: controller({
          activeRuns,
          githubIssuesApi,
          root,
          runStore: store,
          schedule
        })
      });
      expect(outcomes.map((entry) => entry.kind)).toEqual(["claim_released"]);
      expect(pollStatus.filteredIssues[0]?.issue.labels).not.toContain(
        "sym:claimed"
      );

      const marks = await detectStaleClaims(shared);
      expect(marks).toEqual([]);
      expect(addLabelsToIssue).not.toHaveBeenCalled();
    });
  });

  it("defers the resume when clearing an earlier sym:stale fails, and retries next pass", async () => {
    await withRunStore(async (store, root) => {
      const activeRuns = new ActiveRunRegistry();
      const schedule = vi.fn();
      const removeLabelsFromIssue = vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce(undefined);
      const githubIssuesApi: GitHubIssuesApi = {
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue
      };
      const pollStatus = pollStatusWithFiltered([
        snapshot({ labels: ["agent-ready", "sym:claimed", "sym:stale"] })
      ]);
      const call = () =>
        resumeShutdownCancelledRuns({
          activeRuns,
          env: { GITHUB_TOKEN: "secret" },
          githubIssuesApi,
          logger,
          pollStatus,
          projects: new Map([[project.name, project]]),
          runController: controller({
            activeRuns,
            githubIssuesApi,
            root,
            runStore: store,
            schedule
          }),
          runStore: store
        });

      seedShutdownCancelledRun(store, { currentStateId: "implement" });

      // The label write fails, so nothing is scheduled and the row stays the
      // newest run for its issue — the only thing that keeps it resumable.
      expect(await call()).toEqual([]);
      expect(schedule).not.toHaveBeenCalled();
      expect(store.listResumableShutdownRuns()).toHaveLength(1);

      // Next tick: the write succeeds and the resume goes ahead.
      expect((await call()).map((entry) => entry.kind)).toEqual(["resumed"]);
      expect(schedule).toHaveBeenCalledTimes(1);
      expect(pollStatus.filteredIssues[0]?.issue.labels).not.toContain(
        "sym:stale"
      );
    });
  });

  it("keeps the run resumable when the release label write fails", async () => {
    await withRunStore(async (store, root) => {
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
          root,
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
    await withRunStore(async (store, root) => {
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
          root,
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
    await withRunStore(async (store, root) => {
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
          root,
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
    await withRunStore(async (store, root) => {
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
          root,
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

  it("refuses to act when the project tracker no longer points at the run's repository", async () => {
    await withRunStore(async (store, root) => {
      seedShutdownCancelledRun(store, {
        currentStateId: "implement",
        url: "https://github.com/pmatos/some-other-repo/issues/7"
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
        pollStatus: pollStatusWithFiltered([
          snapshot({ labels: ["agent-ready", "sym:claimed", "sym:stale"] })
        ]),
        projects: new Map([[project.name, project]]),
        runController: controller({
          activeRuns,
          githubIssuesApi,
          root,
          runStore: store,
          schedule
        }),
        runStore: store
      });

      expect(outcomes).toEqual([]);
      expect(schedule).not.toHaveBeenCalled();
      expect(removeLabelsFromIssue).not.toHaveBeenCalled();
      expect(store.listResumableShutdownRuns()).toHaveLength(1);
    });
  });

  it("resumes the original repository's run after an A -> B -> A retarget", async () => {
    // Issue #602's reproduction. Before the newest-run relation was
    // partitioned by repository, B's newer row eliminated A's, the pass
    // refused B at the origin gate, and A#7 was left holding `sym:claimed`
    // with no live run and nothing that would ever resume it.
    await withRunStore(async (store, root) => {
      seedShutdownCancelledRun(store, {
        currentStateId: "implement",
        runId: "run-in-a",
        url: "https://github.com/pmatos/symphonika/issues/7"
      });
      seedShutdownCancelledRun(store, {
        currentStateId: "plan",
        runId: "run-in-b",
        url: "https://github.com/pmatos/other-repo/issues/7"
      });

      const activeRuns = new ActiveRunRegistry();
      const schedule = vi.fn();
      const githubIssuesApi: GitHubIssuesApi = {
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      };

      // The tracker has been retargeted back to A.
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
          root,
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
          runId: "run-in-a"
        }
      ]);
      expect(schedule).toHaveBeenCalledTimes(1);
    });
  });

  it("treats an owner/repo casing difference as the same repository", async () => {
    await withRunStore(async (store, root) => {
      seedShutdownCancelledRun(store, {
        currentStateId: "implement",
        url: "https://github.com/PMatos/Symphonika/issues/7"
      });
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
        projects: new Map([[project.name, project]]),
        runController: controller({
          activeRuns,
          githubIssuesApi,
          root,
          runStore: store,
          schedule
        }),
        runStore: store
      });

      expect(outcomes.map((entry) => entry.kind)).toEqual(["resumed"]);
      expect(schedule).toHaveBeenCalledTimes(1);
    });
  });

  it("does not schedule a second resume while the first has fired but not claimed", async () => {
    await withRunStore(async (store, root) => {
      const runId = seedShutdownCancelledRun(store, {
        currentStateId: "implement"
      });
      const activeRuns = new ActiveRunRegistry();
      // A stub scheduler: the work is never registered with the
      // ScheduledWorkRegistry and the callback is held, which is exactly the
      // fire-to-claim window isIssueReserved cannot observe.
      const fires: Array<() => Promise<void>> = [];
      const schedule = vi.fn((item: { fire: () => Promise<void> }) => {
        fires.push(item.fire);
      });
      const githubIssuesApi: GitHubIssuesApi = {
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      };
      const runController = controller({
        activeRuns,
        githubIssuesApi,
        root,
        runStore: store,
        schedule
      });
      const call = () =>
        resumeShutdownCancelledRuns({
          activeRuns,
          env: { GITHUB_TOKEN: "secret" },
          githubIssuesApi,
          logger,
          pollStatus: pollStatusWithFiltered([snapshot()]),
          projects: new Map([[project.name, project]]),
          runController,
          runStore: store
        });

      expect((await call()).map((entry) => entry.kind)).toEqual(["resumed"]);
      expect(runController.hasPendingShutdownResume(runId)).toBe(true);

      // Second tick lands inside the window: the row is still the newest run
      // and nothing is reserved, so only the pending guard can hold it.
      expect(await call()).toEqual([]);
      expect(schedule).toHaveBeenCalledTimes(1);

      // Once the callback settles without claiming, the row is resumable
      // again so a later tick retries it.
      await fires[0]?.();
      expect(runController.hasPendingShutdownResume(runId)).toBe(false);
      expect((await call()).map((entry) => entry.kind)).toEqual(["resumed"]);
      expect(schedule).toHaveBeenCalledTimes(2);
    });
  });

  it("selects the poll row for the project's own repository when a duplicate name shadows it", async () => {
    await withRunStore(async (store, root) => {
      seedShutdownCancelledRun(store, {
        url: "https://github.com/pmatos/symphonika/issues/7"
      });
      const activeRuns = new ActiveRunRegistry();
      const schedule = vi.fn();
      const removeLabelsFromIssue = vi.fn().mockResolvedValue(undefined);
      const githubIssuesApi: GitHubIssuesApi = {
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue
      };
      // Duplicate project declarations are not rejected at load: the poll loop
      // walks the config array so both are polled under one name, while
      // projectsByName keeps the last. The shadowing entry is listed first and
      // carries no claim, so a name-only lookup would read its labels and
      // release nothing.
      const pollStatus = emptyIssuePollStatus();
      pollStatus.filteredIssues = [
        {
          issue: snapshot({ labels: ["agent-ready"] }),
          project: project.name,
          reasons: ["fixture"],
          repository: { owner: "pmatos", repo: "some-other-repo" }
        },
        {
          issue: snapshot(),
          project: project.name,
          reasons: ["has operational label sym:claimed"],
          repository: { owner: "pmatos", repo: "symphonika" }
        }
      ];

      const outcomes = await resumeShutdownCancelledRuns({
        activeRuns,
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi,
        logger,
        pollStatus,
        projects: new Map([[project.name, project]]),
        runController: controller({
          activeRuns,
          githubIssuesApi,
          root,
          runStore: store,
          schedule
        }),
        runStore: store
      });

      expect(outcomes.map((entry) => entry.kind)).toEqual(["claim_released"]);
      expect(removeLabelsFromIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          issueNumber: 7,
          labels: ["sym:claimed"],
          repo: "symphonika"
        })
      );
      // The right snapshot was mutated, so stale detection sees no claim.
      expect(pollStatus.filteredIssues[1]?.issue.labels).not.toContain(
        "sym:claimed"
      );
    });
  });

  it("keeps a resume pending across a contention retry handover", async () => {
    await withRunStore(async (store, root) => {
      const activeRuns = new ActiveRunRegistry();
      const fires: Array<() => Promise<void>> = [];
      const schedule = vi.fn((item: { fire: () => Promise<void> }) => {
        fires.push(item.fire);
      });
      const githubIssuesApi: GitHubIssuesApi = {
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      };
      const runController = controller({
        activeRuns,
        githubIssuesApi,
        root,
        runStore: store,
        schedule
      });
      const payload = {
        issue: snapshot(),
        parentRunId: "run-killed",
        projectName: project.name,
        toStateId: "implement"
      };

      runController.scheduleShutdownResume(payload);
      expect(runController.hasPendingShutdownResume("run-killed")).toBe(true);

      // What executeStateAdvance's cap/reservation contention branch now
      // does: re-arm through the same wrapper before the callback it replaces
      // has unwound.
      runController.scheduleShutdownResume(payload);

      // The outgoing callback settling must not erase the incoming retry's
      // claim — a plain Set would have cleared it here, reopening the
      // retry's own fire-to-claim window.
      await fires[0]?.();
      expect(runController.hasPendingShutdownResume("run-killed")).toBe(true);

      await fires[1]?.();
      expect(runController.hasPendingShutdownResume("run-killed")).toBe(false);
    });
  });

  it("skips when the project tracker token env var is unset", async () => {
    await withRunStore(async (store, root) => {
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
          root,
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
