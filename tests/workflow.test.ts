import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  explainWorkflow,
  loadExpandedWorkflow,
  loadWorkflowContract,
  persistRunEvidence,
  renderAutonomousPrompt
} from "../src/workflow.js";

const tempRoots: string[] = [];
const DEFAULT_CODEX_COMMAND = `codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server`;

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

describe("workflow prompt rendering", () => {
  it("renders normalized run variables and prepends the autonomy preamble", () => {
    const rendered = renderAutonomousPrompt({
      branch: {
        name: "sym/symphonika/7-render-prompts",
        ref: "refs/heads/sym/symphonika/7-render-prompts"
      },
      issue: issueSnapshot(),
      project: {
        name: "symphonika"
      },
      provider: {
        command: DEFAULT_CODEX_COMMAND,
        name: "codex"
      },
      run: {
        attempt: 1,
        continuation: false,
        id: "run-7"
      },
      template: [
        "Work on #{{issue.number}} {{issue.title}} for {{project.name}} using {{provider.name}}.",
        "Run {{run.id}} attempt {{run.attempt}} continuation {{run.continuation}}.",
        "Workspace {{workspace.path}} rooted at {{workspace.root}} previous {{workspace.previous_attempt}}.",
        "Branch {{branch.name}} at {{branch.ref}}.",
        "Provider command {{provider.command}} with labels {{issue.labels}}."
      ].join("\n"),
      workflowPath: "/repo/WORKFLOW.md",
      workspace: {
        path: "/state/workspaces/symphonika/issues/7-render-prompts",
        previous_attempt: false,
        root: "/state/workspaces/symphonika"
      }
    });

    expect(rendered.prompt).toContain("Autonomous run instructions");
    expect(rendered.prompt).toContain(
      "Work on #7 Render autonomous prompts and persist run evidence for symphonika using codex."
    );
    expect(rendered.prompt).toContain("Run run-7 attempt 1 continuation false.");
    expect(rendered.prompt).toContain(
      "Workspace /state/workspaces/symphonika/issues/7-render-prompts rooted at /state/workspaces/symphonika previous false."
    );
    expect(rendered.prompt).toContain(
      "Branch sym/symphonika/7-render-prompts at refs/heads/sym/symphonika/7-render-prompts."
    );
    expect(rendered.prompt).toContain(
      `Provider command ${DEFAULT_CODEX_COMMAND} with labels ["agent-ready"].`
    );
    expect(rendered.prompt).toContain("gh CLI");
    expect(rendered.preambleVersion).toBe("autonomy-preamble-v2");
  });

  it("fails rendering when the workflow references an unknown variable", () => {
    expect(() =>
      renderAutonomousPrompt({
        branch: {
          name: "sym/symphonika/7-render-prompts",
          ref: "refs/heads/sym/symphonika/7-render-prompts"
        },
        issue: issueSnapshot(),
        project: {
          name: "symphonika"
        },
        provider: {
          command: DEFAULT_CODEX_COMMAND,
          name: "codex"
        },
        run: {
          attempt: 1,
          continuation: false,
          id: "run-7"
        },
        template: "Work on {{issue.assignee}}.",
        workflowPath: "/repo/WORKFLOW.md",
        workspace: {
          path: "/state/workspaces/symphonika/issues/7-render-prompts",
          previous_attempt: false,
          root: "/state/workspaces/symphonika"
        }
      })
    ).toThrow("references unknown variable {{issue.assignee}}");
  });

  it("rejects inherited object property names as template variables", () => {
    expect(() =>
      renderAutonomousPrompt({
        branch: {
          name: "sym/symphonika/7-render-prompts",
          ref: "refs/heads/sym/symphonika/7-render-prompts"
        },
        issue: issueSnapshot(),
        project: {
          name: "symphonika"
        },
        provider: {
          command: DEFAULT_CODEX_COMMAND,
          name: "codex"
        },
        run: {
          attempt: 1,
          continuation: false,
          id: "run-7"
        },
        template: "Work on {{toString}} and {{constructor}}.",
        workflowPath: "/repo/WORKFLOW.md",
        workspace: {
          path: "/state/workspaces/symphonika/issues/7-render-prompts",
          previous_attempt: false,
          root: "/state/workspaces/symphonika"
        }
      })
    ).toThrow("references unknown variable {{toString}}");
  });

  it("calls out previous-attempt workspaces in the rendered prompt", () => {
    const rendered = renderAutonomousPrompt({
      branch: {
        name: "sym/symphonika/7-render-prompts",
        ref: "refs/heads/sym/symphonika/7-render-prompts"
      },
      issue: issueSnapshot(),
      project: {
        name: "symphonika"
      },
      provider: {
        command: "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json",
        name: "claude"
      },
      run: {
        attempt: 2,
        continuation: true,
        id: "run-7b"
      },
      template: "Continue work on {{issue.title}}.",
      workflowPath: "/repo/WORKFLOW.md",
      workspace: {
        path: "/state/workspaces/symphonika/issues/7-render-prompts",
        previous_attempt: true,
        root: "/state/workspaces/symphonika"
      }
    });

    expect(rendered.prompt).toContain("Previous-attempt workspace");
    expect(rendered.prompt).toContain("inspect the existing work before editing");
  });

  it("persists rendered prompt evidence outside the issue workspace", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      "issues",
      "7-render-prompts"
    );
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(workflowPath, "Work on {{issue.title}}.\n");
    const input = {
      branch: {
        name: "sym/symphonika/7-render-prompts",
        ref: "refs/heads/sym/symphonika/7-render-prompts"
      },
      issue: issueSnapshot(),
      project: {
        name: "symphonika"
      },
      provider: {
        command: DEFAULT_CODEX_COMMAND,
        name: "codex" as const
      },
      run: {
        attempt: 1,
        continuation: false,
        id: "run-7"
      },
      template: "Work on {{issue.title}}.",
      workflowPath,
      workspace: {
        path: workspacePath,
        previous_attempt: false,
        root: path.dirname(path.dirname(workspacePath))
      }
    };
    const rendered = renderAutonomousPrompt(input);
    const expanded = await loadExpandedWorkflow(input.workflowPath);

    const evidence = await persistRunEvidence({
      ...input,
      attemptNumber: input.run.attempt,
      expandedWorkflow: expanded.workflow,
      renderedPrompt: rendered,
      stateRoot
    });

    expect(evidence.runEvidenceDirectory).toBe(
      path.join(stateRoot, "logs", "runs", "run-7")
    );
    expect(path.relative(workspacePath, evidence.promptPath)).toMatch(/^\.\./);
    await expect(readFile(evidence.promptPath, "utf8")).resolves.toBe(
      rendered.prompt
    );
    const metadata = parseJsonRecord(await readFile(evidence.metadataPath, "utf8"));
    expect(metadata).toMatchObject({
      autonomy_preamble_version: "autonomy-preamble-v2",
      branch: input.branch,
      provider: input.provider,
      project: input.project,
      run: input.run,
      workspace: input.workspace,
      workflow: {
        path: input.workflowPath
      }
    });
    const workflowMetadata = metadata.workflow;
    if (!isRecord(workflowMetadata)) {
      throw new Error("expected workflow metadata record");
    }
    expect(workflowMetadata.content_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    await expect(readFile(evidence.issueSnapshotPath, "utf8")).resolves.toContain(
      "Render autonomous prompts and persist run evidence"
    );
  });

  it("persists the expanded workflow graph for a Markdown workflow with no attempt suffix on attempt 1", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      "issues",
      "7-render-prompts"
    );
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(workflowPath, "Work on {{issue.title}}.\n");
    const expanded = await loadExpandedWorkflow(workflowPath);
    expect(expanded.errors).toEqual([]);

    const input = {
      branch: {
        name: "sym/symphonika/7-render-prompts",
        ref: "refs/heads/sym/symphonika/7-render-prompts"
      },
      issue: issueSnapshot(),
      project: { name: "symphonika" },
      provider: {
        command: DEFAULT_CODEX_COMMAND,
        name: "codex" as const
      },
      run: {
        attempt: 1,
        continuation: false,
        id: "run-7"
      },
      template: "Work on {{issue.title}}.",
      workflowContentHash: expanded.workflow.contentHash,
      workflowPath,
      workspace: {
        path: workspacePath,
        previous_attempt: false,
        root: path.dirname(path.dirname(workspacePath))
      }
    };
    const rendered = renderAutonomousPrompt(input);

    const evidence = await persistRunEvidence({
      ...input,
      attemptNumber: 1,
      expandedWorkflow: expanded.workflow,
      renderedPrompt: rendered,
      stateRoot
    });

    expect(evidence.workflowGraphPath).toBe(
      path.join(evidence.runEvidenceDirectory, "workflow-graph.json")
    );
    const graph = parseJsonRecord(
      await readFile(evidence.workflowGraphPath, "utf8")
    );
    expect(graph).toMatchObject({
      initial: "run_agent",
      name: "single_agent_workflow",
      source: {
        kind: "markdown",
        path: workflowPath
      },
      templateFiles: []
    });
    expect(graph.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Array.isArray(graph.states)).toBe(true);
    expect((graph.states as unknown[]).length).toBe(2);

    await expect(readFile(evidence.promptPath, "utf8")).resolves.toBe(
      rendered.prompt
    );
    const metadata = parseJsonRecord(await readFile(evidence.metadataPath, "utf8"));
    expect(metadata).toMatchObject({
      workflow: {
        path: workflowPath
      }
    });
  });

  it("loads WORKFLOW.md body without front matter and carries its content hash into the rendered prompt", async () => {
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
    const rendered = renderAutonomousPrompt({
      branch: {
        name: "sym/symphonika/7-render-prompts",
        ref: "refs/heads/sym/symphonika/7-render-prompts"
      },
      issue: issueSnapshot(),
      project: {
        name: "symphonika"
      },
      provider: {
        command: DEFAULT_CODEX_COMMAND,
        name: "codex"
      },
      run: {
        attempt: 1,
        continuation: false,
        id: "run-7"
      },
      template: workflow.body,
      workflowContentHash: workflow.contentHash,
      workflowPath: workflow.path,
      workspace: {
        path: "/state/workspaces/symphonika/issues/7-render-prompts",
        previous_attempt: false,
        root: "/state/workspaces/symphonika"
      }
    });

    expect(workflow.errors).toEqual([]);
    expect(workflow.body).toBe("Work on {{issue.title}}.\n");
    expect(workflow.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(rendered.prompt).toContain(
      "Work on Render autonomous prompts and persist run evidence."
    );
    expect(rendered.prompt).not.toContain("max_turns");
    expect(rendered.workflowContentHash).toBe(workflow.contentHash);
  });
});

describe("state machine workflow definitions", () => {
  it("compiles Markdown workflow contracts to the single-agent compatibility graph", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(workflowPath, "Work on {{issue.title}}.\n");

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toEqual([]);
    expect(result.workflow).toMatchObject({
      initial: "run_agent",
      name: "single_agent_workflow",
      source: {
        kind: "markdown",
        path: workflowPath
      },
      states: [
        {
          action: {
            kind: "agent"
          },
          completeWhen: {
            branch_ahead_of_base: true,
            provider_success: true
          },
          id: "run_agent",
          transitions: [
            {
              to: "done"
            }
          ]
        },
        {
          id: "done",
          terminal: "success"
        }
      ]
    });
  });

  it("expands repo-local workflow templates into a prefixed raw FSM graph", async () => {
    const root = await makeTempRoot();
    const templateDir = path.join(root, ".symphonika", "workflow-templates");
    await mkdir(templateDir, { recursive: true });
    const workflowPath = path.join(root, "workflow.yml");
    const templatePath = path.join(templateDir, "plan-tdd-pr.yml");
    await writeFile(
      templatePath,
      [
        "name: plan_tdd_pr",
        "inputs:",
        "  planner:",
        "    type: provider",
        "    default: codex",
        "  plan_prompt:",
        "    type: path",
        "    default: prompts/plan.md",
        "entry: planning",
        "exits:",
        "  success: pr_open",
        "  blocked: blocked",
        "states:",
        "  planning:",
        "    action:",
        "      kind: agent",
        "      provider: \"{{ planner }}\"",
        "      prompt: \"{{ plan_prompt }}\"",
        "    complete_when:",
        "      artifact_exists: PLAN.md",
        "    transitions:",
        "      - to: pr_open",
        "  pr_open:",
        "    exit: success",
        "  blocked:",
        "    exit: blocked",
        ""
      ].join("\n")
    );
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: build_pr",
        "  use:",
        "    build_pr:",
        "      template: .symphonika/workflow-templates/plan-tdd-pr.yml",
        "      with:",
        "        planner: claude",
        "        plan_prompt: prompts/custom-plan.md",
        "      exits:",
        "        success: done",
        "        blocked: needs_operator",
        "  states:",
        "    done:",
        "      terminal: success",
        "    needs_operator:",
        "      terminal: blocked",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);
    const explanation = explainWorkflow(result.workflow);

    expect(result.errors).toEqual([]);
    expect(result.workflow.initial).toBe("build_pr.planning");
    expect(result.workflow.templateFiles).toEqual([templatePath]);
    expect(result.workflow.states.map((state) => state.id)).toEqual([
      "done",
      "needs_operator",
      "build_pr.planning"
    ]);
    expect(result.workflow.states).toContainEqual({
      action: {
        kind: "agent",
        prompt: "prompts/custom-plan.md",
        provider: "claude"
      },
      completeWhen: {
        artifact_exists: "PLAN.md"
      },
      id: "build_pr.planning",
      transitions: [{ to: "done", when: {} }]
    });
    expect(explanation).toContain(`template files: ${templatePath}`);
    expect(explanation).toContain("state: build_pr.planning");
    expect(explanation).not.toContain("state: pr_open");
  });

  it("rejects template exits that are not mapped by the workflow instance", async () => {
    const root = await makeTempRoot();
    const templateDir = path.join(root, ".symphonika", "workflow-templates");
    await mkdir(templateDir, { recursive: true });
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      path.join(templateDir, "plan-tdd-pr.yml"),
      [
        "name: plan_tdd_pr",
        "entry: planning",
        "exits:",
        "  success: pr_open",
        "  blocked: blocked",
        "states:",
        "  planning:",
        "    action:",
        "      kind: agent",
        "      provider: codex",
        "      prompt: prompts/plan.md",
        "    transitions:",
        "      - to: blocked",
        "  pr_open:",
        "    exit: success",
        "  blocked:",
        "    exit: blocked",
        ""
      ].join("\n")
    );
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: build_pr",
        "  use:",
        "    build_pr:",
        "      template: .symphonika/workflow-templates/plan-tdd-pr.yml",
        "      exits:",
        "        success: done",
        "  states:",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toEqual([
      `workflow template instance build_pr at ${workflowPath} must map exit blocked`
    ]);
  });

  it("rejects template-expanded state IDs that collide with workflow states", async () => {
    const root = await makeTempRoot();
    const templateDir = path.join(root, ".symphonika", "workflow-templates");
    await mkdir(templateDir, { recursive: true });
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      path.join(templateDir, "plan-tdd-pr.yml"),
      [
        "name: plan_tdd_pr",
        "entry: planning",
        "states:",
        "  planning:",
        "    action:",
        "      kind: agent",
        "      provider: codex",
        "      prompt: prompts/plan.md",
        "    transitions:",
        "      - to: done",
        "  done:",
        "    terminal: success",
        ""
      ].join("\n")
    );
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: build_pr",
        "  use:",
        "    build_pr:",
        "      template: .symphonika/workflow-templates/plan-tdd-pr.yml",
        "  states:",
        "    build_pr.planning:",
        "      terminal: blocked",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toEqual([
      `workflow template instance build_pr at ${workflowPath} expands state build_pr.planning that conflicts with an existing workflow state`
    ]);
    expect(result.workflow.states.map((state) => state.id)).toEqual([
      "build_pr.planning",
      "build_pr.done"
    ]);
  });

  it("resolves raw workflow transitions that target template instances", async () => {
    const root = await makeTempRoot();
    const templateDir = path.join(root, ".symphonika", "workflow-templates");
    await mkdir(templateDir, { recursive: true });
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      path.join(templateDir, "plan-tdd-pr.yml"),
      [
        "name: plan_tdd_pr",
        "entry: planning",
        "states:",
        "  planning:",
        "    action:",
        "      kind: agent",
        "      provider: codex",
        "      prompt: prompts/plan.md",
        "    transitions:",
        "      - to: done",
        "  done:",
        "    terminal: success",
        ""
      ].join("\n")
    );
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: triage",
        "  use:",
        "    build_pr:",
        "      template: .symphonika/workflow-templates/plan-tdd-pr.yml",
        "  states:",
        "    triage:",
        "      action:",
        "        kind: wait",
        "      transitions:",
        "        - to: build_pr",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toEqual([]);
    expect(result.workflow.states[0]).toMatchObject({
      id: "triage",
      transitions: [{ to: "build_pr.planning", when: {} }]
    });
  });

  it("rejects workflow instance mappings for undeclared template exits", async () => {
    const root = await makeTempRoot();
    const templateDir = path.join(root, ".symphonika", "workflow-templates");
    await mkdir(templateDir, { recursive: true });
    const workflowPath = path.join(root, "workflow.yml");
    const templatePath = path.join(templateDir, "plan-tdd-pr.yml");
    await writeFile(
      templatePath,
      [
        "name: plan_tdd_pr",
        "entry: planning",
        "exits:",
        "  success: pr_open",
        "states:",
        "  planning:",
        "    action:",
        "      kind: agent",
        "      provider: codex",
        "      prompt: prompts/plan.md",
        "    transitions:",
        "      - to: pr_open",
        "  pr_open:",
        "    exit: success",
        ""
      ].join("\n")
    );
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: build_pr",
        "  use:",
        "    build_pr:",
        "      template: .symphonika/workflow-templates/plan-tdd-pr.yml",
        "      exits:",
        "        success: done",
        "        exhausted: needs_operator",
        "  states:",
        "    done:",
        "      terminal: success",
        "    needs_operator:",
        "      terminal: blocked",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toEqual([
      `workflow template instance build_pr at ${workflowPath} maps undeclared exit exhausted from ${templatePath}`
    ]);
  });

  it("rejects undeclared and non-scalar template inputs", async () => {
    const root = await makeTempRoot();
    const templateDir = path.join(root, ".symphonika", "workflow-templates");
    await mkdir(templateDir, { recursive: true });
    const workflowPath = path.join(root, "workflow.yml");
    const templatePath = path.join(templateDir, "plan-tdd-pr.yml");
    await writeFile(
      templatePath,
      [
        "name: plan_tdd_pr",
        "inputs:",
        "  planner:",
        "    type: provider",
        "  branch_label:",
        "    type: label",
        "  retries:",
        "    type: number",
        "    default: 1",
        "entry: planning",
        "states:",
        "  planning:",
        "    action:",
        "      kind: agent",
        "      provider: codex",
        "      prompt: prompts/plan.md",
        ""
      ].join("\n")
    );
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: build_pr",
        "  use:",
        "    build_pr:",
        "      template: .symphonika/workflow-templates/plan-tdd-pr.yml",
        "      with:",
        "        planner: gemini",
        "        branch_label:",
        "          - agent-ready",
        "        extra: true",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toEqual([
      `workflow template instance build_pr at ${templatePath} supplies undeclared input extra`,
      `workflow template input planner at ${templatePath} must be a provider scalar`,
      `workflow template input branch_label at ${templatePath} must be a label scalar`
    ]);
  });

  it("rejects template interpolation that references undeclared inputs", async () => {
    const root = await makeTempRoot();
    const templateDir = path.join(root, ".symphonika", "workflow-templates");
    await mkdir(templateDir, { recursive: true });
    const workflowPath = path.join(root, "workflow.yml");
    const templatePath = path.join(templateDir, "plan-tdd-pr.yml");
    await writeFile(
      templatePath,
      [
        "name: plan_tdd_pr",
        "entry: planning",
        "states:",
        "  planning:",
        "    action:",
        "      kind: agent",
        "      provider: codex",
        "      prompt: \"{{ missing_prompt }}\"",
        ""
      ].join("\n")
    );
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: build_pr",
        "  use:",
        "    build_pr:",
        "      template: .symphonika/workflow-templates/plan-tdd-pr.yml",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toEqual([
      `workflow template at ${templatePath} references unknown input {{missing_prompt}}`
    ]);
  });

  it("rejects template-internal transitions that bypass declared exits", async () => {
    const root = await makeTempRoot();
    const templateDir = path.join(root, ".symphonika", "workflow-templates");
    await mkdir(templateDir, { recursive: true });
    const workflowPath = path.join(root, "workflow.yml");
    const templatePath = path.join(templateDir, "plan-tdd-pr.yml");
    await writeFile(
      templatePath,
      [
        "name: plan_tdd_pr",
        "entry: planning",
        "exits:",
        "  success: pr_open",
        "states:",
        "  planning:",
        "    action:",
        "      kind: agent",
        "      provider: codex",
        "      prompt: prompts/plan.md",
        "    transitions:",
        "      - to: done",
        "  pr_open:",
        "    exit: success",
        ""
      ].join("\n")
    );
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: build_pr",
        "  use:",
        "    build_pr:",
        "      template: .symphonika/workflow-templates/plan-tdd-pr.yml",
        "      exits:",
        "        success: done",
        "  states:",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toEqual([
      `workflow template state planning at ${templatePath} transitions to done outside declared exits`
    ]);
  });

  it("allows unmapped template exits that target a terminal state inside the template", async () => {
    const root = await makeTempRoot();
    const templateDir = path.join(root, ".symphonika", "workflow-templates");
    await mkdir(templateDir, { recursive: true });
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      path.join(templateDir, "plan-tdd-pr.yml"),
      [
        "name: plan_tdd_pr",
        "entry: planning",
        "exits:",
        "  success: done",
        "states:",
        "  planning:",
        "    action:",
        "      kind: agent",
        "      provider: codex",
        "      prompt: prompts/plan.md",
        "    transitions:",
        "      - to: done",
        "  done:",
        "    terminal: success",
        ""
      ].join("\n")
    );
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: build_pr",
        "  use:",
        "    build_pr:",
        "      template: .symphonika/workflow-templates/plan-tdd-pr.yml",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toEqual([]);
    expect(result.workflow.initial).toBe("build_pr.planning");
    expect(result.workflow.states.map((state) => state.id)).toEqual([
      "build_pr.planning",
      "build_pr.done"
    ]);
    expect(result.workflow.states[0]?.transitions).toEqual([
      { to: "build_pr.done", when: {} }
    ]);
    expect(result.workflow.states[1]).toMatchObject({
      id: "build_pr.done",
      terminal: "success"
    });
  });

  it("uses explicit workflow mappings for terminal template exits when provided", async () => {
    const root = await makeTempRoot();
    const templateDir = path.join(root, ".symphonika", "workflow-templates");
    await mkdir(templateDir, { recursive: true });
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      path.join(templateDir, "plan-tdd-pr.yml"),
      [
        "name: plan_tdd_pr",
        "entry: planning",
        "exits:",
        "  success: done",
        "states:",
        "  planning:",
        "    action:",
        "      kind: agent",
        "      provider: codex",
        "      prompt: prompts/plan.md",
        "    transitions:",
        "      - to: done",
        "  done:",
        "    terminal: success",
        ""
      ].join("\n")
    );
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: build_pr",
        "  use:",
        "    build_pr:",
        "      template: .symphonika/workflow-templates/plan-tdd-pr.yml",
        "      exits:",
        "        success: reviewed",
        "  states:",
        "    reviewed:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toEqual([]);
    expect(result.workflow.states.map((state) => state.id)).toEqual([
      "reviewed",
      "build_pr.planning"
    ]);
    expect(result.workflow.states[1]?.transitions).toEqual([
      { to: "reviewed", when: {} }
    ]);
  });

  it("rejects duplicate template exits that target the same terminal state", async () => {
    const root = await makeTempRoot();
    const templateDir = path.join(root, ".symphonika", "workflow-templates");
    await mkdir(templateDir, { recursive: true });
    const workflowPath = path.join(root, "workflow.yml");
    const templatePath = path.join(templateDir, "plan-tdd-pr.yml");
    await writeFile(
      templatePath,
      [
        "name: plan_tdd_pr",
        "entry: planning",
        "exits:",
        "  success: done",
        "  blocked: done",
        "states:",
        "  planning:",
        "    action:",
        "      kind: agent",
        "      provider: codex",
        "      prompt: prompts/plan.md",
        "    transitions:",
        "      - to: done",
        "  done:",
        "    terminal: success",
        ""
      ].join("\n")
    );
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: build_pr",
        "  use:",
        "    build_pr:",
        "      template: .symphonika/workflow-templates/plan-tdd-pr.yml",
        "      exits:",
        "        success: reviewed",
        "        blocked: needs_operator",
        "  states:",
        "    reviewed:",
        "      terminal: success",
        "    needs_operator:",
        "      terminal: blocked",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toEqual([
      `workflow template at ${templatePath} exits success and blocked both target state done`
    ]);
  });

  it("loads and explains an explicit raw FSM workflow", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
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
        "        - to: implementing",
        "    implementing:",
        "      action:",
        "        kind: agent",
        "        provider: codex",
        "        prompt: prompts/implement-tdd.md",
        "      complete_when:",
        "        branch_ahead_of_base: true",
        "        pr_open: true",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);
    const explanation = explainWorkflow(result.workflow);

    expect(result.errors).toEqual([]);
    expect(result.workflow).toMatchObject({
      initial: "planning",
      name: "issue_to_merge",
      source: {
        kind: "raw_fsm",
        path: workflowPath
      }
    });
    expect(explanation).toContain("workflow: issue_to_merge");
    expect(explanation).toContain(`source: ${workflowPath}`);
    expect(explanation).toContain("initial: planning");
    expect(explanation).toContain("state: planning");
    expect(explanation).toContain(
      "action: agent provider=codex prompt=prompts/plan.md"
    );
    expect(explanation).toContain("complete_when: artifact_exists=PLAN.md");
    expect(explanation).toContain("-> implementing");
    expect(explanation).toContain("state: done");
    expect(explanation).toContain("terminal: success");
  });

  it("persists the expanded raw FSM workflow graph with an attempt suffix on retries", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      "issues",
      "9-fsm-graph"
    );
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
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
        "        - to: implementing",
        "    implementing:",
        "      action:",
        "        kind: agent",
        "        provider: codex",
        "        prompt: prompts/implement-tdd.md",
        "      complete_when:",
        "        branch_ahead_of_base: true",
        "        pr_open: true",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );
    const expanded = await loadExpandedWorkflow(workflowPath);
    expect(expanded.errors).toEqual([]);

    const input = {
      branch: {
        name: "sym/symphonika/9-fsm-graph",
        ref: "refs/heads/sym/symphonika/9-fsm-graph"
      },
      issue: issueSnapshot(),
      project: { name: "symphonika" },
      provider: {
        command: DEFAULT_CODEX_COMMAND,
        name: "codex" as const
      },
      run: {
        attempt: 2,
        continuation: false,
        id: "run-9"
      },
      template: "Work on {{issue.title}}.",
      workflowContentHash: expanded.workflow.contentHash,
      workflowPath,
      workspace: {
        path: workspacePath,
        previous_attempt: true,
        root: path.dirname(path.dirname(workspacePath))
      }
    };
    const rendered = renderAutonomousPrompt(input);

    const evidence = await persistRunEvidence({
      ...input,
      attemptNumber: 2,
      expandedWorkflow: expanded.workflow,
      renderedPrompt: rendered,
      stateRoot
    });

    expect(evidence.workflowGraphPath).toBe(
      path.join(evidence.runEvidenceDirectory, "workflow-graph.attempt-2.json")
    );
    const graph = parseJsonRecord(
      await readFile(evidence.workflowGraphPath, "utf8")
    );
    expect(graph).toMatchObject({
      initial: "planning",
      name: "issue_to_merge",
      source: {
        kind: "raw_fsm",
        path: workflowPath
      }
    });
    const states = graph.states as Array<Record<string, unknown>>;
    expect(states.map((state) => state.id)).toEqual([
      "planning",
      "implementing",
      "done"
    ]);
    expect(states[2]?.terminal).toBe("success");
    expect(states[0]?.transitions).toEqual([
      { to: "implementing", when: {} }
    ]);
    expect(states[1]?.transitions).toEqual([{ to: "done", when: {} }]);
  });

  it("reports invalid raw FSM transitions and predicates", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: planning",
        "  states:",
        "    planning:",
        "      action:",
        "        kind: agent",
        "        provider: codex",
        "        prompt: prompts/plan.md",
        "      complete_when:",
        "        local_guess: true",
        "      transitions:",
        "        - to: missing_state",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toContain(
      `workflow state planning at ${workflowPath} complete_when uses unknown predicate local_guess`
    );
    expect(result.errors).toContain(
      `workflow state planning at ${workflowPath} transitions to unknown state missing_state`
    );
  });

  it("rejects terminal states that also declare work or outgoing transitions", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: done",
        "  states:",
        "    done:",
        "      terminal: success",
        "      action:",
        "        kind: wait",
        "      complete_when:",
        "        provider_success: true",
        "      transitions:",
        "        - to: next",
        "    next:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toContain(
      `workflow state done at ${workflowPath} terminal states must not define action, complete_when, or transitions`
    );
  });

  it("accepts a wait action that defines no provider or prompt", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: holding",
        "  states:",
        "    holding:",
        "      action:",
        "        kind: wait",
        "      transitions:",
        "        - to: done",
        "          when:",
        "            checks: success",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toEqual([]);
    const holding = result.workflow.states.find((state) => state.id === "holding");
    expect(holding?.action?.kind).toBe("wait");
  });

  it("rejects a wait action that declares a provider", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: holding",
        "  states:",
        "    holding:",
        "      action:",
        "        kind: wait",
        "        provider: claude",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toContain(
      `workflow state holding at ${workflowPath} wait action must not define provider`
    );
  });

  it("rejects a wait action that declares a prompt", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: holding",
        "  states:",
        "    holding:",
        "      action:",
        "        kind: wait",
        "        prompt: hello",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toContain(
      `workflow state holding at ${workflowPath} wait action must not define prompt`
    );
  });

  it("rejects YAML workflow files that are missing the top-level workflow mapping", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflows:",
        "  name: typo",
        "  initial: planning",
        "  states:",
        "    planning:",
        "      action:",
        "        kind: wait",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toContain(
      `workflow definition at ${workflowPath} must define a top-level workflow mapping`
    );
  });

  it("accepts a merge_pr action with an optional method override", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: merging",
        "  states:",
        "    merging:",
        "      action:",
        "        kind: merge_pr",
        "        method: squash",
        "      transitions:",
        "        - to: done",
        "          when:",
        "            pr_merged: true",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);
    const merging = result.workflow.states.find((state) => state.id === "merging");

    expect(result.errors).toEqual([]);
    expect(merging?.action?.kind).toBe("merge_pr");
    expect(merging?.action?.method).toBe("squash");
  });

  it("rejects a merge_pr action that declares a provider", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: merging",
        "  states:",
        "    merging:",
        "      action:",
        "        kind: merge_pr",
        "        provider: codex",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toContain(
      `workflow state merging at ${workflowPath} merge_pr action must not define provider`
    );
  });

  it("rejects a merge_pr action that declares a prompt", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: merging",
        "  states:",
        "    merging:",
        "      action:",
        "        kind: merge_pr",
        "        prompt: please-merge",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toContain(
      `workflow state merging at ${workflowPath} merge_pr action must not define prompt`
    );
  });

  it("rejects a merge_pr action with an unknown method", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: merging",
        "  states:",
        "    merging:",
        "      action:",
        "        kind: merge_pr",
        "        method: fast-forward",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toContain(
      `workflow state merging at ${workflowPath} merge_pr method must be one of merge, rebase, squash`
    );
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

function issueSnapshot() {
  return {
    body: "Implement prompt evidence.",
    created_at: "2026-04-28T10:00:00Z",
    id: 700,
    labels: ["agent-ready"],
    number: 7,
    priority: 99,
    state: "open",
    title: "Render autonomous prompts and persist run evidence",
    updated_at: "2026-04-29T10:00:00Z",
    url: "https://github.com/pmatos/symphonika/issues/7"
  };
}

function parseJsonRecord(contents: string): Record<string, unknown> {
  const parsed = JSON.parse(contents) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("expected JSON object");
  }

  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
