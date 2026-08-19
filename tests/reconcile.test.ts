import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  emptyIssuePollStatus,
  type IssuePollStatus,
  type IssueSnapshot
} from "../src/issue-polling.js";
import type { RunControllerProjectConfig } from "../src/lifecycle/run-controller.js";
import {
  ActiveRunRegistry,
  CANCEL_REASONS
} from "../src/lifecycle/active-runs.js";
import { reconcileActiveRuns } from "../src/lifecycle/reconcile.js";
import { openRunStore, type RunStore } from "../src/run-store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const logger = pino({ enabled: false });

const project: RunControllerProjectConfig = {
  mode: "dispatch",
  agent: { provider: "codex" },
  issue_filters: {
    labels_all: ["agent-ready"],
    labels_none: ["blocked", "needs-human"],
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
    labels: ["agent-ready", "sym:claimed", "sym:running"],
    number: 7,
    priority: 1,
    state: "open",
    title: "fixture",
    updated_at: "2025-01-01T00:00:00Z",
    url: "https://example/7",
    ...overrides
  };
}

async function withRunStore<T>(
  fn: (store: RunStore) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-reconcile-store-")
  );
  const store = openRunStore({ stateRoot: root });
  try {
    return await fn(store);
  } finally {
    store.close();
    await rm(root, { force: true, recursive: true });
  }
}

function pollStatus(issues: IssueSnapshot[]): IssuePollStatus {
  const status = emptyIssuePollStatus();
  status.candidateIssues = issues.map((issue) => ({
    issue,
    project: project.name,
    repository: { owner: "pmatos", repo: "symphonika" }
  }));
  return status;
}

describe("reconcileActiveRuns", () => {
  it("cancels with closed_issue when issue is absent and getIssue reports null", async () => {
    await withRunStore(async (store) => {
      store.createRun({
        id: "run-a",
        issue: snapshot(),
        projectName: project.name,
        providerCommand: "fake",
        providerName: "codex"
      });
      const cancel = vi.fn().mockResolvedValue(undefined);
      const registry = new ActiveRunRegistry();
      registry.register({
        cancel,
        issueNumber: 7,
        projectName: project.name,
        runId: "run-a"
      });

      const githubIssuesApi = {
        getIssue: vi.fn().mockResolvedValue(null),
        listOpenIssues: vi.fn().mockResolvedValue([])
      };

      await reconcileActiveRuns({
        activeRuns: registry,
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi,
        logger,
        pollStatus: pollStatus([]),
        projects: new Map([[project.name, project]]),
        runStore: store
      });

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(githubIssuesApi.getIssue).toHaveBeenCalledWith({
        issueNumber: 7,
        owner: "pmatos",
        repo: "symphonika",
        token: "secret"
      });
      expect(registry.get("run-a")?.cancelReason).toBe(
        CANCEL_REASONS.CLOSED_ISSUE
      );
      expect(store.listRuns()[0]?.cancelReason).toBe("closed_issue");
    });
  });

  it("cancels with eligibility_loss when poll snapshot adds excluded label", async () => {
    await withRunStore(async (store) => {
      store.createRun({
        id: "run-a",
        issue: snapshot(),
        projectName: project.name,
        providerCommand: "fake",
        providerName: "codex"
      });
      const cancel = vi.fn().mockResolvedValue(undefined);
      const registry = new ActiveRunRegistry();
      registry.register({
        cancel,
        issueNumber: 7,
        projectName: project.name,
        runId: "run-a"
      });

      const status = pollStatus([
        snapshot({
          labels: ["agent-ready", "needs-human", "sym:claimed", "sym:running"]
        })
      ]);

      const githubIssuesApi = {
        listOpenIssues: vi.fn().mockResolvedValue([])
      };

      await reconcileActiveRuns({
        activeRuns: registry,
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi,
        logger,
        pollStatus: status,
        projects: new Map([[project.name, project]]),
        runStore: store
      });

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(registry.get("run-a")?.cancelReason).toBe(
        CANCEL_REASONS.ELIGIBILITY_LOSS
      );
    });
  });

  it("does not cancel a state-advance run when the issue loses required labels mid-walk", async () => {
    await withRunStore(async (store) => {
      store.createRun({
        id: "run-a",
        issue: snapshot(),
        projectName: project.name,
        providerCommand: "fake",
        providerName: "codex"
      });
      const cancel = vi.fn().mockResolvedValue(undefined);
      const registry = new ActiveRunRegistry();
      registry.register({
        cancel,
        issueNumber: 7,
        projectName: project.name,
        // Raw FSM mid-walk run: the FSM owns whether the agent keeps running,
        // not the issue label set. See ADR 0046.
        respectsIssueLabels: false,
        runId: "run-a"
      });

      // Poll snapshot: agent-ready removed AND needs-human added. Under the
      // default flag this would cancel with ELIGIBILITY_LOSS.
      const status = pollStatus([
        snapshot({ labels: ["needs-human", "sym:claimed", "sym:running"] })
      ]);

      await reconcileActiveRuns({
        activeRuns: registry,
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi: { listOpenIssues: vi.fn().mockResolvedValue([]) },
        logger,
        pollStatus: status,
        projects: new Map([[project.name, project]]),
        runStore: store
      });

      expect(cancel).not.toHaveBeenCalled();
      expect(registry.get("run-a")?.cancelReason).toBeUndefined();
    });
  });

  it("still cancels a state-advance run with closed_issue when the issue is closed", async () => {
    await withRunStore(async (store) => {
      store.createRun({
        id: "run-a",
        issue: snapshot(),
        projectName: project.name,
        providerCommand: "fake",
        providerName: "codex"
      });
      const cancel = vi.fn().mockResolvedValue(undefined);
      const registry = new ActiveRunRegistry();
      registry.register({
        cancel,
        issueNumber: 7,
        projectName: project.name,
        respectsIssueLabels: false,
        runId: "run-a"
      });

      const status = pollStatus([snapshot({ state: "closed" })]);

      await reconcileActiveRuns({
        activeRuns: registry,
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi: { listOpenIssues: vi.fn().mockResolvedValue([]) },
        logger,
        pollStatus: status,
        projects: new Map([[project.name, project]]),
        runStore: store
      });

      // Label-immunity does not extend to closed issues — the run still cancels.
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(registry.get("run-a")?.cancelReason).toBe(
        CANCEL_REASONS.CLOSED_ISSUE
      );
    });
  });

  it("starts independent run cancellations without serializing their grace periods", async () => {
    await withRunStore(async (store) => {
      const issueA = snapshot({ state: "closed" });
      const issueB = snapshot({ id: 2, number: 8, state: "closed" });
      store.createRun({
        id: "run-a",
        issue: issueA,
        projectName: project.name,
        providerCommand: "fake",
        providerName: "codex"
      });
      store.createRun({
        id: "run-b",
        issue: issueB,
        projectName: project.name,
        providerCommand: "fake",
        providerName: "codex"
      });
      let resolveA: (() => void) | undefined;
      let resolveB: (() => void) | undefined;
      const pendingA = new Promise<void>((resolve) => {
        resolveA = resolve;
      });
      const pendingB = new Promise<void>((resolve) => {
        resolveB = resolve;
      });
      const cancelA = vi.fn(() => pendingA);
      const cancelB = vi.fn(() => pendingB);
      const registry = new ActiveRunRegistry();
      registry.register({
        cancel: cancelA,
        issueNumber: issueA.number,
        projectName: project.name,
        runId: "run-a"
      });
      registry.register({
        cancel: cancelB,
        issueNumber: issueB.number,
        projectName: project.name,
        runId: "run-b"
      });

      const reconciling = reconcileActiveRuns({
        activeRuns: registry,
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi: { listOpenIssues: vi.fn().mockResolvedValue([]) },
        logger,
        pollStatus: pollStatus([issueA, issueB]),
        projects: new Map([[project.name, project]]),
        runStore: store
      });

      try {
        await vi.waitFor(() => {
          expect(cancelA).toHaveBeenCalledOnce();
        });
        expect(cancelB).toHaveBeenCalledOnce();
      } finally {
        resolveA?.();
        resolveB?.();
        await reconciling;
      }
    });
  });

  it("does not cancel when project is removed from config", async () => {
    await withRunStore(async (store) => {
      store.createRun({
        id: "run-a",
        issue: snapshot(),
        projectName: project.name,
        providerCommand: "fake",
        providerName: "codex"
      });
      const cancel = vi.fn().mockResolvedValue(undefined);
      const registry = new ActiveRunRegistry();
      registry.register({
        cancel,
        issueNumber: 7,
        projectName: project.name,
        runId: "run-a"
      });

      const githubIssuesApi = {
        getIssue: vi.fn().mockResolvedValue(null),
        listOpenIssues: vi.fn().mockResolvedValue([])
      };

      await reconcileActiveRuns({
        activeRuns: registry,
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi,
        logger,
        pollStatus: pollStatus([]),
        projects: new Map(),
        runStore: store
      });

      expect(cancel).not.toHaveBeenCalled();
      expect(githubIssuesApi.getIssue).not.toHaveBeenCalled();
    });
  });

  it("does nothing when poll snapshot keeps the issue eligible", async () => {
    await withRunStore(async (store) => {
      store.createRun({
        id: "run-a",
        issue: snapshot(),
        projectName: project.name,
        providerCommand: "fake",
        providerName: "codex"
      });
      const cancel = vi.fn().mockResolvedValue(undefined);
      const registry = new ActiveRunRegistry();
      registry.register({
        cancel,
        issueNumber: 7,
        projectName: project.name,
        runId: "run-a"
      });

      await reconcileActiveRuns({
        activeRuns: registry,
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi: { listOpenIssues: vi.fn().mockResolvedValue([]) },
        logger,
        pollStatus: pollStatus([snapshot()]),
        projects: new Map([[project.name, project]]),
        runStore: store
      });

      expect(cancel).not.toHaveBeenCalled();
    });
  });

  it("does not cancel a Routine Firing sharing a Dispatch Project's concurrency slot", async () => {
    // Routine Firings register into the same ActiveRunRegistry as
    // issue-driven Runs (with a synthetic issue number, see reserveSlot in
    // routines/dispatcher.ts) so per-project concurrency caps see both kinds
    // of work. Deliberately no store.createRun() here -- this entry is a
    // Routine Firing, not a Run, and must not be reconciled against GitHub.
    await withRunStore(async (store) => {
      store.syncRoutines([
        {
          kind: "git",
          name: "refactor-audit",
          prompt: "Audit the codebase.",
          provider: "codex",
          schedule: { cron: "0 1 * * 1-5", tz: "Etc/UTC" },
          projectName: project.name,
          sourcePath: "/tmp/refactor-audit.md"
        }
      ]);
      store.createRoutineFiring({
        id: "firing-a",
        projectName: project.name,
        providerCommand: "fake",
        providerName: "codex",
        routineName: "refactor-audit"
      });
      const cancel = vi.fn().mockResolvedValue(undefined);
      const registry = new ActiveRunRegistry();
      registry.register({
        cancel,
        // A synthetic issue number, as reserveSlot assigns for a Routine
        // Firing -- deliberately not present in any poll snapshot.
        issueNumber: -1,
        projectName: project.name,
        runId: "firing-a"
      });

      const githubIssuesApi = {
        getIssue: vi.fn().mockResolvedValue(null),
        listOpenIssues: vi.fn().mockResolvedValue([])
      };

      await reconcileActiveRuns({
        activeRuns: registry,
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi,
        logger,
        pollStatus: pollStatus([]),
        projects: new Map([[project.name, project]]),
        runStore: store
      });

      expect(githubIssuesApi.getIssue).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(registry.get("firing-a")?.cancelReason).toBeUndefined();
    });
  });

  it("preserves `this` when calling getIssue on a class-based API", async () => {
    await withRunStore(async (store) => {
      store.createRun({
        id: "run-a",
        issue: snapshot(),
        projectName: project.name,
        providerCommand: "fake",
        providerName: "codex"
      });
      const cancel = vi.fn().mockResolvedValue(undefined);
      const registry = new ActiveRunRegistry();
      registry.register({
        cancel,
        issueNumber: 7,
        projectName: project.name,
        runId: "run-a"
      });

      class StubApi {
        readonly calls: Array<{ issueNumber: number }> = [];
        getIssue(input: {
          issueNumber: number;
          owner: string;
          repo: string;
          token: string;
        }): Promise<null> {
          this.calls.push({ issueNumber: input.issueNumber });
          return Promise.resolve(null);
        }
        listOpenIssues(): Promise<never[]> {
          return Promise.resolve([]);
        }
      }
      const api = new StubApi();

      await reconcileActiveRuns({
        activeRuns: registry,
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi: api,
        logger,
        pollStatus: pollStatus([]),
        projects: new Map([[project.name, project]]),
        runStore: store
      });

      expect(api.calls).toEqual([{ issueNumber: 7 }]);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(registry.get("run-a")?.cancelReason).toBe(
        CANCEL_REASONS.CLOSED_ISSUE
      );
    });
  });
});
