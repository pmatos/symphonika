import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeConfigReloader } from "../src/reload.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-reload-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function writeProjectConfig(
  root: string,
  workflowFileName: string
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      "  interval_ms: 1000",
      "providers:",
      "  codex:",
      '    command: "codex -p symphonika"',
      "  claude:",
      '    command: "claude -p"',
      "projects:",
      "  - name: symphonika",
      "    disabled: false",
      "    weight: 1",
      "    tracker:",
      "      kind: github",
      "      owner: pmatos",
      "      repo: symphonika",
      '      token: "$GITHUB_TOKEN"',
      "    issue_filters:",
      '      states: ["open"]',
      '      labels_all: ["agent-ready"]',
      '      labels_none: ["blocked"]',
      "    priority:",
      "      labels: {}",
      "      default: 99",
      "    workspace:",
      "      root: ./.symphonika/workspaces/symphonika",
      "      git:",
      "        remote: git@github.com:pmatos/symphonika.git",
      "        base_branch: main",
      "    agent:",
      "      provider: codex",
      `    workflow: ./${workflowFileName}`,
      ""
    ].join("\n")
  );
}

describe("RuntimeConfigReloader workflow validation", () => {
  it("rejects raw FSM workflows whose transitions point at undeclared states", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "workflow.yml");
    await writeFile(
      path.join(root, "workflow.yml"),
      [
        "workflow:",
        "  name: invalid_transitions",
        "  initial: planning",
        "  states:",
        "    planning:",
        "      action:",
        "        kind: agent",
        "        provider: codex",
        "        prompt: prompts/plan.md",
        "      complete_when:",
        "        artifact_exists: PLAN.md",
        "      transitions:",
        "        - to: missing_state",
        ""
      ].join("\n"),
      "utf8"
    );

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const status = reloader.getStatus();

    expect(status.ok).toBe(false);
    expect(status.errors.some((message) => message.includes("missing_state"))).toBe(
      true
    );
    expect(reloader.projectsByName().has("symphonika")).toBe(false);
  });

  it("accepts a valid raw FSM workflow at reload time", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "workflow.yml");
    await writeFile(
      path.join(root, "workflow.yml"),
      [
        "workflow:",
        "  name: valid_chain",
        "  initial: planning",
        "  states:",
        "    planning:",
        "      action:",
        "        kind: agent",
        "        provider: codex",
        "        prompt: prompts/plan.md",
        "      complete_when:",
        "        artifact_exists: PLAN.md",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n"),
      "utf8"
    );

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const status = reloader.getStatus();

    expect(status.errors).toEqual([]);
    expect(status.ok).toBe(true);
    expect(reloader.projectsByName().has("symphonika")).toBe(true);
  });

  it("exposes the expanded compatibility graph for a Markdown WORKFLOW.md", async () => {
    const root = await makeTempRoot();
    await writeProjectConfig(root, "WORKFLOW.md");
    const workflowBody = "Work on {{issue.title}}.\n";
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(workflowPath, workflowBody, "utf8");

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();

    const project = reloader.projectsByName().get("symphonika");
    expect(project).toBeDefined();
    const workflow = project?.workflow;
    expect(typeof workflow).toBe("object");
    if (typeof workflow === "string" || workflow === undefined) {
      throw new Error("expected workflow snapshot to be an object");
    }

    const onDisk = await readFile(workflowPath, "utf8");
    const expectedHash = `sha256:${createHash("sha256").update(onDisk).digest("hex")}`;

    expect(workflow.expandedWorkflow).toMatchObject({
      initial: "run_agent",
      name: "single_agent_workflow",
      source: { kind: "markdown", path: workflowPath }
    });
    expect(workflow.expandedWorkflow.contentHash).toBe(expectedHash);
    expect(workflow.expandedWorkflow.states.map((state) => state.id)).toEqual([
      "run_agent",
      "done"
    ]);
  });
});
