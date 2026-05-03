import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  emptyIssuePollStatus,
  type IssuePollStatus,
  type IssueSnapshot,
  type PollingProjectConfig
} from "../src/issue-polling.js";
import { ActiveRunRegistry, CANCEL_REASONS } from "../src/lifecycle/active-runs.js";
import { reconcileActiveRuns } from "../src/lifecycle/reconcile.js";
import { openRunStore, type RunStore } from "../src/run-store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const logger = pino({ enabled: false });

const project: PollingProjectConfig = {
  agent: { provider: "codex" },
  issue_filters: {
    labels_all: ["agent-ready"],
    labels_none: ["blocked", "needs-human"],
    states: ["open"]
  },
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

async function withRunStore<T>(fn: (store: RunStore) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-reconcile-store-"));
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
    project: project.name
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
      expect(registry.get("run-a")?.cancelReason).toBe(CANCEL_REASONS.CLOSED_ISSUE);
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
        snapshot({ labels: ["agent-ready", "needs-human", "sym:claimed", "sym:running"] })
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
      expect(registry.get("run-a")?.cancelReason).toBe(CANCEL_REASONS.CLOSED_ISSUE);
    });
  });
});
