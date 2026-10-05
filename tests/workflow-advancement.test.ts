import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { IssueSnapshot } from "../src/issue-polling.js";
import { openRunStore, type RunStore } from "../src/run-store.js";
import { applyWorkflowDecision } from "../src/lifecycle/workflow-advancement.js";
import type { ExpandedWorkflow } from "../src/workflow/types.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-workflow-advancement-")
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

function sampleIssue(): IssueSnapshot {
  return {
    body: "issue body",
    created_at: "2026-04-01T00:00:00Z",
    id: 1001,
    labels: ["agent-ready"],
    number: 42,
    priority: 99,
    state: "open",
    title: "Sample issue",
    updated_at: "2026-04-02T00:00:00Z",
    url: "https://example.invalid/issue/42"
  };
}

function workflowWithTarget(
  target: ExpandedWorkflow["states"][number]
): ExpandedWorkflow {
  return {
    contentHash: "workflow-hash",
    initial: "source",
    name: "workflow",
    source: { kind: "raw_fsm", path: "WORKFLOW.md" },
    states: [
      {
        completeWhen: {},
        id: "source",
        transitions: [{ to: target.id, when: {} }]
      },
      target
    ]
  };
}

async function withRun(
  run: (input: {
    issue: IssueSnapshot;
    runId: string;
    store: RunStore;
  }) => void | Promise<void>
): Promise<void> {
  const issue = sampleIssue();
  const runId = "source-run";
  const store = openRunStore({ stateRoot: await makeTempRoot() });
  try {
    store.createRun({
      id: runId,
      issue,
      projectName: "symphonika",
      providerCommand: "fake-codex",
      providerName: "codex"
    });
    store.setRunCurrentState(runId, "source");
    await run({ issue, runId, store });
  } finally {
    store.close();
  }
}

describe("applyWorkflowDecision", () => {
  it("makes a parked target durable before returning it", async () => {
    await withRun(({ issue, runId, store }) => {
      const workflow = workflowWithTarget({
        action: { kind: "wait" },
        completeWhen: {},
        id: "holding",
        transitions: []
      });

      const result = applyWorkflowDecision(
        { createRunId: () => "waiting-run", runStore: store },
        {
          currentState: workflow.states[0]!,
          decision: {
            kind: "advance",
            reason: "source advanced to holding",
            to: "holding",
            when: {}
          },
          mode: { deferNonTerminalAdvance: false, kind: "provider" },
          run: {
            branchName: "sym/42-sample",
            id: runId,
            issue,
            projectName: "symphonika",
            workspacePath: "/tmp/workspace"
          },
          workflow
        }
      );

      expect(result).toEqual({
        kind: "parked",
        stateId: "holding",
        waitingRunId: "waiting-run"
      });
      expect(store.getRun(runId)?.currentStateId).toBe("holding");
      expect(store.getRun("waiting-run")).toMatchObject({
        branchName: "sym/42-sample",
        continuationParentRunId: runId,
        currentStateId: "holding",
        state: "waiting",
        workspacePath: "/tmp/workspace"
      });
    });
  });

  it("defers a retryable non-terminal provider advance without writing position", async () => {
    await withRun(({ issue, runId, store }) => {
      const workflow = workflowWithTarget({
        action: { kind: "agent" },
        completeWhen: {},
        id: "implement",
        transitions: []
      });

      const result = applyWorkflowDecision(
        { createRunId: () => "unused", runStore: store },
        {
          currentState: workflow.states[0]!,
          decision: {
            kind: "advance",
            reason: "source advanced to implement",
            to: "implement",
            when: {}
          },
          mode: { deferNonTerminalAdvance: true, kind: "provider" },
          run: { id: runId, issue, projectName: "symphonika" },
          workflow
        }
      );

      expect(result).toEqual({ kind: "deferred" });
      expect(store.getRun(runId)?.currentStateId).toBe("source");
    });
  });

  it("applies a terminal target before provider deferral", async () => {
    await withRun(({ issue, runId, store }) => {
      const workflow = workflowWithTarget({
        completeWhen: {},
        id: "done",
        terminal: "success",
        transitions: []
      });

      const result = applyWorkflowDecision(
        { createRunId: () => "unused", runStore: store },
        {
          currentState: workflow.states[0]!,
          decision: {
            kind: "advance",
            reason: "source advanced to done",
            to: "done",
            when: {}
          },
          mode: { deferNonTerminalAdvance: true, kind: "provider" },
          run: { id: runId, issue, projectName: "symphonika" },
          workflow
        }
      );

      expect(result).toEqual({
        kind: "terminal",
        terminal: "success",
        terminalStateId: "done"
      });
      expect(store.getRun(runId)).toMatchObject({
        currentStateId: null,
        terminalStateId: "done"
      });
    });
  });

  it("parks a repeated Waiting Run edge before writing position", async () => {
    await withRun(({ issue, runId, store }) => {
      const workflow = workflowWithTarget({
        action: { kind: "agent" },
        completeWhen: {},
        id: "repair",
        transitions: []
      });
      const edge = {
        fromStateId: "source",
        issueNumber: issue.number,
        projectName: "symphonika",
        toStateId: "repair"
      };
      expect(store.claimProgressEdge(edge, "same-observation", 3)).toBe(
        "claimed"
      );

      const result = applyWorkflowDecision(
        { createRunId: () => "unused", runStore: store },
        {
          currentState: workflow.states[0]!,
          decision: {
            kind: "advance",
            reason: "source advanced to repair",
            to: "repair",
            when: { review_decision: "changes_requested" }
          },
          mode: {
            kind: "waiting",
            progressGuard: {
              fingerprint: "same-observation",
              kind: "enabled",
              maxClaims: 3
            }
          },
          run: { id: runId, issue, projectName: "symphonika" },
          workflow
        }
      );

      expect(result).toMatchObject({
        claim: "unchanged",
        kind: "progress_guarded"
      });
      expect(store.getRun(runId)).toMatchObject({
        currentStateId: "source",
        stateTransitionReason: "no_progress:source:repair"
      });
    });
  });
});
