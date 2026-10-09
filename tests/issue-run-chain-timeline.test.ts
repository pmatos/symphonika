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

  it("renders a Run escalated to blocked via recordWorkflowTerminal as blocked, not finished", async () => {
    const test = await setup();
    try {
      // Mirrors terminateMergePrRefusal/terminateNoPullRequestTracked's
      // shape: recordWorkflowTerminal nulls current_state_id like any other
      // terminal write, but RunState becomes "blocked" (escalation), never a
      // graph-declared terminal node -- so the borrowed wait/merge_pr state
      // has no `terminal` field at all.
      seedSnapshot(test.runStore, 94, "Merge PR refused, escalated");
      const issue = sampleIssue({
        number: 94,
        title: "Merge PR refused, escalated"
      });
      const graphPath = await writeGraph(test.stateRoot, "escalated-root", {
        contentHash: `sha256:${"d".repeat(64)}`,
        initial: "merge_wait",
        name: "merge_then_done",
        source: { kind: "raw_fsm", path: "/repo/workflow.yml" },
        states: [
          {
            action: { kind: "merge_pr" },
            completeWhen: {},
            id: "merge_wait",
            transitions: [{ to: "done", when: { merged: true } }]
          },
          { completeWhen: {}, id: "done", terminal: "success", transitions: [] }
        ]
      });
      test.runStore.createRun({
        id: "escalated-root",
        issue,
        projectName: "alpha",
        providerCommand: "claude",
        providerName: "claude"
      });
      test.runStore.updateRunEvidence("escalated-root", {
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
      test.runStore.recordWorkflowTerminal("escalated-root", {
        terminalStateId: "merge_wait",
        transitionReason: "merge PR refused"
      });
      test.runStore.updateRunState("escalated-root", "blocked");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues/alpha/94")).text();

      expect(html).not.toContain("Finished");
      expect(html).toContain("Blocked");
    } finally {
      test.cleanup();
    }
  });

  it("renders a Run reusing an earlier success terminal, then escalated to blocked, as blocked", async () => {
    const test = await setup();
    try {
      // Mirrors terminalizePullRequestDiscoveryExhausted's shape: the Run
      // already recorded a genuine success terminal; only RunState and the
      // claim labels change afterward. terminal_state_id/current_state_id
      // are deliberately left untouched, so this Run's leaf row reaches the
      // "currentStateId === null && terminalStateId !== null" branch with a
      // real success terminal node -- the RunState fact "needs an operator"
      // must still win over that reused "success" flavor.
      seedSnapshot(test.runStore, 95, "Succeeded, but no PR ever appeared");
      const issue = sampleIssue({
        number: 95,
        title: "Succeeded, but no PR ever appeared"
      });
      const graphPath = await writeGraph(test.stateRoot, "exhausted-root", {
        contentHash: `sha256:${"e".repeat(64)}`,
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
          { completeWhen: {}, id: "done", terminal: "success", transitions: [] }
        ]
      });
      test.runStore.createRun({
        id: "exhausted-root",
        issue,
        projectName: "alpha",
        providerCommand: "claude",
        providerName: "claude"
      });
      test.runStore.updateRunEvidence("exhausted-root", {
        branchName: "sym/alpha/95",
        branchRef: "refs/heads/sym/alpha/95",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        rawLogPath: "",
        workflowGraphPath: graphPath,
        workspacePath: test.stateRoot
      });
      test.runStore.recordWorkflowTerminal("exhausted-root", {
        terminalStateId: "done",
        transitionReason: "entered terminal state success"
      });
      test.runStore.updateRunState("exhausted-root", "blocked");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues/alpha/95")).text();

      expect(html).not.toContain("Finished: success");
      expect(html).toContain("Blocked");
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

      // The adopted root genuinely succeeded and advanced — that status
      // must read as "Completed" even though its specific FSM state id
      // isn't recoverable (the unresolved state id, not the Run's RunState
      // fact, is what's honestly unknown here).
      const rootRowStart = html.indexOf('href="/runs/adopted-root"');
      const rootRowHtml = html.slice(
        html.lastIndexOf("<tr ", rootRowStart),
        html.indexOf("</tr>", rootRowStart)
      );
      expect(rootRowHtml).toContain("Completed");
    } finally {
      test.cleanup();
    }
  });

  it("does not crash when a Run's captured workflow graph is missing states", async () => {
    const test = await setup();
    try {
      // readJsonArtifact only catches JSON.parse syntax errors, not shape --
      // a graph captured under an older/incompatible schema reaches the
      // page handler as valid JSON missing `states`.
      seedSnapshot(
        test.runStore,
        97,
        "Captured graph predates a schema change"
      );
      const issue = sampleIssue({
        number: 97,
        title: "Captured graph predates a schema change"
      });
      const graphPath = await writeGraph(test.stateRoot, "malformed-root", {});
      test.runStore.createRun({
        id: "malformed-root",
        issue,
        projectName: "alpha",
        providerCommand: "claude",
        providerName: "claude"
      });
      test.runStore.updateRunEvidence("malformed-root", {
        branchName: "sym/alpha/97",
        branchRef: "refs/heads/sym/alpha/97",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        rawLogPath: "",
        workflowGraphPath: graphPath,
        workspacePath: test.stateRoot
      });
      test.runStore.recordWorkflowTerminal("malformed-root", {
        terminalStateId: "done",
        transitionReason: "entered terminal state success"
      });
      test.runStore.updateRunState("malformed-root", "succeeded");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/issues/alpha/97");

      expect(response.status).toBe(200);
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

  it("keeps a still-waiting parent 'Waiting' even after a PR review follow-up continuation off it", async () => {
    const test = await setup();
    try {
      seedSnapshot(test.runStore, 95, "Markdown contract awaiting review");
      const issue = sampleIssue({
        number: 95,
        title: "Markdown contract awaiting review"
      });

      // dispatchReviewFollowup (src/lifecycle/run-controller.ts) parents a
      // fresh review-followup continuation off `tracked.lastFollowupRunId
      // ?? tracked.runId` directly — unlike a raw-FSM advance, this never
      // calls recordWorkflowStateAdvance on the parent first (raw_fsm
      // workflows own their own review follow-up and never take this
      // path), so the parent stays genuinely `waiting` throughout.
      test.runStore.createRun({
        id: "contract-root",
        issue,
        projectName: "alpha",
        providerCommand: "claude",
        providerName: "claude"
      });
      test.runStore.updateRunState("contract-root", "succeeded");
      test.runStore.createWaitingRun({
        currentStateId: "awaiting_review",
        id: "contract-wait",
        issue,
        parentRunId: "contract-root",
        projectName: "alpha"
      });
      test.runStore.createContinuationRun({
        id: "review-followup",
        issue,
        parentRunId: "contract-wait",
        projectName: "alpha",
        providerCommand: "claude",
        providerName: "claude"
      });
      test.runStore.updateRunState("review-followup", "succeeded");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues/alpha/95")).text();

      // The waiting Run is still live and must read as such, not as
      // "Completed" just because a review-followup continuation exists.
      const waitRowStart = html.indexOf('href="/runs/contract-wait"');
      const waitRowHtml = html.slice(
        html.lastIndexOf("<tr ", waitRowStart),
        html.indexOf("</tr>", waitRowStart)
      );
      expect(waitRowHtml).toContain("Waiting");
      expect(waitRowHtml).not.toContain("Completed");

      // The follow-up's own position was never recorded by this Run (it
      // only inherited a still-live parent's park state) — honest
      // "not recorded" rather than a borrowed "awaiting_review".
      const followupRowStart = html.indexOf('href="/runs/review-followup"');
      const followupRowHtml = html.slice(
        html.lastIndexOf("<tr ", followupRowStart),
        html.indexOf("</tr>", followupRowStart)
      );
      expect(followupRowHtml).toContain("not recorded");
    } finally {
      test.cleanup();
    }
  });

  it("distinguishes a captured-but-unrecoverable state from no graph at all", async () => {
    const test = await setup();
    try {
      // Same still-waiting-parent shape as above, but this time the
      // follow-up Run has its own captured graph -- "not recorded" must not
      // claim the graph itself is unavailable when it's the state id that's
      // unrecoverable.
      seedSnapshot(test.runStore, 98, "Markdown contract, graph captured");
      const issue = sampleIssue({
        number: 98,
        title: "Markdown contract, graph captured"
      });
      test.runStore.createRun({
        id: "graph-root",
        issue,
        projectName: "alpha",
        providerCommand: "claude",
        providerName: "claude"
      });
      test.runStore.updateRunState("graph-root", "succeeded");
      test.runStore.createWaitingRun({
        currentStateId: "review_wait",
        id: "graph-wait",
        issue,
        parentRunId: "graph-root",
        projectName: "alpha"
      });
      test.runStore.createContinuationRun({
        id: "graph-followup",
        issue,
        parentRunId: "graph-wait",
        projectName: "alpha",
        providerCommand: "claude",
        providerName: "claude"
      });
      const graphPath = await writeGraph(
        test.stateRoot,
        "graph-followup",
        IMPLEMENT_THEN_WAIT_GRAPH
      );
      test.runStore.createAttempt({
        attemptNumber: 1,
        branchName: "sym/alpha/98",
        branchRef: "refs/heads/sym/alpha/98",
        id: "graph-followup-attempt-1",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        providerCommand: "claude",
        providerName: "claude",
        rawLogPath: "",
        runId: "graph-followup",
        state: "succeeded",
        workflowGraphPath: graphPath,
        workspacePath: test.stateRoot
      });
      test.runStore.updateRunEvidence("graph-followup", {
        branchName: "sym/alpha/98",
        branchRef: "refs/heads/sym/alpha/98",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        rawLogPath: "",
        workflowGraphPath: graphPath,
        workspacePath: test.stateRoot
      });
      test.runStore.updateRunState("graph-followup", "succeeded");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues/alpha/98")).text();

      const followupRowStart = html.indexOf('href="/runs/graph-followup"');
      const followupRowHtml = html.slice(
        html.lastIndexOf("<tr ", followupRowStart),
        html.indexOf("</tr>", followupRowStart)
      );
      expect(followupRowHtml).toContain(
        "state not found in the captured workflow graph"
      );
      expect(followupRowHtml).not.toContain("workflow graph unavailable");
    } finally {
      test.cleanup();
    }
  });

  it("reflects newly persisted state on a plain refresh; the timeline itself needs no graph JavaScript", async () => {
    const test = await setup();
    try {
      seedSnapshot(test.runStore, 96, "Finishes between two page loads");
      const issue = sampleIssue({
        number: 96,
        title: "Finishes between two page loads"
      });
      const graphPath = await writeGraph(
        test.stateRoot,
        "refresh-root",
        IMPLEMENT_THEN_WAIT_GRAPH
      );
      test.runStore.createRun({
        id: "refresh-root",
        issue,
        projectName: "alpha",
        providerCommand: "claude",
        providerName: "claude"
      });
      test.runStore.updateRunEvidence("refresh-root", {
        branchName: "sym/alpha/96",
        branchRef: "refs/heads/sym/alpha/96",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        rawLogPath: "",
        workflowGraphPath: graphPath,
        workspacePath: test.stateRoot
      });
      test.runStore.recordWorkflowStateAdvance("refresh-root", {
        nextStateId: "review_wait",
        transitionReason: "provider_success"
      });
      test.runStore.updateRunState("refresh-root", "succeeded");
      test.runStore.createWaitingRun({
        branchName: "sym/alpha/96",
        currentStateId: "review_wait",
        id: "refresh-wait",
        issue,
        parentRunId: "refresh-root",
        projectName: "alpha",
        workspacePath: test.stateRoot
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const firstHtml = await (await app.request("/issues/alpha/96")).text();
      const firstSection = firstHtml.slice(
        firstHtml.indexOf("Run Chain</h2>"),
        firstHtml.indexOf("Graph drill-down")
      );
      expect(firstSection).toContain("Waiting");
      expect(firstSection).not.toContain("Finished");
      expect(firstSection).not.toContain("<script");

      // The daemon's own re-evaluation persists this between the two page
      // loads — the test only simulates that persisted outcome.
      test.runStore.recordWorkflowTerminal("refresh-wait", {
        terminalStateId: "done",
        transitionReason: "checks: success"
      });
      test.runStore.updateRunState("refresh-wait", "succeeded");

      const secondHtml = await (await app.request("/issues/alpha/96")).text();
      const secondSection = secondHtml.slice(
        secondHtml.indexOf("Run Chain</h2>"),
        secondHtml.indexOf("Graph drill-down")
      );
      expect(secondSection).toContain("Finished: success");
      expect(secondSection).not.toContain("Waiting");
      expect(secondSection).not.toContain("<script");
    } finally {
      test.cleanup();
    }
  });
});

async function seedImplementThenWaitChain(
  test: TestSetup,
  input: {
    graph?: Record<string, unknown> | false;
    issueNumber: number;
    rootId: string;
    waitId: string;
    attemptProvider?: "claude" | "codex";
  }
): Promise<void> {
  const issue = sampleIssue({ number: input.issueNumber, title: "drill" });
  seedSnapshot(test.runStore, input.issueNumber, "drill");
  const graphPath =
    input.graph === false
      ? ""
      : await writeGraph(
          test.stateRoot,
          input.rootId,
          input.graph ?? IMPLEMENT_THEN_WAIT_GRAPH
        );
  test.runStore.createRun({
    id: input.rootId,
    issue,
    projectName: "alpha",
    providerCommand: "claude",
    providerName: "claude"
  });
  if (input.graph !== false) {
    test.runStore.createAttempt({
      attemptNumber: 1,
      branchName: `sym/alpha/${input.issueNumber}`,
      branchRef: `refs/heads/sym/alpha/${input.issueNumber}`,
      id: `${input.rootId}-attempt-1`,
      issueSnapshotPath: "",
      metadataPath: "",
      normalizedLogPath: "",
      promptPath: "",
      providerCommand: input.attemptProvider ?? "claude",
      providerName: input.attemptProvider ?? "claude",
      rawLogPath: "",
      runId: input.rootId,
      state: "succeeded",
      workflowGraphPath: graphPath,
      workspacePath: test.stateRoot
    });
  }
  test.runStore.updateRunEvidence(input.rootId, {
    branchName: `sym/alpha/${input.issueNumber}`,
    branchRef: `refs/heads/sym/alpha/${input.issueNumber}`,
    issueSnapshotPath: "",
    metadataPath: "",
    normalizedLogPath: "",
    promptPath: "",
    rawLogPath: "",
    workflowGraphPath: graphPath,
    workspacePath: test.stateRoot
  });
  test.runStore.recordWorkflowStateAdvance(input.rootId, {
    nextStateId: "review_wait",
    transitionReason: "provider_success"
  });
  test.runStore.updateRunState(input.rootId, "succeeded");
  test.runStore.createWaitingRun({
    branchName: `sym/alpha/${input.issueNumber}`,
    currentStateId: "review_wait",
    id: input.waitId,
    issue,
    parentRunId: input.rootId,
    projectName: "alpha",
    workspacePath: test.stateRoot
  });
}

function drilldownData(html: string): Array<Record<string, unknown>> {
  return [
    ...html.matchAll(
      /<script type="application\/json" data-chain-graph-data>([\s\S]*?)<\/script>/g
    )
  ].map((match) => JSON.parse(match[1] ?? "{}") as Record<string, unknown>);
}

describe("GET /issues/:project/:number — graph drill-down (#860)", () => {
  it("gives every timeline row a unique id namespaced by its chain root", async () => {
    const test = await setup();
    try {
      await seedImplementThenWaitChain(test, {
        issueNumber: 7,
        rootId: "root-a",
        waitId: "wait-a"
      });
      await seedImplementThenWaitChain(test, {
        issueNumber: 7,
        rootId: "root-b",
        waitId: "wait-b"
      });
      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues/alpha/7")).text();

      const ids = [...html.matchAll(/<tr id="([^"]+)"/g)].map((m) => m[1]);
      expect(ids).toHaveLength(4);
      expect(new Set(ids).size).toBe(4);
      expect(ids).toContain("chain-root-a-state-0");
      expect(ids).toContain("chain-root-b-state-1");
    } finally {
      test.cleanup();
    }
  });

  it("renders a collapsed, server-rendered state outline that links visits to timeline rows", async () => {
    const test = await setup();
    try {
      await seedImplementThenWaitChain(test, {
        attemptProvider: "codex",
        issueNumber: 8,
        rootId: "root-o",
        waitId: "wait-o"
      });
      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues/alpha/8")).text();

      const drilldown = html.slice(html.indexOf("chain-graph-drilldown"));
      expect(html).toContain("Graph drill-down (optional)");
      expect(html).not.toMatch(
        /<details[^>]*chain-graph-drilldown[^>]*\bopen\b/
      );
      expect(drilldown).toContain('data-state-id="implement"');
      expect(drilldown).toContain('data-state-id="review_wait"');
      expect(drilldown).toContain('href="#chain-root-o-state-0"');
      expect(drilldown).toContain('href="#chain-root-o-state-1"');
      // Per-visit provider is the Run's own attempt provider, not the
      // captured graph's declared one.
      expect(drilldown).toMatch(/codex[\s\S]*workflow state \(claude\)/);
      // Current state is named in text with the row-kind label.
      expect(drilldown).toMatch(/Current[\s\S]*Waiting/);
      // The taken transition is marked in text.
      expect(drilldown).toMatch(/review_wait<\/code>[^<]*<[^>]*>[^<]*taken/);
      // Declared-but-untaken transitions and the state's complete-when show.
      expect(drilldown).toContain("blocked_state");
      expect(drilldown).toContain("checks: success");
    } finally {
      test.cleanup();
    }
  });

  it("omits the drill-down and graph scripts when no chain captured a graph", async () => {
    const test = await setup();
    try {
      await seedImplementThenWaitChain(test, {
        graph: false,
        issueNumber: 9,
        rootId: "root-n",
        waitId: "wait-n"
      });
      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues/alpha/9")).text();

      expect(html).not.toContain("Graph drill-down");
      expect(html).not.toContain("cytoscape");
      expect(html).not.toContain("data-chain-graph-data");
    } finally {
      test.cleanup();
    }
  });

  it("embeds escaped graph data and emits the CDN scripts once per page", async () => {
    const test = await setup();
    try {
      const hostileGraph = {
        ...IMPLEMENT_THEN_WAIT_GRAPH,
        states: [
          ...IMPLEMENT_THEN_WAIT_GRAPH.states,
          {
            completeWhen: {},
            id: "x</script><b>",
            terminal: "blocked",
            transitions: []
          }
        ]
      };
      await seedImplementThenWaitChain(test, {
        graph: hostileGraph,
        issueNumber: 10,
        rootId: "root-h",
        waitId: "wait-h"
      });
      await seedImplementThenWaitChain(test, {
        issueNumber: 10,
        rootId: "root-i",
        waitId: "wait-i"
      });
      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues/alpha/10")).text();

      expect(html).not.toContain("x</script><b>");
      expect(html.match(/cytoscape@3\.30\.4/g)).toHaveLength(1);
      // Parser-blocking CDN scripts must come after the recovery controls.
      expect(html.indexOf("cytoscape@3.30.4")).toBeGreaterThan(
        html.indexOf("<h2>Labels</h2>")
      );
      const data = drilldownData(html);
      expect(data).toHaveLength(2);
      const withHostile = data.find((d) =>
        JSON.stringify(d).includes("x</script><b>")
      );
      expect(withHostile).toBeDefined();
      expect(data[0]).toMatchObject({
        current: { kind: "current_waiting", stateId: "review_wait" }
      });
    } finally {
      test.cleanup();
    }
  });

  it("embeds current kind blocked for an escalated chain whose graph node is a success terminal", async () => {
    const test = await setup();
    try {
      await seedImplementThenWaitChain(test, {
        issueNumber: 11,
        rootId: "root-e",
        waitId: "wait-e"
      });
      test.runStore.recordWorkflowTerminal("wait-e", {
        terminalStateId: "done",
        transitionReason: "escalated"
      });
      test.runStore.updateRunState("wait-e", "blocked");
      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues/alpha/11")).text();

      expect(drilldownData(html)[0]).toMatchObject({
        current: { kind: "blocked", stateId: "done" }
      });
      expect(html).toContain("Blocked");
    } finally {
      test.cleanup();
    }
  });

  it("stacks the canvas over the outline on narrow screens", async () => {
    const test = await setup();
    try {
      await seedImplementThenWaitChain(test, {
        issueNumber: 12,
        rootId: "root-m",
        waitId: "wait-m"
      });
      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/issues/alpha/12")).text();

      expect(html).toMatch(
        /@media \(max-width: 720px\)[^}]*\.chain-graph-layout/
      );
      expect(html).toContain(".chain-graph-drilldown summary:focus-visible");
    } finally {
      test.cleanup();
    }
  });
});
