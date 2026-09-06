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

    // Anchor on the numbered step markers, not the shared duplicate/already-fixed
    // phrase alone -- that phrase recurs in the Constraints section.
    const stepThreeIndex = workflow.indexOf(
      "\n3. If that investigation shows the issue is a duplicate"
    );
    const stepFourIndex = workflow.indexOf("\n4. Implement the change");
    const closeCommandIndex = workflow.indexOf(
      "gh issue close {{issue.number}}"
    );
    expect(stepThreeIndex).toBeGreaterThan(-1);
    expect(closeCommandIndex).toBeGreaterThan(stepThreeIndex);
    expect(closeCommandIndex).toBeLessThan(stepFourIndex);
  });
});
