import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  emptyIssuePollStatus,
  type IssuePollStatus,
  type IssueSnapshot,
  type PollingProjectConfig
} from "../src/issue-polling.js";
import { ActiveRunRegistry } from "../src/lifecycle/active-runs.js";
import { detectStaleClaims } from "../src/lifecycle/stale-claims.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

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
    labels: ["agent-ready"],
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
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-stale-claims-store-"));
  const store = openRunStore({ stateRoot: root });
  try {
    return await fn(store);
  } finally {
    store.close();
    await rm(root, { force: true, recursive: true });
  }
}

function pollStatusWithFiltered(issues: IssueSnapshot[]): IssuePollStatus {
  const status = emptyIssuePollStatus();
  status.filteredIssues = issues.map((issue) => ({
    issue,
    project: project.name,
    reasons: ["fixture-filtered"]
  }));
  return status;
}

describe("detectStaleClaims", () => {
  it("scopes liveness checks per project when issue numbers collide", async () => {
    await withRunStore(async (store) => {
      const projectB: PollingProjectConfig = {
        ...project,
        name: "other",
        tracker: { ...project.tracker, owner: "other-owner", repo: "other-repo" }
      };
      const issueLive = snapshot({
        labels: ["agent-ready", "sym:claimed"],
        number: 42,
        url: "https://example/p1/42"
      });
      const issueOrphan = snapshot({
        labels: ["agent-ready", "sym:claimed"],
        number: 42,
        url: "https://example/p2/42"
      });

      const status = emptyIssuePollStatus();
      status.filteredIssues = [
        { issue: issueLive, project: project.name, reasons: ["fixture"] },
        { issue: issueOrphan, project: projectB.name, reasons: ["fixture"] }
      ];

      const registry = new ActiveRunRegistry();
      registry.register({
        cancel: () => Promise.resolve(),
        issueNumber: 42,
        projectName: project.name,
        runId: "run-live"
      });

      const addLabelsToIssue = vi.fn().mockResolvedValue(undefined);

      const marks = await detectStaleClaims({
        activeRuns: registry,
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi: {
          addLabelsToIssue,
          listOpenIssues: vi.fn().mockResolvedValue([])
        },
        logger,
        pollStatus: status,
        projects: new Map([
          [project.name, project],
          [projectB.name, projectB]
        ]),
        runStore: store
      });

      expect(addLabelsToIssue).toHaveBeenCalledTimes(1);
      expect(addLabelsToIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "other-owner",
          repo: "other-repo",
          issueNumber: 42
        })
      );
      expect(marks).toEqual([{ project: projectB.name, issueNumber: 42 }]);
    });
  });

  it("skips when githubIssuesApi.addLabelsToIssue is undefined", async () => {
    await withRunStore(async (store) => {
      const issue = snapshot({ labels: ["agent-ready", "sym:claimed"] });
      const marks = await detectStaleClaims({
        activeRuns: new ActiveRunRegistry(),
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi: {
          listOpenIssues: vi.fn().mockResolvedValue([])
        },
        logger,
        pollStatus: pollStatusWithFiltered([issue]),
        projects: new Map([[project.name, project]]),
        runStore: store
      });

      expect(marks).toEqual([]);
    });
  });

  it("skips when the project tracker token env var is unset", async () => {
    await withRunStore(async (store) => {
      const issue = snapshot({ labels: ["agent-ready", "sym:claimed"] });
      const addLabelsToIssue = vi.fn().mockResolvedValue(undefined);

      const marks = await detectStaleClaims({
        activeRuns: new ActiveRunRegistry(),
        env: {},
        githubIssuesApi: {
          addLabelsToIssue,
          listOpenIssues: vi.fn().mockResolvedValue([])
        },
        logger,
        pollStatus: pollStatusWithFiltered([issue]),
        projects: new Map([[project.name, project]]),
        runStore: store
      });

      expect(addLabelsToIssue).not.toHaveBeenCalled();
      expect(marks).toEqual([]);
    });
  });

  it("continues processing other issues when addLabelsToIssue throws", async () => {
    await withRunStore(async (store) => {
      const issueA = snapshot({
        labels: ["agent-ready", "sym:claimed"],
        number: 11,
        url: "https://example/11"
      });
      const issueB = snapshot({
        labels: ["agent-ready", "sym:claimed"],
        number: 12,
        url: "https://example/12"
      });
      const addLabelsToIssue = vi
        .fn()
        .mockImplementationOnce(() => Promise.reject(new Error("boom")))
        .mockResolvedValueOnce(undefined);

      const marks = await detectStaleClaims({
        activeRuns: new ActiveRunRegistry(),
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi: {
          addLabelsToIssue,
          listOpenIssues: vi.fn().mockResolvedValue([])
        },
        logger,
        pollStatus: pollStatusWithFiltered([issueA, issueB]),
        projects: new Map([[project.name, project]]),
        runStore: store
      });

      expect(addLabelsToIssue).toHaveBeenCalledTimes(2);
      expect(marks).toEqual([{ project: project.name, issueNumber: 12 }]);
    });
  });

  it("does not mark issues that have only sym:failed (no claim/running)", async () => {
    await withRunStore(async (store) => {
      const issue = snapshot({ labels: ["agent-ready", "sym:failed"] });
      const addLabelsToIssue = vi.fn().mockResolvedValue(undefined);

      const marks = await detectStaleClaims({
        activeRuns: new ActiveRunRegistry(),
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi: {
          addLabelsToIssue,
          listOpenIssues: vi.fn().mockResolvedValue([])
        },
        logger,
        pollStatus: pollStatusWithFiltered([issue]),
        projects: new Map([[project.name, project]]),
        runStore: store
      });

      expect(addLabelsToIssue).not.toHaveBeenCalled();
      expect(marks).toEqual([]);
    });
  });

  it("does not mark issues whose state is closed", async () => {
    await withRunStore(async (store) => {
      const issue = snapshot({
        labels: ["agent-ready", "sym:claimed"],
        state: "closed"
      });
      const addLabelsToIssue = vi.fn().mockResolvedValue(undefined);

      const marks = await detectStaleClaims({
        activeRuns: new ActiveRunRegistry(),
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi: {
          addLabelsToIssue,
          listOpenIssues: vi.fn().mockResolvedValue([])
        },
        logger,
        pollStatus: pollStatusWithFiltered([issue]),
        projects: new Map([[project.name, project]]),
        runStore: store
      });

      expect(addLabelsToIssue).not.toHaveBeenCalled();
      expect(marks).toEqual([]);
    });
  });

  it("does not re-mark issues that already carry sym:stale", async () => {
    await withRunStore(async (store) => {
      const issue = snapshot({
        labels: ["agent-ready", "sym:claimed", "sym:stale"]
      });
      const addLabelsToIssue = vi.fn().mockResolvedValue(undefined);

      const marks = await detectStaleClaims({
        activeRuns: new ActiveRunRegistry(),
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi: {
          addLabelsToIssue,
          listOpenIssues: vi.fn().mockResolvedValue([])
        },
        logger,
        pollStatus: pollStatusWithFiltered([issue]),
        projects: new Map([[project.name, project]]),
        runStore: store
      });

      expect(addLabelsToIssue).not.toHaveBeenCalled();
      expect(marks).toEqual([]);
    });
  });

  it("does not mark when a retry is scheduled for the issue (registry empty, run-store row terminal)", async () => {
    await withRunStore(async (store) => {
      const issue = snapshot({ labels: ["agent-ready", "sym:claimed"] });
      // Simulate transient-retry state: original run is unregistered and
      // the run-store row has transitioned to 'failed' awaiting the next
      // attempt. sym:claimed has been re-asserted by run-controller.
      store.createRun({
        id: "run-retry",
        issue,
        projectName: project.name,
        providerCommand: "fake",
        providerName: "codex"
      });
      store.updateRunState("run-retry", "failed");

      const registry = new ActiveRunRegistry();
      registry.scheduleDelayed({
        delayMs: 30_000,
        fire: () => Promise.resolve(),
        issueNumber: issue.number,
        kind: "retry",
        projectName: project.name,
        runId: "run-retry"
      });

      const addLabelsToIssue = vi.fn().mockResolvedValue(undefined);
      const marks = await detectStaleClaims({
        activeRuns: registry,
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi: {
          addLabelsToIssue,
          listOpenIssues: vi.fn().mockResolvedValue([])
        },
        logger,
        pollStatus: pollStatusWithFiltered([issue]),
        projects: new Map([[project.name, project]]),
        runStore: store
      });

      expect(addLabelsToIssue).not.toHaveBeenCalled();
      expect(marks).toEqual([]);
      registry.cancelAll();
    });
  });

  it("does not mark when run-store reports an active run for the issue", async () => {
    await withRunStore(async (store) => {
      const issue = snapshot({ labels: ["agent-ready", "sym:claimed"] });
      store.createRun({
        id: "run-store-only",
        issue,
        projectName: project.name,
        providerCommand: "fake",
        providerName: "codex"
      });
      const addLabelsToIssue = vi.fn().mockResolvedValue(undefined);

      const marks = await detectStaleClaims({
        activeRuns: new ActiveRunRegistry(),
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi: {
          addLabelsToIssue,
          listOpenIssues: vi.fn().mockResolvedValue([])
        },
        logger,
        pollStatus: pollStatusWithFiltered([issue]),
        projects: new Map([[project.name, project]]),
        runStore: store
      });

      expect(addLabelsToIssue).not.toHaveBeenCalled();
      expect(marks).toEqual([]);
    });
  });

  it("does not mark when an in-memory run is registered for the issue", async () => {
    await withRunStore(async (store) => {
      const issue = snapshot({ labels: ["agent-ready", "sym:claimed"] });
      const addLabelsToIssue = vi.fn().mockResolvedValue(undefined);
      const registry = new ActiveRunRegistry();
      registry.register({
        cancel: () => Promise.resolve(),
        issueNumber: issue.number,
        projectName: project.name,
        runId: "run-live"
      });

      const marks = await detectStaleClaims({
        activeRuns: registry,
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi: {
          addLabelsToIssue,
          listOpenIssues: vi.fn().mockResolvedValue([])
        },
        logger,
        pollStatus: pollStatusWithFiltered([issue]),
        projects: new Map([[project.name, project]]),
        runStore: store
      });

      expect(addLabelsToIssue).not.toHaveBeenCalled();
      expect(marks).toEqual([]);
    });
  });

  it("marks an issue with sym:running and no live run as sym:stale", async () => {
    await withRunStore(async (store) => {
      const issue = snapshot({
        labels: ["agent-ready", "sym:running"],
        number: 8,
        url: "https://example/8"
      });
      const addLabelsToIssue = vi.fn().mockResolvedValue(undefined);

      const marks = await detectStaleClaims({
        activeRuns: new ActiveRunRegistry(),
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi: {
          addLabelsToIssue,
          listOpenIssues: vi.fn().mockResolvedValue([])
        },
        logger,
        pollStatus: pollStatusWithFiltered([issue]),
        projects: new Map([[project.name, project]]),
        runStore: store
      });

      expect(addLabelsToIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          issueNumber: 8,
          labels: ["sym:stale"]
        })
      );
      expect(marks).toEqual([{ project: project.name, issueNumber: 8 }]);
    });
  });

  it("marks an issue with sym:claimed and no live run as sym:stale", async () => {
    await withRunStore(async (store) => {
      const issue = snapshot({
        labels: ["agent-ready", "sym:claimed"]
      });
      const addLabelsToIssue = vi.fn().mockResolvedValue(undefined);

      const marks = await detectStaleClaims({
        activeRuns: new ActiveRunRegistry(),
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi: {
          addLabelsToIssue,
          listOpenIssues: vi.fn().mockResolvedValue([])
        },
        logger,
        pollStatus: pollStatusWithFiltered([issue]),
        projects: new Map([[project.name, project]]),
        runStore: store
      });

      expect(addLabelsToIssue).toHaveBeenCalledWith({
        issueNumber: 7,
        labels: ["sym:stale"],
        owner: "pmatos",
        repo: "symphonika",
        token: "secret"
      });
      expect(issue.labels).toContain("sym:stale");
      expect(marks).toEqual([{ project: project.name, issueNumber: 7 }]);
    });
  });

  it("preserves `this` when calling addLabelsToIssue on a class-based API", async () => {
    await withRunStore(async (store) => {
      const issue = snapshot({ labels: ["agent-ready", "sym:claimed"] });

      class StubApi {
        readonly calls: Array<{ issueNumber: number; labels: string[] }> = [];
        addLabelsToIssue(input: {
          issueNumber: number;
          labels: string[];
          owner: string;
          repo: string;
          token: string;
        }): Promise<void> {
          this.calls.push({ issueNumber: input.issueNumber, labels: input.labels });
          return Promise.resolve();
        }
        listOpenIssues(): Promise<never[]> {
          return Promise.resolve([]);
        }
      }
      const api = new StubApi();

      const marks = await detectStaleClaims({
        activeRuns: new ActiveRunRegistry(),
        env: { GITHUB_TOKEN: "secret" },
        githubIssuesApi: api,
        logger,
        pollStatus: pollStatusWithFiltered([issue]),
        projects: new Map([[project.name, project]]),
        runStore: store
      });

      expect(api.calls).toEqual([{ issueNumber: 7, labels: ["sym:stale"] }]);
      expect(marks).toEqual([{ project: project.name, issueNumber: 7 }]);
    });
  });
});
