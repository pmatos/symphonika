import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  decideNextStep,
  findWorkflowState
} from "../src/lifecycle/state-machine-dispatch.js";
import {
  expandWorkflowDefinition,
  loadExpandedWorkflow
} from "../src/workflow/fsm-expansion.js";
import type { ExpandedWorkflow } from "../src/workflow/types.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function workflowBlocks(file: string): Promise<string[]> {
  const contents = await readFile(path.join(repoRoot, file), "utf8");
  return [...contents.matchAll(/```yaml\n([\s\S]*?)```/g)]
    .map((match) => match[1] ?? "")
    .filter((block) => block.startsWith("workflow:"));
}

function decide(
  workflow: ExpandedWorkflow,
  id: string,
  signals: Record<string, boolean | number | string>,
  artifactExists: (candidate: string) => boolean = () => false
) {
  const state = findWorkflowState(workflow, id);
  if (state === undefined) {
    throw new Error(`expected state ${id}`);
  }
  return decideNextStep({
    actionExecuted: true,
    artifactExists,
    signals,
    state
  });
}

describe("shipped workflow examples", () => {
  it.each([
    "skills/symphonika/EXAMPLES.md",
    "docs/tutorial.md",
    "docs/workflows.md"
  ])(
    "only ships workflow blocks in %s that validate cleanly as raw FSM",
    async (file) => {
      const blocks = await workflowBlocks(file);

      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        const result = expandWorkflowDefinition(block, file, "raw_fsm");
        expect(result.errors, block).toEqual([]);
      }
    }
  );

  it("gates the plan-then-implement recipe's planning state on the plan file", async () => {
    const blocks = await workflowBlocks("skills/symphonika/EXAMPLES.md");
    const block = blocks.find((candidate) =>
      candidate.includes("name: plan_then_implement")
    );
    if (block === undefined) {
      throw new Error("expected the plan_then_implement example");
    }
    const { workflow } = expandWorkflowDefinition(
      block,
      "workflow.yml",
      "raw_fsm"
    );
    const signals = { branch_ahead_of_base: true, provider_success: true };

    expect(
      decide(
        workflow,
        "planning",
        signals,
        (candidate) => candidate === "PLAN.md"
      )
    ).toMatchObject({ kind: "advance", to: "implementing" });
    expect(decide(workflow, "planning", signals)).toMatchObject({
      kind: "advance",
      to: "failed"
    });
  });
});

describe("refactor-workflow.yml", () => {
  it("matches the skill's characterization-gated refactor example", async () => {
    const example = (
      await workflowBlocks("skills/symphonika/EXAMPLES.md")
    ).find((block) => block.includes("name: characterization_gated_refactor"));
    if (example === undefined) {
      throw new Error("expected the characterization_gated_refactor example");
    }
    const shipped = await loadExpandedWorkflow(
      path.join(repoRoot, "refactor-workflow.yml"),
      "raw_fsm"
    );

    expect(
      expandWorkflowDefinition(example, "workflow.yml", "raw_fsm").workflow
        .states
    ).toEqual(shipped.workflow.states);
  });

  it("routes failed and rejected passes to blocked and lets verification succeed read-only", async () => {
    const { errors, workflow } = await loadExpandedWorkflow(
      path.join(repoRoot, "refactor-workflow.yml"),
      "raw_fsm"
    );
    expect(errors).toEqual([]);

    const failure = {
      branch_advanced_since_attempt_start: false,
      branch_ahead_of_base: false,
      provider_success: false
    };
    const noChange = { ...failure, provider_success: true };
    const success = {
      branch_advanced_since_attempt_start: true,
      branch_ahead_of_base: true,
      provider_success: true
    };
    const blockedArtifact = (candidate: string) => candidate === "BLOCKED.md";

    for (const id of ["red_team", "refactoring", "verifying"]) {
      expect(decide(workflow, id, failure)).toMatchObject({ to: "blocked" });
      expect(decide(workflow, id, success, blockedArtifact)).toMatchObject({
        to: "blocked"
      });
    }
    expect(decide(workflow, "red_team", noChange)).toMatchObject({
      to: "blocked"
    });
    expect(decide(workflow, "refactoring", noChange)).toMatchObject({
      to: "blocked"
    });
    expect(decide(workflow, "red_team", success)).toMatchObject({
      to: "refactoring"
    });
    expect(decide(workflow, "verifying", noChange)).toMatchObject({
      to: "done"
    });
  });
});
