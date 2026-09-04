import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { IssuePollStatus, IssueSnapshot } from "../src/issue-polling.js";
import { ActiveRunRegistry } from "../src/lifecycle/active-runs.js";
import { createAsyncMutex } from "../src/lifecycle/async-mutex.js";
import {
  RunController,
  type RunControllerProjectConfig
} from "../src/lifecycle/run-controller.js";
import type { AgentProvider, ProviderEvent } from "../src/provider.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];
const openStores: RunStore[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-fresh-fail-race-")
  );
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("dispatchOneFresh: failFreshDispatchBeforeProvider suppression race", () => {
  it("re-checks suppression under dispatchMutex instead of the pre-claim snapshot", async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, "WORKFLOW.md"), "Work on this Issue.\n");
    const stateRoot = path.join(root, "state");
    const runStore = openRunStore({ stateRoot });
    openStores.push(runStore);
    runStore.syncProjectStates([{ name: "alpha", weight: 1 }]);

    const project: RunControllerProjectConfig = {
      agent: { provider: "codex" },
      issue_filters: {
        labels_all: ["agent-ready"],
        labels_none: [],
        states: ["open"]
      },
      mode: "dispatch",
      name: "alpha",
      priority: { default: 99, labels: {} },
      tracker: {
        kind: "github",
        owner: "acme",
        repo: "alpha",
        token: "$GITHUB_TOKEN"
      },
      weight: 1,
      workflow: { format: "auto", path: "WORKFLOW.md" },
      workspace: {
        git: {
          base_branch: "main",
          remote: "git@github.com:acme/alpha.git"
        },
        root: path.join(root, "workspaces", "alpha")
      }
    };

    // Held externally before dispatch starts; the spy records when the
    // controller actually asks for it so the test can plant a concurrent
    // verdict at the exact moment the fix's suppression re-check would
    // observe it.
    const realMutex = createAsyncMutex();
    await realMutex.acquire();
    const acquireSpy = vi.spyOn(realMutex, "acquire");

    const addLabelsToIssue = vi.fn().mockResolvedValue(undefined);
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      async *runAttempt(): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      },
      validate: vi.fn().mockResolvedValue(undefined)
    };

    const controller = new RunController({
      activeRuns: new ActiveRunRegistry(),
      // Registered so pickTargetFromCandidates treats "alpha" as eligible;
      // providersLoader below omits its command so dispatchOneFresh takes
      // the provider_command_missing -> failFreshDispatchBeforeProvider path.
      agentProviders: { codex: provider },
      configDir: root,
      createRunId: () => "candidate-run-1",
      dispatchMutex: realMutex,
      emailConfigLoader: () => undefined,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi: {
        addLabelsToIssue,
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      },
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 0 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      projectsLoader: () => Promise.resolve(new Map([["alpha", project]])),
      providersLoader: () =>
        Promise.resolve({
          claude: { command: "claude" },
          codex: { command: "" }
        }),
      runStore,
      schedule: () => true,
      stateRoot
    });

    const candidate = issue({ number: 2, title: "Candidate" });

    try {
      const dispatchPromise = controller.dispatchOneFresh(
        pollStatus(candidate)
      );

      // Pre-fix, failFreshDispatchBeforeProvider never touches dispatchMutex
      // at all, so this observes the spy staying uncalled and times out --
      // a genuine failure, not a vacuous assertion.
      await vi.waitFor(
        () => {
          expect(acquireSpy).toHaveBeenCalledTimes(1);
        },
        { timeout: 2000 }
      );

      // A concurrent run for the SAME issue records its blocked/
      // no_workspace_changes verdict while failFreshDispatchBeforeProvider is
      // still waiting on the mutex -- exactly the window issue #693
      // describes.
      runStore.createRun({
        id: "prior-blocked-run",
        issue: candidate,
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex"
      });
      runStore.recordTerminalReason(
        "prior-blocked-run",
        "no_workspace_changes",
        "deterministic"
      );
      runStore.updateRunState("prior-blocked-run", "blocked");

      realMutex.release();

      const result = await dispatchPromise;

      expect(result.dispatched).toBe(false);
      if (!result.dispatched) {
        expect(result.reason).toContain("suppressed");
      }
      expect(runStore.getRun("candidate-run-1")).toBeUndefined();
      expect(
        addLabelsToIssue.mock.calls.some((call) =>
          (call[0] as { labels: string[] }).labels.includes("sym:claimed")
        )
      ).toBe(false);
    } finally {
      if (realMutex.held) {
        realMutex.release();
      }
    }
  });
});

function issue(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    body: "",
    created_at: "2026-09-01T00:00:00.000Z",
    id: overrides.number ?? 1,
    labels: ["agent-ready"],
    number: 1,
    priority: 1,
    state: "open",
    title: "Issue",
    updated_at: "2026-09-01T00:00:00.000Z",
    url: "https://example.test/issues/1",
    ...overrides
  };
}

function pollStatus(candidate: IssueSnapshot): IssuePollStatus {
  return {
    candidateIssues: [
      {
        issue: candidate,
        project: "alpha",
        repository: { owner: "acme", repo: "alpha" }
      }
    ],
    errors: [],
    filteredIssues: [],
    projects: []
  };
}
