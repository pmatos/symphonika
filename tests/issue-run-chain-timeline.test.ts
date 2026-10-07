import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import type { IssueSnapshot } from "../src/issue-polling.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-issue-run-chain-timeline-test-")
  );
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

type TestSetup = {
  cleanup: () => void;
  runStore: RunStore;
  stateRoot: string;
};

async function setup(): Promise<TestSetup> {
  const stateRoot = await makeTempRoot();
  const runStore = openRunStore({ stateRoot });
  runStore.syncProjectStates([
    { name: "alpha", validationState: "valid", weight: 1 }
  ]);
  return {
    cleanup: () => runStore.close(),
    runStore,
    stateRoot
  };
}

function seedSnapshot(
  runStore: RunStore,
  issueNumber: number,
  title: string
): void {
  runStore.replaceProjectIssueSnapshots({
    polledAt: "2026-10-01T00:00:00.000Z",
    projectName: "alpha",
    repository: { owner: "pmatos", repo: "alpha" },
    rows: [
      {
        blockedBy: [],
        blockedByTruncated: false,
        issueNumber,
        kind: "candidate",
        labels: ["agent-ready"],
        priority: 1,
        reasons: [],
        title
      }
    ]
  });
}

async function writeGraph(
  stateRoot: string,
  runId: string,
  graph: Record<string, unknown>
): Promise<string> {
  const evidenceDir = path.join(stateRoot, "logs", "runs", runId);
  await mkdir(evidenceDir, { recursive: true });
  const graphPath = path.join(evidenceDir, "workflow-graph.json");
  await writeFile(graphPath, JSON.stringify(graph));
  return graphPath;
}

const IMPLEMENT_THEN_WAIT_GRAPH = {
  contentHash: `sha256:${"a".repeat(64)}`,
  initial: "implement",
  name: "implement_then_wait",
  source: { kind: "raw_fsm", path: "/repo/workflow.yml" },
  states: [
    {
      action: { kind: "agent", provider: "claude", prompt: "implement.md" },
      completeWhen: {},
      id: "implement",
      transitions: [
        { to: "review_wait", when: { provider_success: true } },
        { to: "blocked_state", when: {} }
      ]
    },
    {
      action: { kind: "wait" },
      completeWhen: {},
      id: "review_wait",
      transitions: [{ to: "done", when: { checks: "success" } }]
    },
    { completeWhen: {}, id: "done", terminal: "success", transitions: [] },
    {
      completeWhen: {},
      id: "blocked_state",
      terminal: "blocked",
      transitions: []
    }
  ]
};

describe("GET /issues/:project/:number — Run Chain timeline (#859)", () => {
  it("renders the completed agent state and the current waiting state", async () => {
    const test = await setup();
    try {
      seedSnapshot(test.runStore, 42, "Add retry support");
      const issue = sampleIssue({ number: 42, title: "Add retry support" });

      const graphPath = await writeGraph(
        test.stateRoot,
        "root-1",
        IMPLEMENT_THEN_WAIT_GRAPH
      );
      test.runStore.createRun({
        id: "root-1",
        issue,
        projectName: "alpha",
        providerCommand: "claude",
        providerName: "claude"
      });
      test.runStore.createAttempt({
        attemptNumber: 1,
        branchName: "sym/alpha/42",
        branchRef: "refs/heads/sym/alpha/42",
        id: "root-1-attempt-1",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        providerCommand: "claude",
        providerName: "claude",
        rawLogPath: "",
        runId: "root-1",
        state: "succeeded",
        workflowGraphPath: graphPath,
        workspacePath: test.stateRoot
      });
      test.runStore.updateRunEvidence("root-1", {
        branchName: "sym/alpha/42",
        branchRef: "refs/heads/sym/alpha/42",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        rawLogPath: "",
        workflowGraphPath: graphPath,
        workspacePath: test.stateRoot
      });
      test.runStore.recordWorkflowStateAdvance("root-1", {
        nextStateId: "review_wait",
        transitionReason: "provider_success"
      });
      test.runStore.updateRunState("root-1", "succeeded");

      test.runStore.createWaitingRun({
        branchName: "sym/alpha/42",
        currentStateId: "review_wait",
        id: "wait-1",
        issue,
        parentRunId: "root-1",
        projectName: "alpha",
        workspacePath: test.stateRoot
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues/alpha/42")).text();

      // Completed row: the root Run actually executed "implement", even
      // though root-1's own current_state_id now reads "review_wait"
      // (forward-stamped for the continuation it handed off to).
      expect(html).toContain("implement");
      expect(html).toContain('href="/runs/root-1"');
      expect(html).toContain("provider_success");
      expect(html).toContain("claude");

      // Current row: the waiting Run is parked at review_wait.
      expect(html).toContain("review_wait");
      expect(html).toContain('href="/runs/wait-1"');

      // One-hop upcoming from review_wait.
      expect(html).toContain("done");
    } finally {
      test.cleanup();
    }
  });

  it("renders two unrelated Run Chains on the same Issue as separate sections, never merged", async () => {
    const test = await setup();
    try {
      seedSnapshot(test.runStore, 77, "Flaky dispatch retried fresh");
      const issue = sampleIssue({
        number: 77,
        title: "Flaky dispatch retried fresh"
      });

      // Chain 1: an earlier, independent dispatch that reached an FSM
      // terminal (no continuation link to chain 2 — distinct root). Pinned
      // to an earlier wall-clock instant than chain 2 so createdAt ordering
      // is deterministic rather than a same-millisecond race.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
      test.runStore.createRun({
        id: "chain1-root",
        issue,
        projectName: "alpha",
        providerCommand: "claude",
        providerName: "claude"
      });
      test.runStore.setRunCurrentState("chain1-root", "chain1_only_state");
      test.runStore.recordWorkflowTerminal("chain1-root", {
        terminalStateId: "chain1_only_state",
        transitionReason: "entered terminal state failure"
      });
      test.runStore.updateRunState("chain1-root", "failed");
      vi.useRealTimers();

      // Chain 2: a brand-new dispatch created later, unrelated to chain 1.
      test.runStore.createRun({
        id: "chain2-root",
        issue,
        projectName: "alpha",
        providerCommand: "claude",
        providerName: "claude"
      });
      test.runStore.createWaitingRun({
        currentStateId: "chain2_only_state",
        id: "chain2-wait",
        issue,
        parentRunId: "chain2-root",
        projectName: "alpha"
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues/alpha/77")).text();

      expect(html).toContain('href="/runs/chain1-root"');
      expect(html).toContain('href="/runs/chain2-root"');
      expect(html).toContain('href="/runs/chain2-wait"');

      // The newer chain (chain 2) renders as the open, primary section; the
      // older one is tucked into its own <details> rather than interleaved
      // into chain 2's table.
      const primarySection = html.slice(
        html.indexOf("Run Chain</h2>"),
        html.indexOf("<details>")
      );
      expect(primarySection).toContain("chain2_only_state");
      expect(primarySection).not.toContain("chain1_only_state");

      const olderSection = html.slice(html.indexOf("<details>"));
      expect(olderSection).toContain("chain1_only_state");
      expect(olderSection).not.toContain("chain2_only_state");
    } finally {
      test.cleanup();
    }
  });

  it("renders a terminal chain with no upcoming section", async () => {
    const test = await setup();
    try {
      seedSnapshot(test.runStore, 90, "Ships clean");
      const issue = sampleIssue({ number: 90, title: "Ships clean" });
      const graphPath = await writeGraph(test.stateRoot, "term-root", {
        contentHash: `sha256:${"b".repeat(64)}`,
        initial: "implement",
        name: "implement_then_terminal",
        source: { kind: "raw_fsm", path: "/repo/workflow.yml" },
        states: [
          {
            action: { kind: "agent", provider: "claude", prompt: "x.md" },
            completeWhen: {},
            id: "implement",
            transitions: [{ to: "done", when: {} }]
          },
          { completeWhen: {}, id: "done", terminal: "failure", transitions: [] }
        ]
      });
      test.runStore.createRun({
        id: "term-root",
        issue,
        projectName: "alpha",
        providerCommand: "claude",
        providerName: "claude"
      });
      test.runStore.updateRunEvidence("term-root", {
        branchName: "sym/alpha/90",
        branchRef: "refs/heads/sym/alpha/90",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        rawLogPath: "",
        workflowGraphPath: graphPath,
        workspacePath: test.stateRoot
      });
      test.runStore.recordWorkflowTerminal("term-root", {
        terminalStateId: "done",
        transitionReason: "entered terminal state failure"
      });
      test.runStore.updateRunState("term-root", "failed");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues/alpha/90")).text();

      expect(html).toContain("Finished: failure");
      expect(html).not.toContain("Upcoming");
    } finally {
      test.cleanup();
    }
  });

  it("renders a blocked chain distinctly from a terminal one", async () => {
    const test = await setup();
    try {
      seedSnapshot(test.runStore, 91, "Stuck without outside change");
      const issue = sampleIssue({
        number: 91,
        title: "Stuck without outside change"
      });
      test.runStore.createRun({
        id: "blocked-root",
        issue,
        projectName: "alpha",
        providerCommand: "claude",
        providerName: "claude"
      });
      test.runStore.setRunCurrentState("blocked-root", "stuck_state");
      test.runStore.recordWorkflowBlocked("blocked-root", {
        stateId: "stuck_state",
        transitionReason: "no matching transition"
      });
      test.runStore.updateRunState("blocked-root", "blocked");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues/alpha/91")).text();

      expect(html).toContain("stuck_state");
      expect(html).toContain("no matching transition");
      expect(html).not.toContain("Finished");
    } finally {
      test.cleanup();
    }
  });

  it("shows a retried Run's full attempt count on its one state row", async () => {
    const test = await setup();
    try {
      seedSnapshot(test.runStore, 92, "Flaky provider, retried in place");
      const issue = sampleIssue({
        number: 92,
        title: "Flaky provider, retried in place"
      });
      const graphPath = await writeGraph(test.stateRoot, "retry-root", {
        contentHash: `sha256:${"c".repeat(64)}`,
        initial: "implement",
        name: "retried_implement",
        source: { kind: "raw_fsm", path: "/repo/workflow.yml" },
        states: [
          {
            action: { kind: "agent", provider: "codex", prompt: "x.md" },
            completeWhen: {},
            id: "implement",
            transitions: [{ to: "done", when: {} }]
          },
          { completeWhen: {}, id: "done", terminal: "success", transitions: [] }
        ]
      });
      test.runStore.createRun({
        id: "retry-root",
        issue,
        projectName: "alpha",
        providerCommand: "codex",
        providerName: "codex"
      });
      test.runStore.createAttempt({
        attemptNumber: 1,
        branchName: "sym/alpha/92",
        branchRef: "refs/heads/sym/alpha/92",
        id: "retry-root-attempt-1",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        providerCommand: "codex",
        providerName: "codex",
        rawLogPath: "",
        runId: "retry-root",
        state: "failed",
        workflowGraphPath: graphPath,
        workspacePath: test.stateRoot
      });
      test.runStore.incrementRetryCount("retry-root");
      test.runStore.createAttempt({
        attemptNumber: 2,
        branchName: "sym/alpha/92",
        branchRef: "refs/heads/sym/alpha/92",
        id: "retry-root-attempt-2",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        providerCommand: "codex",
        providerName: "codex",
        rawLogPath: "",
        runId: "retry-root",
        state: "running",
        workflowGraphPath: graphPath,
        workspacePath: test.stateRoot
      });
      test.runStore.updateRunEvidence("retry-root", {
        branchName: "sym/alpha/92",
        branchRef: "refs/heads/sym/alpha/92",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        rawLogPath: "",
        workflowGraphPath: graphPath,
        workspacePath: test.stateRoot
      });
      test.runStore.updateRunState("retry-root", "running");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues/alpha/92")).text();

      expect(html).toContain("implement");
      expect(html).toContain("2 attempts");
    } finally {
      test.cleanup();
    }
  });

  it("describes a missing workflow graph honestly instead of guessing", async () => {
    const test = await setup();
    try {
      seedSnapshot(test.runStore, 93, "Adopted from an open PR");
      const issue = sampleIssue({
        number: 93,
        title: "Adopted from an open PR"
      });
      // An adopted Run never dispatches a provider, so it never captures a
      // workflow graph of its own (AC3: described honestly, never guessed).
      test.runStore.createAdoptedRun({
        branchName: "sym/alpha/93",
        currentStateId: "wait_for_pr_open",
        id: "adopted-root",
        issue,
        projectName: "alpha",
        workspacePath: test.stateRoot
      });
      // Advancing past the park state overwrites current_state_id to the
      // handoff target, so the adopted Run's own executed state becomes
      // unrecoverable once it has a continuation (advisor rule 3).
      test.runStore.recordWorkflowStateAdvance("adopted-root", {
        nextStateId: "implement_fix",
        transitionReason: "checks: success"
      });
      test.runStore.updateRunState("adopted-root", "succeeded");
      test.runStore.createContinuationRun({
        id: "adopted-child",
        issue,
        parentRunId: "adopted-root",
        projectName: "alpha",
        providerCommand: "codex",
        providerName: "codex"
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/issues/alpha/93");
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("not recorded");
      expect(html).toContain('href="/runs/adopted-root"');
      expect(html).toContain('href="/runs/adopted-child"');
    } finally {
      test.cleanup();
    }
  });

  it("shows project-default provider source, multi-way upcoming predicates, and a tracked PR", async () => {
    const test = await setup();
    try {
      seedSnapshot(test.runStore, 94, "Needs review before merge");
      const issue = sampleIssue({
        number: 94,
        title: "Needs review before merge"
      });
      const graphPath = await writeGraph(test.stateRoot, "pr-root", {
        contentHash: `sha256:${"d".repeat(64)}`,
        initial: "implement",
        name: "implement_then_merge_wait",
        source: { kind: "raw_fsm", path: "/repo/workflow.yml" },
        states: [
          {
            // No explicit `provider` — resolves to the Project default.
            action: { kind: "agent", prompt: "x.md" },
            completeWhen: {},
            id: "implement",
            transitions: [{ to: "merge_wait", when: {} }]
          },
          {
            action: { kind: "merge_pr" },
            completeWhen: {},
            id: "merge_wait",
            transitions: [
              { to: "done", when: { checks: "success", review: "approved" } },
              { to: "blocked_state", when: {} }
            ]
          },
          {
            completeWhen: {},
            id: "done",
            terminal: "success",
            transitions: []
          },
          {
            completeWhen: {},
            id: "blocked_state",
            terminal: "blocked",
            transitions: []
          }
        ]
      });
      test.runStore.createRun({
        id: "pr-root",
        issue,
        projectName: "alpha",
        providerCommand: "codex",
        providerName: "codex"
      });
      test.runStore.createAttempt({
        attemptNumber: 1,
        branchName: "sym/alpha/94",
        branchRef: "refs/heads/sym/alpha/94",
        id: "pr-root-attempt-1",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        providerCommand: "codex",
        providerName: "codex",
        rawLogPath: "",
        runId: "pr-root",
        state: "succeeded",
        workflowGraphPath: graphPath,
        workspacePath: test.stateRoot
      });
      test.runStore.updateRunEvidence("pr-root", {
        branchName: "sym/alpha/94",
        branchRef: "refs/heads/sym/alpha/94",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        rawLogPath: "",
        workflowGraphPath: graphPath,
        workspacePath: test.stateRoot
      });
      test.runStore.recordWorkflowStateAdvance("pr-root", {
        nextStateId: "merge_wait",
        transitionReason: "provider_success"
      });
      test.runStore.updateRunState("pr-root", "succeeded");
      test.runStore.createWaitingRun({
        branchName: "sym/alpha/94",
        currentStateId: "merge_wait",
        id: "pr-wait",
        issue,
        parentRunId: "pr-root",
        projectName: "alpha",
        workspacePath: test.stateRoot
      });
      test.runStore.trackPullRequest({
        branchName: "sym/alpha/94",
        headSha: "deadbeef",
        issueNumber: 94,
        projectName: "alpha",
        prNumber: 501,
        prUrl: "https://github.com/pmatos/alpha/pull/501",
        runId: "pr-wait"
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues/alpha/94")).text();

      expect(html).toContain("project default");
      expect(html).toContain("checks: success");
      expect(html).toContain("review: approved");
      expect(html).toContain("blocked_state");
      expect(html).toContain("https://github.com/pmatos/alpha/pull/501");
      expect(html).toContain("#501");
    } finally {
      test.cleanup();
    }
  });
});
