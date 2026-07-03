import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BUILTIN_WORKFLOW_TEMPLATES } from "../src/builtin-templates.js";
import { decideNextStep } from "../src/lifecycle/state-machine-dispatch.js";
import {
  explainWorkflow as explainWorkflowFromFacade,
  loadExpandedWorkflow as loadExpandedWorkflowFromFacade,
  loadProjectWorkflow as loadProjectWorkflowFromFacade,
  validateExpandedWorkflowReferences as validateExpandedWorkflowReferencesFromFacade
} from "../src/workflow.js";
import {
  explainWorkflow,
  loadExpandedWorkflow,
  loadProjectWorkflow,
  validateExpandedWorkflowReferences
} from "../src/workflow/fsm-expansion.js";
import type { ExpandedWorkflow } from "../src/workflow/types.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-workflow-test-"));
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

describe("workflow FSM expansion facade", () => {
  it("keeps FSM expansion exports available through the workflow facade", () => {
    expect(loadExpandedWorkflowFromFacade).toBe(loadExpandedWorkflow);
    expect(loadProjectWorkflowFromFacade).toBe(loadProjectWorkflow);
    expect(validateExpandedWorkflowReferencesFromFacade).toBe(
      validateExpandedWorkflowReferences
    );
    expect(explainWorkflowFromFacade).toBe(explainWorkflow);
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
        '      provider: "{{ planner }}"',
        '      prompt: "{{ plan_prompt }}"',
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

  it("does not rewrite expanded template transitions as instance targets", async () => {
    const root = await makeTempRoot();
    const templateDir = path.join(root, ".symphonika", "workflow-templates");
    await mkdir(templateDir, { recursive: true });
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      path.join(templateDir, "build.yml"),
      [
        "name: build",
        "entry: planning",
        "states:",
        "  planning:",
        "    action:",
        "      kind: agent",
        "      provider: codex",
        "      prompt: prompts/plan.md",
        "    transitions:",
        "      - to: pr",
        "  pr:",
        "    terminal: success",
        ""
      ].join("\n")
    );
    await writeFile(
      path.join(templateDir, "followup.yml"),
      [
        "name: followup",
        "entry: start",
        "states:",
        "  start:",
        "    terminal: success",
        ""
      ].join("\n")
    );
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: build",
        "  use:",
        "    build:",
        "      template: .symphonika/workflow-templates/build.yml",
        "    build.pr:",
        "      template: .symphonika/workflow-templates/followup.yml",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toEqual([]);
    expect(result.workflow.states.map((state) => state.id)).toEqual([
      "build.planning",
      "build.pr",
      "build.pr.start"
    ]);
    expect(result.workflow.states[0]).toMatchObject({
      id: "build.planning",
      transitions: [{ to: "build.pr", when: {} }]
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
        '      prompt: "{{ missing_prompt }}"',
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

  it("accepts pull request review-state predicates in raw FSM transitions", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: review_wait",
        "  initial: wait_for_review",
        "  states:",
        "    wait_for_review:",
        "      action:",
        "        kind: wait",
        "      transitions:",
        "        - to: autofix",
        "          when:",
        "            has_unresolved_reviews: true",
        "        - to: ready",
        "          when:",
        "            review_decision: approved",
        "    autofix:",
        "      action:",
        "        kind: agent",
        "        provider: codex",
        "        prompt: prompts/autofix.md",
        "      transitions:",
        "        - to: wait_for_review",
        "    ready:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toEqual([]);
    const waitState = result.workflow.states.find(
      (state) => state.id === "wait_for_review"
    );
    expect(waitState?.transitions).toEqual([
      { to: "autofix", when: { has_unresolved_reviews: true } },
      { to: "ready", when: { review_decision: "approved" } }
    ]);
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
    const holding = result.workflow.states.find(
      (state) => state.id === "holding"
    );
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
    const merging = result.workflow.states.find(
      (state) => state.id === "merging"
    );

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

describe("built-in workflow templates", () => {
  it("expands builtin:single-agent-pr through the same template machinery as repo-local templates", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_pr",
        "  initial: shipit",
        "  use:",
        "    shipit:",
        "      template: builtin:single-agent-pr",
        "      with:",
        "        provider: codex",
        "        prompt: prompts/single-agent.md",
        "      exits:",
        "        success: done",
        "        blocked: failed",
        "  states:",
        "    done:",
        "      terminal: success",
        "    failed:",
        "      terminal: blocked",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toEqual([]);
    expect(result.workflow.initial).toBe("shipit.agent");
    expect(result.workflow.templateFiles).toEqual(["builtin:single-agent-pr"]);
    expect(result.workflow.states.map((state) => state.id).sort()).toEqual([
      "done",
      "failed",
      "shipit.agent"
    ]);
    const agentState = result.workflow.states.find(
      (state) => state.id === "shipit.agent"
    );
    expect(agentState?.action).toEqual({
      kind: "agent",
      prompt: "prompts/single-agent.md",
      provider: "codex"
    });
  });

  it("reports an actionable error when a workflow references an unknown built-in template", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_pr",
        "  initial: mystery",
        "  use:",
        "    mystery:",
        "      template: builtin:does-not-exist",
        "      exits:",
        "        success: done",
        "        blocked: failed",
        "  states:",
        "    done:",
        "      terminal: success",
        "    failed:",
        "      terminal: blocked",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toContain(
      `workflow template instance mystery at ${workflowPath} references unknown built-in template builtin:does-not-exist`
    );
  });

  it("expands builtin:plan-tdd-pr into planning and implementation agent states", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_pr",
        "  initial: build",
        "  use:",
        "    build:",
        "      template: builtin:plan-tdd-pr",
        "      with:",
        "        planner: codex",
        "        implementer: claude",
        "        plan_prompt: prompts/plan.md",
        "        impl_prompt: prompts/impl.md",
        "      exits:",
        "        success: shipped",
        "        blocked: needs_human",
        "  states:",
        "    shipped:",
        "      terminal: success",
        "    needs_human:",
        "      terminal: blocked",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toEqual([]);
    expect(result.workflow.initial).toBe("build.planning");
    expect(result.workflow.templateFiles).toEqual(["builtin:plan-tdd-pr"]);
    const planning = result.workflow.states.find(
      (state) => state.id === "build.planning"
    );
    expect(planning?.action).toEqual({
      kind: "agent",
      prompt: "prompts/plan.md",
      provider: "codex"
    });
    const implementing = result.workflow.states.find(
      (state) => state.id === "build.implementing"
    );
    expect(implementing?.action).toEqual({
      kind: "agent",
      prompt: "prompts/impl.md",
      provider: "claude"
    });
    expect(planning?.transitions.map((t) => t.to)).toContain(
      "build.implementing"
    );
  });

  it("completes builtin:plan-tdd-pr planning on the signals signalsFromTerminal actually emits", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: issue_to_pr",
        "  initial: build",
        "  use:",
        "    build:",
        "      template: builtin:plan-tdd-pr",
        "      exits:",
        "        success: shipped",
        "        blocked: needs_human",
        "  states:",
        "    shipped:",
        "      terminal: success",
        "    needs_human:",
        "      terminal: blocked",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);
    expect(result.errors).toEqual([]);
    const planning = result.workflow.states.find(
      (state) => state.id === "build.planning"
    );
    if (planning === undefined) {
      throw new Error("expected build.planning");
    }

    // signalsFromTerminal emits exactly {branch_ahead_of_base, provider_success};
    // planning.complete_when must be satisfiable with just those, or the state
    // parks indefinitely after a successful planner run.
    const decision = decideNextStep({
      actionExecuted: true,
      signals: { branch_ahead_of_base: true, provider_success: true },
      state: planning
    });
    expect(decision).toMatchObject({
      kind: "advance",
      to: "build.implementing"
    });
  });

  it("routes failed agent outcomes through every built-in's blocked exit", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: every_builtin",
        "  initial: ship",
        "  use:",
        "    ship:",
        "      template: builtin:single-agent-pr",
        "      exits:",
        "        success: shipped",
        "        blocked: needs_human",
        "    build:",
        "      template: builtin:plan-tdd-pr",
        "      exits:",
        "        success: shipped",
        "        blocked: needs_human",
        "    review:",
        "      template: builtin:autofix-until-clean",
        "      exits:",
        "        success: shipped",
        "        blocked: needs_human",
        "  states:",
        "    shipped:",
        "      terminal: success",
        "    needs_human:",
        "      terminal: blocked",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);
    expect(result.errors).toEqual([]);

    const stateById = (id: string) => {
      const state = result.workflow.states.find((s) => s.id === id);
      if (state === undefined) {
        throw new Error(`expected state ${id}`);
      }
      return state;
    };
    const decide = (
      id: string,
      signals: Record<string, string | number | boolean>
    ) =>
      decideNextStep({ actionExecuted: true, signals, state: stateById(id) });

    // signalsFromTerminal emits these three shapes; assert each agent state
    // routes them through the template's mapped blocked exit (needs_human)
    // instead of stalling with kind="blocked".
    const failureSignals = {
      branch_ahead_of_base: false,
      provider_success: false
    };
    const noChangeSignals = {
      branch_ahead_of_base: false,
      provider_success: true
    };

    expect(decide("ship.agent", failureSignals)).toMatchObject({
      kind: "advance",
      to: "needs_human"
    });
    expect(decide("ship.agent", noChangeSignals)).toMatchObject({
      kind: "advance",
      to: "needs_human"
    });

    expect(decide("build.planning", failureSignals)).toMatchObject({
      kind: "advance",
      to: "needs_human"
    });
    // Planning that succeeded without a commit advances — PLAN.md may be
    // uncommitted scratch the implementer reads.
    expect(decide("build.planning", noChangeSignals)).toMatchObject({
      kind: "advance",
      to: "build.implementing"
    });

    expect(decide("build.implementing", failureSignals)).toMatchObject({
      kind: "advance",
      to: "needs_human"
    });
    expect(decide("build.implementing", noChangeSignals)).toMatchObject({
      kind: "advance",
      to: "needs_human"
    });

    expect(decide("review.autofix", failureSignals)).toMatchObject({
      kind: "advance",
      to: "needs_human"
    });
    // Autofix that succeeded without a commit re-enters waiting so the PR
    // predicates decide next.
    expect(decide("review.autofix", noChangeSignals)).toMatchObject({
      kind: "advance",
      to: "review.waiting"
    });
  });

  it("expands builtin:autofix-until-clean into a wait/autofix loop", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: pr_autofix",
        "  initial: review",
        "  use:",
        "    review:",
        "      template: builtin:autofix-until-clean",
        "      with:",
        "        provider: codex",
        "        fix_prompt: prompts/autofix.md",
        "      exits:",
        "        success: shipped",
        "        blocked: needs_human",
        "  states:",
        "    shipped:",
        "      terminal: success",
        "    needs_human:",
        "      terminal: blocked",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toEqual([]);
    expect(result.workflow.initial).toBe("review.waiting");
    const waiting = result.workflow.states.find(
      (state) => state.id === "review.waiting"
    );
    expect(waiting?.action).toEqual({ kind: "wait" });
    const autofix = result.workflow.states.find(
      (state) => state.id === "review.autofix"
    );
    expect(autofix?.action).toEqual({
      kind: "agent",
      prompt: "prompts/autofix.md",
      provider: "codex"
    });
    expect(waiting?.transitions.map((t) => t.to)).toContain("review.autofix");
    expect(autofix?.transitions.map((t) => t.to)).toContain("review.waiting");
  });

  it("routes builtin:autofix-until-clean to autofix on any non-zero unresolved review thread count", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: pr_autofix",
        "  initial: review",
        "  use:",
        "    review:",
        "      template: builtin:autofix-until-clean",
        "      exits:",
        "        success: shipped",
        "        blocked: needs_human",
        "  states:",
        "    shipped:",
        "      terminal: success",
        "    needs_human:",
        "      terminal: blocked",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);
    expect(result.errors).toEqual([]);
    const waiting = result.workflow.states.find(
      (state) => state.id === "review.waiting"
    );
    expect(waiting).toBeDefined();
    if (waiting === undefined) {
      throw new Error("expected review.waiting state");
    }

    const advance = (signals: Record<string, string | number>) =>
      decideNextStep({ actionExecuted: true, signals, state: waiting });

    expect(
      advance({ checks: "success", unresolved_review_threads: 0 })
    ).toMatchObject({
      kind: "advance",
      to: "shipped"
    });
    expect(
      advance({ checks: "success", unresolved_review_threads: 1 })
    ).toMatchObject({
      kind: "advance",
      to: "review.autofix"
    });
    expect(
      advance({ checks: "success", unresolved_review_threads: 2 })
    ).toMatchObject({
      kind: "advance",
      to: "review.autofix"
    });
    expect(
      advance({ checks: "success", unresolved_review_threads: 7 })
    ).toMatchObject({
      kind: "advance",
      to: "review.autofix"
    });
    expect(
      advance({ checks: "failure", unresolved_review_threads: 3 })
    ).toMatchObject({
      kind: "advance",
      to: "needs_human"
    });
  });

  it("expands builtin:merge-when-green with the default squash merge method", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: pr_merge",
        "  initial: gate",
        "  use:",
        "    gate:",
        "      template: builtin:merge-when-green",
        "      exits:",
        "        success: shipped",
        "        blocked: needs_human",
        "  states:",
        "    shipped:",
        "      terminal: success",
        "    needs_human:",
        "      terminal: blocked",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toEqual([]);
    expect(result.workflow.initial).toBe("gate.merging");
    const merging = result.workflow.states.find(
      (state) => state.id === "gate.merging"
    );
    expect(merging?.action).toEqual({ kind: "merge_pr", method: "squash" });
  });

  it("starts builtin:merge-when-green directly in merge_pr so the workflow owns the merge from the first parked row", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: pr_merge",
        "  initial: gate",
        "  use:",
        "    gate:",
        "      template: builtin:merge-when-green",
        "      exits:",
        "        success: shipped",
        "        blocked: needs_human",
        "  states:",
        "    shipped:",
        "      terminal: success",
        "    needs_human:",
        "      terminal: blocked",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);
    expect(result.errors).toEqual([]);
    expect(result.workflow.initial).toBe("gate.merging");
    expect(
      result.workflow.states.find((s) => s.id === "gate.waiting")
    ).toBeUndefined();
    const merging = result.workflow.states.find((s) => s.id === "gate.merging");
    expect(merging).toBeDefined();
    if (merging === undefined) {
      throw new Error("expected gate.merging");
    }
    expect(merging.action?.kind).toBe("merge_pr");

    const advance = (signals: Record<string, string | number | boolean>) =>
      decideNextStep({ actionExecuted: true, signals, state: merging });

    expect(advance({ pr_merged: true })).toMatchObject({
      kind: "advance",
      to: "shipped"
    });
    expect(advance({ checks: "failure" })).toMatchObject({
      kind: "advance",
      to: "needs_human"
    });
    expect(advance({ mergeable: false })).toMatchObject({
      kind: "advance",
      to: "needs_human"
    });
    expect(advance({ checks: "pending" })).toMatchObject({
      kind: "stay_waiting"
    });
    expect(advance({})).toMatchObject({ kind: "stay_waiting" });
    // Closed-unmerged PR: pr_open=false, pr_merged absent, mergeable likely
    // omitted (UNKNOWN). The merge_pr action can't merge a non-OPEN PR, so
    // the template's blocked exit must take over.
    expect(advance({ pr_open: false, checks: "success" })).toMatchObject({
      kind: "advance",
      to: "needs_human"
    });
    // And a merged PR still wins done despite also having pr_open: false.
    expect(advance({ pr_merged: true, pr_open: false })).toMatchObject({
      kind: "advance",
      to: "shipped"
    });
  });

  it("respects an explicit method input on builtin:merge-when-green", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: pr_merge",
        "  initial: gate",
        "  use:",
        "    gate:",
        "      template: builtin:merge-when-green",
        "      with:",
        "        method: rebase",
        "      exits:",
        "        success: shipped",
        "        blocked: needs_human",
        "  states:",
        "    shipped:",
        "      terminal: success",
        "    needs_human:",
        "      terminal: blocked",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toEqual([]);
    const merging = result.workflow.states.find(
      (state) => state.id === "gate.merging"
    );
    expect(merging?.action).toEqual({ kind: "merge_pr", method: "rebase" });
  });

  it("produces the same expanded states whether single-agent-pr is referenced as builtin or copied to a local template file", async () => {
    const builtinRoot = await makeTempRoot();
    const localRoot = await makeTempRoot();

    const wrapper = (templateRef: string) =>
      [
        "workflow:",
        "  name: issue_to_pr",
        "  initial: shipit",
        "  use:",
        "    shipit:",
        `      template: ${templateRef}`,
        "      with:",
        "        provider: codex",
        "        prompt: prompts/single-agent.md",
        "      exits:",
        "        success: done",
        "        blocked: failed",
        "  states:",
        "    done:",
        "      terminal: success",
        "    failed:",
        "      terminal: blocked",
        ""
      ].join("\n");

    const builtinPath = path.join(builtinRoot, "workflow.yml");
    await writeFile(builtinPath, wrapper("builtin:single-agent-pr"));

    const localTemplateDir = path.join(
      localRoot,
      ".symphonika",
      "workflow-templates"
    );
    await mkdir(localTemplateDir, { recursive: true });
    const builtinYaml = BUILTIN_WORKFLOW_TEMPLATES["single-agent-pr"];
    if (builtinYaml === undefined) {
      throw new Error("BUILTIN_WORKFLOW_TEMPLATES missing single-agent-pr");
    }
    await writeFile(
      path.join(localTemplateDir, "single-agent-pr.yml"),
      builtinYaml
    );
    const localPath = path.join(localRoot, "workflow.yml");
    await writeFile(
      localPath,
      wrapper(".symphonika/workflow-templates/single-agent-pr.yml")
    );

    const builtinResult = await loadExpandedWorkflow(builtinPath);
    const localResult = await loadExpandedWorkflow(localPath);

    expect(builtinResult.errors).toEqual([]);
    expect(localResult.errors).toEqual([]);
    expect(builtinResult.workflow.initial).toBe(localResult.workflow.initial);
    expect(builtinResult.workflow.states).toEqual(localResult.workflow.states);
  });
});

describe("validateExpandedWorkflowReferences", () => {
  it("returns no errors when every raw FSM agent prompt resolves to an existing file", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    const promptRelPath = "prompts/plan.md";
    await mkdir(path.join(root, "prompts"), { recursive: true });
    await writeFile(path.join(root, promptRelPath), "Plan the work.\n");

    const workflow: ExpandedWorkflow = {
      contentHash: "sha256:placeholder",
      initial: "planning",
      name: "valid",
      source: { kind: "raw_fsm", path: workflowPath },
      states: [
        {
          action: { kind: "agent", provider: "codex", prompt: promptRelPath },
          completeWhen: {},
          id: "planning",
          transitions: [{ to: "done", when: {} }]
        },
        { completeWhen: {}, id: "done", terminal: "success", transitions: [] }
      ],
      templateFiles: []
    };

    const errors = await validateExpandedWorkflowReferences(
      workflow,
      workflowPath
    );
    expect(errors).toEqual([]);
  });

  it("reports a missing raw FSM agent prompt with the state id and resolved path", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    const promptRelPath = "prompts/missing.md";

    const workflow: ExpandedWorkflow = {
      contentHash: "sha256:placeholder",
      initial: "planning",
      name: "missing_prompt",
      source: { kind: "raw_fsm", path: workflowPath },
      states: [
        {
          action: { kind: "agent", provider: "codex", prompt: promptRelPath },
          completeWhen: {},
          id: "planning",
          transitions: [{ to: "done", when: {} }]
        },
        { completeWhen: {}, id: "done", terminal: "success", transitions: [] }
      ],
      templateFiles: []
    };

    const errors = await validateExpandedWorkflowReferences(
      workflow,
      workflowPath
    );
    expect(errors).toHaveLength(1);
    const expectedPath = path.resolve(root, promptRelPath);
    expect(errors[0]).toContain("planning");
    expect(errors[0]).toContain("prompt not found");
    expect(errors[0]).toContain(expectedPath);
  });

  it("aggregates one error per missing prompt across multiple agent states", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");

    const workflow: ExpandedWorkflow = {
      contentHash: "sha256:placeholder",
      initial: "plan",
      name: "two_missing",
      source: { kind: "raw_fsm", path: workflowPath },
      states: [
        {
          action: {
            kind: "agent",
            provider: "codex",
            prompt: "prompts/plan.md"
          },
          completeWhen: {},
          id: "plan",
          transitions: [{ to: "build", when: {} }]
        },
        {
          action: {
            kind: "agent",
            provider: "codex",
            prompt: "prompts/build.md"
          },
          completeWhen: {},
          id: "build",
          transitions: [{ to: "done", when: {} }]
        },
        { completeWhen: {}, id: "done", terminal: "success", transitions: [] }
      ],
      templateFiles: []
    };

    const errors = await validateExpandedWorkflowReferences(
      workflow,
      workflowPath
    );
    expect(errors).toHaveLength(2);
    expect(errors.some((message) => message.includes("plan"))).toBe(true);
    expect(errors.some((message) => message.includes("build"))).toBe(true);
  });

  it("reports an error when a raw FSM agent prompt path resolves to a directory", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    const promptRelPath = "prompts/dir-not-file";
    await mkdir(path.join(root, promptRelPath), { recursive: true });

    const workflow: ExpandedWorkflow = {
      contentHash: "sha256:placeholder",
      initial: "planning",
      name: "directory_target",
      source: { kind: "raw_fsm", path: workflowPath },
      states: [
        {
          action: { kind: "agent", provider: "codex", prompt: promptRelPath },
          completeWhen: {},
          id: "planning",
          transitions: [{ to: "done", when: {} }]
        },
        { completeWhen: {}, id: "done", terminal: "success", transitions: [] }
      ],
      templateFiles: []
    };

    const errors = await validateExpandedWorkflowReferences(
      workflow,
      workflowPath
    );
    expect(errors).toHaveLength(1);
    const expectedPath = path.resolve(root, promptRelPath);
    expect(errors[0]).toContain("planning");
    expect(errors[0]).toContain("prompt not found");
    expect(errors[0]).toContain(expectedPath);
  });

  it("skips validation for markdown-sourced workflows", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "WORKFLOW.md");

    const workflow: ExpandedWorkflow = {
      contentHash: "sha256:placeholder",
      initial: "run_agent",
      name: "markdown_workflow",
      source: { kind: "markdown", path: workflowPath },
      states: [
        {
          action: {
            kind: "agent",
            provider: "codex",
            prompt: "prompts/never.md"
          },
          completeWhen: {},
          id: "run_agent",
          transitions: [{ to: "done", when: {} }]
        },
        { completeWhen: {}, id: "done", terminal: "success", transitions: [] }
      ],
      templateFiles: []
    };

    const errors = await validateExpandedWorkflowReferences(
      workflow,
      workflowPath
    );
    expect(errors).toEqual([]);
  });
});
