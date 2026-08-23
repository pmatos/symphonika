import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface WorkflowStep {
  "continue-on-error"?: boolean;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
}

interface Workflow {
  jobs: Record<string, { steps: WorkflowStep[] }>;
}

const repoRoot = path.resolve(import.meta.dirname, "..");
const workflowPath = path.join(
  repoRoot,
  ".github/workflows/claude-code-review.yml"
);

describe("Claude Code Review workflow", () => {
  it("reports advisory reviewer failures without failing the pull request check", async () => {
    const workflow = parse(await readFile(workflowPath, "utf8")) as Workflow;
    const steps = workflow.jobs["claude-review"]?.steps ?? [];
    const reviewStep = steps.find((step) => step.id === "claude-review");
    const failureSummaryStep = steps.find(
      (step) => step.name === "Report unavailable review"
    );

    expect(reviewStep).toMatchObject({
      "continue-on-error": true,
      uses: "anthropics/claude-code-action@v1"
    });
    expect(failureSummaryStep).toMatchObject({
      if: "${{ steps.claude-review.outcome == 'failure' }}"
    });
    expect(failureSummaryStep?.run).toContain("$GITHUB_STEP_SUMMARY");
  });
});
