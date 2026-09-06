import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const workflowPath = path.join(repoRoot, "WORKFLOW.md");

describe("WORKFLOW.md", () => {
  it("instructs the agent to close duplicate/already-fixed issues itself instead of proceeding to implementation", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("gh issue comment {{issue.number}}");
    expect(workflow).toContain("gh issue close {{issue.number}}");
    expect(workflow).toContain(
      "Do not commit, push, or open a PR for this path"
    );

    const stopStepIndex = workflow.indexOf(
      "duplicate of already-merged work, or is already fixed"
    );
    const closeCommandIndex = workflow.indexOf(
      "gh issue close {{issue.number}}"
    );
    expect(stopStepIndex).toBeGreaterThan(-1);
    expect(closeCommandIndex).toBeGreaterThan(stopStepIndex);
  });
});
