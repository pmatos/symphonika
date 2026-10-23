import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createProviderRecoveryService,
  type ProviderRecoveryDeps
} from "../src/issues/provider-recovery.js";
import type { RunControllerProjectConfig } from "../src/lifecycle/run-controller.js";
import { createAsyncMutex } from "../src/lifecycle/async-mutex.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];
const stores: RunStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

const rawIssue = {
  body: "",
  created_at: "2026-10-09T09:00:00Z",
  html_url: "https://github.com/acme/widgets/issues/7",
  id: 7,
  labels: [],
  number: 7,
  state: "open",
  title: "Issue",
  updated_at: "2026-10-09T09:00:00Z"
};

function project(
  overrides: Partial<RunControllerProjectConfig> = {}
): RunControllerProjectConfig {
  return {
    agent: { provider: "codex" },
    issue_filters: {
      labels_none: [],
      ready_label: "agent-ready",
      states: ["open"]
    },
    mode: "dispatch",
    name: "widgets",
    priority: { default: 99, labels: {} },
    tracker: {
      kind: "github",
      owner: "acme",
      repo: "widgets",
      token: "$GITHUB_TOKEN"
    },
    weight: 1,
    workflow: {
      body: "",
      contentHash: "sha256:g",
      evidence: { ignore: [] },
      expandedWorkflow: {
        contentHash: "sha256:g",
        initial: "autofix",
        name: "w",
        source: { kind: "raw_fsm", path: "workflow.yml" },
        states: [
          {
            action: { kind: "agent", prompt: "p" },
            completeWhen: {},
            id: "autofix",
            transitions: []
          }
        ]
      },
      format: "raw_fsm",
      path: "workflow.yml"
    },
    workspace: {
      git: { base_branch: "main", remote: "git@github.com:acme/widgets.git" },
      root: "/tmp/ws"
    },
    ...overrides
  } as unknown as RunControllerProjectConfig;
}

async function setup(
  overrides: {
    deps?: Partial<ProviderRecoveryDeps>;
    project?: RunControllerProjectConfig | undefined;
  } = {}
) {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-recovery-unit-"));
  tempRoots.push(root);
  const runStore = openRunStore({ stateRoot: root });
  stores.push(runStore);
  runStore.createRun({
    id: "run-1",
    issue: {
      body: "",
      created_at: "2026-10-09T09:00:00Z",
      id: 7,
      labels: [],
      number: 7,
      priority: 0,
      state: "open",
      title: "Issue",
      updated_at: "2026-10-09T09:00:00Z",
      url: "https://github.com/acme/widgets/issues/7"
    },
    projectName: "widgets",
    providerCommand: "codex",
    providerName: "codex"
  });
  runStore.setRunCurrentState("run-1", "autofix");
  runStore.updateRunState("run-1", "failed");
  const scheduleRecovery = vi.fn().mockReturnValue(true);
  const getIssue = vi.fn().mockResolvedValue(rawIssue);
  const deps: ProviderRecoveryDeps = {
    checkLiveRun: () => undefined,
    createInterventionId: () => "int-1",
    dispatchMutex: createAsyncMutex(),
    getProject: () => ("project" in overrides ? overrides.project : project()),
    getProvidersConfig: () => ({
      claude: { command: "claude" },
      codex: { command: "codex" }
    }),
    githubIssuesApi: {
      getIssue,
      listOpenIssues: vi.fn().mockResolvedValue([])
    },
    hasPendingShutdownResume: () => false,
    isProviderRegistered: () => true,
    resolveToken: () => "token",
    runStore,
    scheduleRecovery,
    ...overrides.deps
  };
  return {
    getIssue,
    recover: (provider = "claude") =>
      createProviderRecoveryService(deps).recover({
        issueNumber: 7,
        projectName: "widgets",
        provider,
        requestedVia: "test",
        runId: "run-1",
        stateId: "autofix"
      }),
    runStore,
    scheduleRecovery
  };
}

describe("createProviderRecoveryService", () => {
  it("accepts and schedules a recovery of a failed agent state", async () => {
    const { recover, scheduleRecovery } = await setup();

    expect(await recover()).toEqual({
      fromRunId: "run-1",
      interventionId: "int-1",
      kind: "accepted",
      stateId: "autofix",
      toProvider: "claude"
    });
    expect(scheduleRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        interventionId: "int-1",
        parentRunId: "run-1",
        provider: "claude",
        toStateId: "autofix"
      })
    );
  });

  it("refuses a Project that is missing, disabled or not a dispatch Project", async () => {
    for (const unavailable of [
      undefined,
      project({ disabled: true }),
      project({ mode: "routine_host" })
    ]) {
      const { recover, scheduleRecovery } = await setup({
        project: unavailable
      });
      expect(await recover()).toMatchObject({
        kind: "refused",
        reason: "not-a-dispatch-project"
      });
      expect(scheduleRecovery).not.toHaveBeenCalled();
    }
  });

  it("refuses a provider that is configured but not registered", async () => {
    const { recover } = await setup({
      deps: { isProviderRegistered: () => false }
    });
    expect(await recover()).toMatchObject({ reason: "provider-unavailable" });
  });

  it("refuses when the Run's repository is not the Project's tracker", async () => {
    const { recover } = await setup({
      project: project({
        tracker: {
          kind: "github",
          owner: "acme",
          repo: "elsewhere",
          token: "$GITHUB_TOKEN"
        }
      })
    });
    expect(await recover()).toMatchObject({ reason: "repository-mismatch" });
  });

  it("refuses while a shutdown resume of the Run is pending", async () => {
    const { recover } = await setup({
      deps: { hasPendingShutdownResume: () => true }
    });
    expect(await recover()).toMatchObject({ reason: "live-run" });
  });

  it("reports an unavailable token and unreadable Issue as errors, not refusals", async () => {
    const noToken = await setup({ deps: { resolveToken: () => undefined } });
    expect(await noToken.recover()).toMatchObject({ kind: "error" });

    const missing = await setup();
    missing.getIssue.mockResolvedValue(null);
    expect(await missing.recover()).toMatchObject({ kind: "error" });

    const throwing = await setup();
    throwing.getIssue.mockRejectedValue(new Error("boom"));
    expect(await throwing.recover()).toMatchObject({
      error: expect.stringContaining("boom") as unknown,
      kind: "error"
    });
    expect(throwing.scheduleRecovery).not.toHaveBeenCalled();
  });

  it("rechecks under the mutex and refuses a reservation that appeared after the GitHub read", async () => {
    let reads = 0;
    const { recover, runStore, scheduleRecovery } = await setup({
      deps: {
        checkLiveRun: () => {
          reads += 1;
          return reads > 1 ? "run-live" : undefined;
        }
      }
    });
    expect(await recover()).toMatchObject({
      liveRunId: "run-live",
      reason: "live-run"
    });
    expect(scheduleRecovery).not.toHaveBeenCalled();
    expect(runStore.getRun("run-1")?.state).toBe("failed");
  });

  it("settles the intervention as dropped when the daemon refuses the work", async () => {
    const { recover, runStore, scheduleRecovery } = await setup();
    scheduleRecovery.mockReturnValue(false);

    expect(await recover()).toMatchObject({ reason: "shutting-down" });
    expect(
      runStore.settleProviderIntervention(
        { id: "int-1" },
        { error: "again", outcome: "dropped" }
      )
    ).toBe(false);
  });

  it("settles the intervention as failed and reports an error when scheduling throws", async () => {
    const { recover, runStore, scheduleRecovery } = await setup();
    scheduleRecovery.mockImplementation(() => {
      throw new Error("duplicate key");
    });

    expect(await recover()).toMatchObject({
      error: "duplicate key",
      kind: "error"
    });
    expect(
      runStore.settleProviderIntervention(
        { id: "int-1" },
        { error: "again", outcome: "dropped" }
      )
    ).toBe(false);
  });

  it("refuses a second recovery of a Run whose intervention is still scheduled", async () => {
    const { recover, runStore } = await setup();
    expect(await recover()).toMatchObject({ kind: "accepted" });
    // The first launch has produced no Run yet, so the Run is still the head;
    // only the unique open-intervention index stands between a double submit
    // and a second launch.
    expect(runStore.isIssueHeadRun("run-1")).toBe(true);

    expect(await recover()).toMatchObject({
      kind: "refused",
      reason: "duplicate"
    });
  });
});
