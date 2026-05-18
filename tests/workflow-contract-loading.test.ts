import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadExpandedWorkflow,
  loadWorkflowContract as loadWorkflowContractFromFacade,
  parseWorkflowContract as parseWorkflowContractFromFacade,
  validateWorkflowContract as validateWorkflowContractFromFacade,
  validateWorkflowTemplate as validateWorkflowTemplateFromFacade
} from "../src/workflow.js";
import {
  loadWorkflowContract,
  parseWorkflowContract,
  validateWorkflowContract,
  validateWorkflowTemplate
} from "../src/workflow/contract-loading.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-workflow-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true })
    )
  );
});

describe("workflow contract loading", () => {
  it("keeps contract-loading exports available through the workflow facade", () => {
    expect(loadWorkflowContractFromFacade).toBe(loadWorkflowContract);
    expect(parseWorkflowContractFromFacade).toBe(parseWorkflowContract);
    expect(validateWorkflowContractFromFacade).toBe(validateWorkflowContract);
    expect(validateWorkflowTemplateFromFacade).toBe(validateWorkflowTemplate);
  });

  it("loads WORKFLOW.md body without prompt-adjacent front matter", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      [
        "---",
        "autonomy:",
        "  max_turns: 8",
        "---",
        "Work on {{issue.title}}.",
        ""
      ].join("\n")
    );

    const workflow = await loadWorkflowContract(workflowPath);

    expect(workflow).toMatchObject({
      body: "Work on {{issue.title}}.\n",
      errors: [],
      path: workflowPath
    });
    expect(workflow.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe("workflow format routing", () => {
  it("auto-routes a .md file to the Markdown loader regardless of body content", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: looks_like_yaml",
        "  initial: planning",
        "  states:",
        "    planning:",
        "      action:",
        "        kind: agent",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath, "auto");

    expect(result.errors).toEqual([]);
    expect(result.workflow.source.kind).toBe("markdown");
    expect(result.workflow.states.map((state) => state.id)).toEqual([
      "run_agent",
      "done"
    ]);
  });

  it("auto-routes .yaml, .yml, and .json paths to the raw FSM loader", async () => {
    const root = await makeTempRoot();
    for (const extension of [".yaml", ".yml", ".json"]) {
      const workflowPath = path.join(root, `workflow${extension}`);
      const contents =
        extension === ".json"
          ? JSON.stringify({
              workflow: {
                initial: "done",
                name: "json_workflow",
                states: { done: { terminal: "success" } }
              }
            })
          : [
              "workflow:",
              "  name: yaml_workflow",
              "  initial: done",
              "  states:",
              "    done:",
              "      terminal: success",
              ""
            ].join("\n");
      await writeFile(workflowPath, contents);

      const result = await loadExpandedWorkflow(workflowPath, "auto");
      expect(result.errors).toEqual([]);
      expect(result.workflow.source.kind).toBe("raw_fsm");
      expect(result.workflow.states.map((state) => state.id)).toEqual(["done"]);
    }
  });

  it("auto rejects an unknown extension and reports the supported set", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.txt");
    await writeFile(workflowPath, "doesn't matter\n");

    const result = await loadExpandedWorkflow(workflowPath, "auto");

    expect(result.errors).toContain(
      `workflow at ${workflowPath} has no recognized extension (.md, .yaml, .yml, .json); declare format explicitly`
    );
  });

  it("explicit markdown format treats a YAML-shaped .yml file as Markdown content", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "---",
        "name: explicit_markdown",
        "---",
        "",
        "Work on {{issue.title}}.",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath, "markdown");

    expect(result.errors).toEqual([]);
    expect(result.workflow.source.kind).toBe("markdown");
    expect(result.workflow.states.map((state) => state.id)).toEqual([
      "run_agent",
      "done"
    ]);
  });

  it("explicit raw_fsm format errors when a .md file is not valid raw FSM YAML", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(workflowPath, "# Just a markdown file\n");

    const result = await loadExpandedWorkflow(workflowPath, "raw_fsm");

    expect(result.errors).toContain(
      `workflow definition at ${workflowPath} must define a top-level workflow mapping`
    );
  });

  it("explicit raw_fsm format surfaces YAML parse errors regardless of extension", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.json");
    await writeFile(workflowPath, "{ bogus yaml here: : :");

    const result = await loadExpandedWorkflow(workflowPath, "raw_fsm");

    expect(
      result.errors.some((message) =>
        message.startsWith(
          `workflow definition at ${workflowPath} could not be parsed:`
        )
      )
    ).toBe(true);
  });
});
