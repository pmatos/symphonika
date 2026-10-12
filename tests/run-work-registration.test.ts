import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { IssueSnapshot } from "../src/issue-polling.js";
import { ActiveRunRegistry } from "../src/lifecycle/active-runs.js";
import {
  RunController,
  type RunControllerProjectConfig,
  type ScheduleHandler
} from "../src/lifecycle/run-controller.js";
import { ScheduledWorkRegistry } from "../src/lifecycle/scheduled-work.js";
import type { AgentProvider } from "../src/provider.js";
import { openRunStore } from "../src/run-store.js";

const issue: IssueSnapshot = {
  body: "Work on the issue.",
  created_at: "2026-10-01T00:00:00Z",
  id: 7,
  labels: ["agent-ready", "sym:claimed"],
  number: 7,
  priority: 1,
  state: "open",
  title: "Delayed work",
  updated_at: "2026-10-01T00:00:00Z",
  url: "https://github.com/pmatos/symphonika/issues/7"
};

const project: RunControllerProjectConfig = {
  agent: { provider: "codex" },
  issue_filters: {
    labels_none: [],
    ready_label: "agent-ready",
    states: ["open"]
  },
  max_in_flight: 1,
  mode: "dispatch",
  name: "symphonika",
  priority: { default: 99, labels: {} },
  tracker: {
    kind: "github",
    owner: "pmatos",
    repo: "symphonika",
    token: "$GITHUB_TOKEN"
  },
  workflow: { format: "raw_fsm", path: "workflow.yml" },
  workspace: {
    git: {
      base_branch: "main",
      remote: "https://github.com/pmatos/symphonika.git"
    },
    root: "./workspaces"
  }
};

describe("delayed Run work registration", () => {
  it.each(["state_advance", "continuation"] as const)(
    "%s contention cancels the parent when an accepted timer is cleared",
    async (kind) => {
      await checkContentionShutdown(kind, "cleared");
    }
  );

  it.each(["state_advance", "continuation"] as const)(
    "%s contention cancels the parent when registration is refused",
    async (kind) => {
      await checkContentionShutdown(kind, "refused");
    }
  );
});

async function checkContentionShutdown(
  kind: "state_advance" | "continuation",
  shutdown: "cleared" | "refused"
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-run-work-"));
  const store = openRunStore({ stateRoot: root });
  const scheduledWork = new ScheduledWorkRegistry();
  try {
    await writeFile(
      path.join(root, "workflow.yml"),
      `workflow:
  name: delayed_work
  initial: work
  states:
    work:
      action: { kind: agent, provider: codex, prompt: work.md }
      transitions:
        - { to: done }
    done: { terminal: success }
`
    );
    store.createRun({
      id: "parent",
      issue,
      projectName: project.name,
      providerCommand: "codex app-server",
      providerName: "codex"
    });
    store.setRunCurrentState("parent", "work");
    store.updateRunState("parent", "succeeded");
    store.completeRunNotifications({ runIds: ["parent"], state: "skipped" });
    const activeRuns = new ActiveRunRegistry();
    activeRuns.reserveSlot({
      issueNumber: 8,
      projectName: project.name,
      runId: "other-issue"
    });
    const removeLabelsFromIssue = vi.fn().mockResolvedValue(undefined);
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(),
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const schedule = vi.fn<ScheduleHandler>((item) =>
      scheduledWork.scheduleDelayed(item)
    );
    if (shutdown === "refused") {
      await scheduledWork.cancelAll();
    }
    const controller = new RunController({
      activeRuns,
      agentProviders: { codex: provider },
      configDir: root,
      createRunId: () => "prospective-child",
      emailConfigLoader: () => undefined,
      env: { GITHUB_TOKEN: "test-token" },
      githubIssuesApi: {
        addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
        getIssue: vi.fn().mockResolvedValue(issue),
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue
      },
      lifecyclePolicy: {
        continuation: { cap: 3, delayMs: 60_000 },
        retry: { cap: 3, delaysMs: [60_000], maxBackoffMs: 60_000 }
      },
      projectsLoader: () => Promise.resolve(new Map([[project.name, project]])),
      providersLoader: () =>
        Promise.resolve({
          claude: { command: "claude -p" },
          codex: { command: "codex app-server" }
        }),
      runStore: store,
      schedule,
      stateRoot: root
    });
    const payload = { issue, parentRunId: "parent", projectName: project.name };
    if (kind === "state_advance") {
      await controller.executeStateAdvance({ ...payload, toStateId: "work" });
    } else {
      await controller.executeContinuation(payload);
    }

    expect(schedule).toHaveBeenCalledOnce();
    expect(schedule.mock.calls[0]?.[0]).toMatchObject({
      delayMs: 60_000,
      issueNumber: 7,
      kind,
      projectName: project.name,
      runId: "prospective-child"
    });
    if (shutdown === "cleared") {
      expect(store.getRun("parent")?.state).toBe("succeeded");
      expect(store.listPendingRunNotifications()).toEqual([]);
      await scheduledWork.cancelAll();
    }
    expect(store.getRun("prospective-child")).toBeUndefined();
    expect(store.getRun("parent")).toMatchObject({
      cancelReason: "daemon_shutdown",
      currentStateId: "work",
      retryCount: 0,
      state: "cancelled",
      terminalReason: "daemon_shutdown"
    });
    expect(store.listPendingRunNotifications().map((run) => run.id)).toEqual([
      "parent"
    ]);
    expect(removeLabelsFromIssue).toHaveBeenCalledWith({
      issueNumber: 7,
      labels: ["sym:running"],
      owner: "pmatos",
      repo: "symphonika",
      token: "test-token"
    });
    expect(provider.runAttempt).not.toHaveBeenCalled();
    expect(scheduledWork.peekDelayed()).toEqual([]);
  } finally {
    await scheduledWork.cancelAll();
    store.close();
    await rm(root, { force: true, recursive: true });
  }
}
