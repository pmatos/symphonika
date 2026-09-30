import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  collectWorkflowPromptConventionWarnings,
  explainWorkflow,
  loadExpandedWorkflow,
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

describe("state machine workflow definitions", () => {
  it("locates a YAML syntax error in a raw_fsm workflow definition (#307, ADR 0076)", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      ["workflow:", "  name: [unterminated", ""].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath, "raw_fsm");

    expect(result.errors[0]).toMatch(/\(line \d+, column \d+\)/);
  });

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

  it("rejects workflow.use because workflow templates are no longer supported", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: templated",
        "  initial: build",
        "  use:",
        "    build:",
        "      template: builtin:single-agent-pr",
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
      `workflow definition at ${workflowPath} workflow.use is not supported; declare every state directly under workflow.states`
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

  it("accepts artifact_exists on a transition and renders it in the explanation", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: gated_planning",
        "  initial: planning",
        "  states:",
        "    planning:",
        "      action:",
        "        kind: agent",
        "        provider: codex",
        "        prompt: prompts/plan.md",
        "      transitions:",
        "        - to: implementing",
        "          when:",
        "            provider_success: true",
        "            artifact_exists: PLAN.md",
        "        - to: needs_plan",
        "    implementing:",
        "      action:",
        "        kind: agent",
        "        provider: codex",
        "        prompt: prompts/impl.md",
        "      complete_when:",
        "        artifact_exists:",
        "          - PLAN.md",
        "          - docs/notes.md",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        "    needs_plan:",
        "      terminal: blocked",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);
    const explanation = explainWorkflow(result.workflow);

    expect(result.errors).toEqual([]);
    const planning = result.workflow.states.find(
      (state) => state.id === "planning"
    );
    expect(planning?.transitions).toEqual([
      {
        to: "implementing",
        when: { artifact_exists: "PLAN.md", provider_success: true }
      },
      { to: "needs_plan", when: {} }
    ]);
    const implementing = result.workflow.states.find(
      (state) => state.id === "implementing"
    );
    expect(implementing?.completeWhen).toEqual({
      artifact_exists: ["PLAN.md", "docs/notes.md"]
    });

    // `workflow validate`/`explain` must render the predicate, so an author can
    // see the gate they wrote rather than guessing whether it took effect.
    expect(explanation).toContain(
      "-> implementing when provider_success=true, artifact_exists=PLAN.md"
    );
    expect(explanation).toContain(
      "complete_when: artifact_exists=[PLAN.md, docs/notes.md]"
    );
  });

  it("rejects artifact_exists paths that are absolute, escaping, or not strings", async () => {
    const root = await makeTempRoot();
    const cases: Array<{ error: string; value: string[] }> = [
      {
        error: "path /etc/passwd must be workspace-relative, not absolute",
        value: ["        artifact_exists: /etc/passwd"]
      },
      {
        error: "path ../PLAN.md must stay inside the run workspace",
        value: ["        artifact_exists: ../PLAN.md"]
      },
      {
        error: "must be a path string or a sequence of path strings",
        value: ["        artifact_exists: true"]
      },
      {
        error: "must not contain an empty path",
        value: ['        artifact_exists: ""']
      },
      {
        error: "must list at least one path",
        value: ["        artifact_exists: []"]
      },
      {
        error: "must be a path string or a sequence of path strings",
        value: [
          "        artifact_exists:",
          "          - PLAN.md",
          "          - 7"
        ]
      }
    ];

    for (const [index, testCase] of cases.entries()) {
      const workflowPath = path.join(root, `workflow-${index}.yml`);
      await writeFile(
        workflowPath,
        [
          "workflow:",
          "  name: gated_planning",
          "  initial: planning",
          "  states:",
          "    planning:",
          "      action:",
          "        kind: agent",
          "        provider: codex",
          "        prompt: prompts/plan.md",
          "      complete_when:",
          ...testCase.value,
          "      transitions:",
          "        - to: done",
          "    done:",
          "      terminal: success",
          ""
        ].join("\n")
      );

      const result = await loadExpandedWorkflow(workflowPath);
      expect(result.errors, testCase.error).toContain(
        `workflow state planning at ${workflowPath} complete_when.artifact_exists ${testCase.error}`
      );
    }
  });

  it("rejects the previously reserved branch_pushed and timeout predicates", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: dead_predicates",
        "  initial: planning",
        "  states:",
        "    planning:",
        "      action:",
        "        kind: agent",
        "        provider: codex",
        "        prompt: prompts/plan.md",
        "      complete_when:",
        "        branch_pushed: true",
        "      transitions:",
        "        - to: done",
        "          when:",
        "            timeout: 30",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toContain(
      `workflow state planning at ${workflowPath} complete_when uses unknown predicate branch_pushed`
    );
    expect(result.errors).toContain(
      `workflow state planning at ${workflowPath} transitions[0].when uses unknown predicate timeout`
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
        "        - to: autofix",
        "          when:",
        "            checks: failure",
        "        - to: ready",
        "          when:",
        "            checks: success",
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
      { to: "ready", when: { review_decision: "approved" } },
      { to: "autofix", when: { checks: "failure" } },
      { to: "ready", when: { checks: "success" } }
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
        "        - to: done",
        "          when:",
        "            checks: failure",
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

  it("allows an artifact-gated wait to park while its artifact is absent", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: artifact_handoff",
        "  initial: holding",
        "  states:",
        "    holding:",
        "      action:",
        "        kind: wait",
        "      transitions:",
        "        - to: done",
        "          when:",
        "            checks: success",
        "            artifact_exists: HANDOFF.md",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toEqual([]);
  });

  it("still checks a wait whose artifact gate covers only some transitions", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: partial_artifact_gate",
        "  initial: holding",
        "  states:",
        "    holding:",
        "      action:",
        "        kind: wait",
        "      transitions:",
        "        - to: done",
        "          when:",
        "            checks: success",
        "            artifact_exists: HANDOFF.md",
        "        - to: done",
        "          when:",
        "            checks: failure",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toContainEqual(
      expect.stringContaining(
        `workflow state holding at ${workflowPath} is a wait with no transition matching pull request signals pr_open=true`
      )
    );
  });

  it("does not let an agent-signal transition cover a parked wait", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: agent_signal_gate",
        "  initial: holding",
        "  states:",
        "    holding:",
        "      action:",
        "        kind: wait",
        "      transitions:",
        "        - to: done",
        "          when:",
        "            checks: failure",
        "        - to: done",
        "          when:",
        "            branch_ahead_of_base: true",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    // branch_ahead_of_base is never emitted into a parked wait's signal map
    // (unlike provider_success, which observeWaitPullRequestSignals always
    // sets true), so this transition can never actually match and must not
    // count as coverage.
    expect(result.errors).toContainEqual(
      expect.stringContaining(
        `workflow state holding at ${workflowPath} is a wait with no transition matching pull request signals pr_open=true`
      )
    );
  });

  it("lets a bare provider_success transition cover every other combination", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: provider_success_fallback",
        "  initial: holding",
        "  states:",
        "    holding:",
        "      action:",
        "        kind: wait",
        "      transitions:",
        "        - to: done",
        "          when:",
        "            checks: failure",
        "        - to: retry",
        "          when:",
        "            provider_success: true",
        "    done:",
        "      terminal: success",
        "    retry:",
        "      terminal: blocked",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    // observeWaitPullRequestSignals always sets provider_success: true
    // alongside every real observation, so a bare provider_success: true
    // transition is a genuine runtime catch-all for whatever the earlier,
    // more specific transition doesn't match -- it does not need to share a
    // transition with a pull-request signal to be coverable.
    expect(result.errors).toEqual([]);
  });

  it("lets provider_success: true alongside a pull request signal cover a parked wait", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: agent_success_gate",
        "  initial: holding",
        "  states:",
        "    holding:",
        "      action:",
        "        kind: wait",
        "      transitions:",
        "        - to: done",
        "          when:",
        "            checks: success",
        "            provider_success: true",
        "        - to: done",
        "          when:",
        "            checks: failure",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toEqual([]);
  });

  it("does not require wait transitions to cover signals complete_when already excludes", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: complete_when_gate",
        "  initial: holding",
        "  states:",
        "    holding:",
        "      action:",
        "        kind: wait",
        "      complete_when:",
        "        checks: success",
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
  });

  it("allows an artifact-gated wait to park under a complete_when PR gate", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: complete_when_artifact_gate",
        "  initial: holding",
        "  states:",
        "    holding:",
        "      action:",
        "        kind: wait",
        "      complete_when:",
        "        checks: success",
        "      transitions:",
        "        - to: done",
        "          when:",
        "            checks: success",
        "            artifact_exists: HANDOFF.md",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toEqual([]);
  });

  it("still checks a complete_when-gated wait whose artifact gate covers only some transitions", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: complete_when_partial_artifact_gate",
        "  initial: holding",
        "  states:",
        "    holding:",
        "      action:",
        "        kind: wait",
        "      complete_when:",
        "        checks: success",
        "      transitions:",
        "        - to: done",
        "          when:",
        "            checks: success",
        "            artifact_exists: HANDOFF.md",
        "        - to: merged",
        "          when:",
        "            checks: success",
        "            mergeable: true",
        "    done:",
        "      terminal: success",
        "    merged:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    // The artifact-gated transition never counts as coverage; the plain
    // transition only covers mergeable: true, so mergeable: false (still
    // reachable, since complete_when only narrows on checks) is uncovered.
    expect(result.errors).toContainEqual(
      expect.stringContaining(
        `workflow state holding at ${workflowPath} is a wait with no transition matching pull request signals`
      )
    );
  });

  it("rejects a wait transition that gates on a positive unresolved_review_threads count", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: exact_count_gate",
        "  initial: holding",
        "  states:",
        "    holding:",
        "      action:",
        "        kind: wait",
        "      transitions:",
        "        - to: failed",
        "          when:",
        "            pr_open: false",
        "        - to: merge",
        "          when:",
        "            checks: success",
        "            mergeable: true",
        "            unresolved_review_threads: 0",
        "        - to: repair",
        "          when:",
        "            mergeable: false",
        "        - to: repair",
        "          when:",
        "            checks: failure",
        "        - to: autofix",
        "          when:",
        "            unresolved_review_threads: 1",
        "    merge:",
        "      terminal: success",
        "    repair:",
        "      terminal: blocked",
        "    autofix:",
        "      terminal: blocked",
        "    failed:",
        "      terminal: blocked",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    // Every enumerated signal combination is otherwise matched by some
    // transition (pr_open: false, mergeable: false, checks: failure, or the
    // unresolved_review_threads: 0/1 pair cover the full product), so the
    // enumeration-based coverage check alone finds nothing wrong here -- a
    // real PR with two or more unresolved threads would still match no
    // transition and park forever. Only the dedicated exact-count rejection
    // catches it.
    expect(result.errors).toContainEqual(
      `workflow state holding at ${workflowPath} transition to autofix gates on unresolved_review_threads: 1, which cannot cover every unresolved-thread count; use has_unresolved_reviews: true instead`
    );
  });

  it("checks coverage for a wait whose only pull request predicate lives in complete_when", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: complete_when_only_gate",
        "  initial: holding",
        "  states:",
        "    holding:",
        "      action:",
        "        kind: wait",
        "      complete_when:",
        "        checks: success",
        "      transitions:",
        "        - to: done",
        "          when:",
        "            provider_success: false",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    // No transition names a pr_signal predicate, so without also inspecting
    // complete_when this state would be classified as not observing pull
    // request signals at all and skipped entirely -- even though every
    // settled successful poll reaches the transition loop (complete_when is
    // satisfied) and matches nothing, since provider_success is always true
    // on a real observation.
    expect(result.errors).toContainEqual(
      expect.stringContaining(
        `workflow state holding at ${workflowPath} is a wait with no transition matching pull request signals`
      )
    );
  });

  it("lets an unconditional transition cover every observation on a parked wait", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: unconditional_fallback",
        "  initial: holding",
        "  states:",
        "    holding:",
        "      action:",
        "        kind: wait",
        "      transitions:",
        "        - to: done",
        "          when:",
        "            checks: success",
        "        - to: done",
        "          when: {}",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toEqual([]);
  });

  it("resolves provider_success: true inside complete_when the same way transitions do", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: complete_when_provider_success",
        "  initial: holding",
        "  states:",
        "    holding:",
        "      action:",
        "        kind: wait",
        "      complete_when:",
        "        checks: success",
        "        provider_success: true",
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
  });

  it("excludes only the combinations a resolvable complete_when predicate proves unmet, even alongside an unresolvable one", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: mixed_complete_when_gate",
        "  initial: holding",
        "  states:",
        "    holding:",
        "      action:",
        "        kind: wait",
        "      complete_when:",
        "        checks: success",
        "        artifact_exists: DONE",
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

    // checks: failure combinations are provably excluded on their own --
    // complete_when is an AND, so that one resolvable predicate failing is
    // enough regardless of whether artifact_exists can be resolved
    // statically. checks: success combinations cannot be proven excluded
    // (the artifact might exist), so they still need transition coverage,
    // and the sole `checks: success` transition provides it.
    expect(result.errors).toEqual([]);
  });

  it("lets a bare provider_success transition cover a wait whose only pull request predicate lives in complete_when", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: complete_when_only_provider_success",
        "  initial: holding",
        "  states:",
        "    holding:",
        "      action:",
        "        kind: wait",
        "      complete_when:",
        "        checks: success",
        "      transitions:",
        "        - to: done",
        "          when:",
        "            provider_success: true",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    // complete_when already narrows every combination this state has to
    // cover down to checks: success, and provider_success is always true on
    // a real observation, so the bare provider_success transition is a
    // genuine catch-all for that narrowed set (the same holds regardless of
    // whether complete_when or a sibling transition is what makes the state
    // PR-observing -- see "lets a bare provider_success transition cover
    // every other combination" above).
    expect(result.errors).toEqual([]);
  });

  it("rejects a wait whose complete_when gates on pr_merged with no covering transition", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: merged_gate_uncovered",
        "  initial: holding",
        "  states:",
        "    holding:",
        "      action:",
        "        kind: wait",
        "      complete_when:",
        "        pr_merged: true",
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

    // Before merged cases were enumerated, every generated signal map had
    // pr_merged absent, so reachesTransitions excluded every one of them and
    // this state read as fully covered with zero enumerated combinations
    // ever reaching the transitions loop -- even though a wait re-evaluates
    // against the tracked PR's live state regardless of which state the run
    // parked in, so complete_when: { pr_merged: true } genuinely can pass at
    // runtime once the PR merges, landing on a transition table that only
    // names `checks`.
    expect(result.errors).toContainEqual(
      expect.stringContaining(
        `workflow state holding at ${workflowPath} is a wait with no transition matching pull request signals`
      )
    );
  });

  it("lets a pr_merged catch-all cover every merged combination", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: merged_catch_all",
        "  initial: holding",
        "  states:",
        "    holding:",
        "      action:",
        "        kind: wait",
        "      transitions:",
        "        - to: merged",
        "          when:",
        "            pr_merged: true",
        "        - to: failed",
        "          when:",
        "            pr_open: false",
        "        - to: merge",
        "          when:",
        "            checks: success",
        "            mergeable: true",
        "            unresolved_review_threads: 0",
        "        - to: repair",
        "          when:",
        "            mergeable: false",
        "        - to: repair",
        "          when:",
        "            checks: failure",
        "        - to: repair",
        "          when:",
        "            has_unresolved_reviews: true",
        "    merged:",
        "      terminal: success",
        "    failed:",
        "      terminal: blocked",
        "    merge:",
        "      terminal: success",
        "    repair:",
        "      terminal: blocked",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    // This is the shape shipped in this repo's own workflow.yml wait_for_pr
    // state. Every merged combination (mergeable settled or permanently
    // unknown, checks settled, any review decision or thread count) is
    // caught by the pr_merged: true transition, ordered first so it is never
    // shadowed by the pr_open: false escape.
    expect(result.errors).toEqual([]);
  });

  it("rejects a wait that only covers settled mergeable values for a closed PR", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: closed_unmerged_unknown_mergeable_gap",
        "  initial: holding",
        "  states:",
        "    holding:",
        "      action:",
        "        kind: wait",
        "      transitions:",
        "        - to: merged",
        "          when:",
        "            pr_merged: true",
        "        - to: merge",
        "          when:",
        "            mergeable: true",
        "        - to: repair",
        "          when:",
        "            mergeable: false",
        "    merged:",
        "      terminal: success",
        "    merge:",
        "      terminal: success",
        "    repair:",
        "      terminal: blocked",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    // GitHub stops recomputing mergeability once a PR closes, merged or not,
    // so a closed-unmerged PR can settle at mergeable: unknown (the key
    // omitted) permanently, not just transiently the way it can while open.
    // None of the three transitions above name pr_open at all, so this
    // combination -- open: false, merged: false, mergeable omitted --
    // matches nothing and must be reported, not silently accepted the way it
    // was before mergeable: unknown was enumerated for a closed PR.
    expect(result.errors).toContainEqual(
      expect.stringContaining(
        `workflow state holding at ${workflowPath} is a wait with no transition matching pull request signals`
      )
    );
  });

  it("accepts Oh My Pi for an agent action provider", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: omp_workflow",
        "  initial: run_agent",
        "  states:",
        "    run_agent:",
        "      action:",
        "        kind: agent",
        "        provider: omp",
        "        prompt: prompts/run.md",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toEqual([]);
    expect(
      result.workflow.states.find((state) => state.id === "run_agent")?.action
    ).toEqual({
      kind: "agent",
      prompt: "prompts/run.md",
      provider: "omp"
    });
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

  it("accepts a close_issue action and defaults state_reason to completed", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: close_when_done",
        "  initial: closing",
        "  states:",
        "    closing:",
        "      action:",
        "        kind: close_issue",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);
    const closing = result.workflow.states.find(
      (state) => state.id === "closing"
    );

    expect(result.errors).toEqual([]);
    expect(closing?.action).toEqual({
      kind: "close_issue",
      stateReason: "completed"
    });
  });

  it("accepts a close_issue action with an explicit state_reason and closing comment body", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: close_not_planned",
        "  initial: closing",
        "  states:",
        "    closing:",
        "      action:",
        "        kind: close_issue",
        "        state_reason: not_planned",
        '        body: "Closing as not planned; superseded by #900."',
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);
    const closing = result.workflow.states.find(
      (state) => state.id === "closing"
    );

    expect(result.errors).toEqual([]);
    expect(closing?.action).toEqual({
      body: "Closing as not planned; superseded by #900.",
      kind: "close_issue",
      stateReason: "not_planned"
    });
  });

  it("rejects a close_issue action with an invalid state_reason", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: close_invalid",
        "  initial: closing",
        "  states:",
        "    closing:",
        "      action:",
        "        kind: close_issue",
        "        state_reason: wontfix",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toContain(
      `workflow state closing at ${workflowPath} close_issue state_reason must be completed or not_planned`
    );
  });

  it("accepts a label_issue action with a non-empty labels list", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: label_after_merge",
        "  initial: labeling",
        "  states:",
        "    labeling:",
        "      action:",
        "        kind: label_issue",
        "        labels:",
        "          - agent-ready",
        "          - needs-triage",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);
    const labeling = result.workflow.states.find(
      (state) => state.id === "labeling"
    );

    expect(result.errors).toEqual([]);
    expect(labeling?.action).toEqual({
      kind: "label_issue",
      labels: ["agent-ready", "needs-triage"],
      method: "add"
    });
  });

  it("accepts a label_issue action with an explicit remove method", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: label_remove",
        "  initial: labeling",
        "  states:",
        "    labeling:",
        "      action:",
        "        kind: label_issue",
        "        labels:",
        "          - agent-ready",
        "        method: remove",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);
    const labeling = result.workflow.states.find(
      (state) => state.id === "labeling"
    );

    expect(result.errors).toEqual([]);
    expect(labeling?.action).toEqual({
      kind: "label_issue",
      labels: ["agent-ready"],
      method: "remove"
    });
  });

  it("rejects a label_issue action with an invalid method", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: label_bad_method",
        "  initial: labeling",
        "  states:",
        "    labeling:",
        "      action:",
        "        kind: label_issue",
        "        labels:",
        "          - agent-ready",
        "        method: rename",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toContain(
      `workflow state labeling at ${workflowPath} label_issue method must be one of add, remove`
    );
  });

  it("rejects a label_issue action that omits labels", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: label_missing",
        "  initial: labeling",
        "  states:",
        "    labeling:",
        "      action:",
        "        kind: label_issue",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toContain(
      `workflow state labeling at ${workflowPath} label_issue action must define a non-empty labels list`
    );
  });

  it("rejects a label_issue action with an empty labels list", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: label_empty",
        "  initial: labeling",
        "  states:",
        "    labeling:",
        "      action:",
        "        kind: label_issue",
        "        labels: []",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toContain(
      `workflow state labeling at ${workflowPath} label_issue action must define a non-empty labels list`
    );
  });

  it("accepts a comment action with a body", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: comment_after_merge",
        "  initial: commenting",
        "  states:",
        "    commenting:",
        "      action:",
        "        kind: comment",
        '        body: "Part of this issue landed in #252."',
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);
    const commenting = result.workflow.states.find(
      (state) => state.id === "commenting"
    );

    expect(result.errors).toEqual([]);
    expect(commenting?.action).toEqual({
      body: "Part of this issue landed in #252.",
      kind: "comment"
    });
  });

  it("rejects a comment action that omits body", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: comment_missing_body",
        "  initial: commenting",
        "  states:",
        "    commenting:",
        "      action:",
        "        kind: comment",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toContain(
      `workflow state commenting at ${workflowPath} comment action must define body`
    );
  });

  it("rejects a label_issue action carrying a stray prompt field", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: label_stray_prompt",
        "  initial: labeling",
        "  states:",
        "    labeling:",
        "      action:",
        "        kind: label_issue",
        "        labels:",
        "          - agent-ready",
        "        prompt: prompts/oops.md",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toContain(
      `workflow state labeling at ${workflowPath} label_issue action must not define prompt`
    );
  });

  it("rejects a comment action carrying a stray labels field", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: comment_stray_labels",
        "  initial: commenting",
        "  states:",
        "    commenting:",
        "      action:",
        "        kind: comment",
        '        body: "hello"',
        "        labels:",
        "          - agent-ready",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toContain(
      `workflow state commenting at ${workflowPath} comment action must not define labels`
    );
  });

  it("rejects a close_issue action carrying a stray labels field", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: close_stray_labels",
        "  initial: closing",
        "  states:",
        "    closing:",
        "      action:",
        "        kind: close_issue",
        "        labels:",
        "          - agent-ready",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toContain(
      `workflow state closing at ${workflowPath} close_issue action must not define labels`
    );
  });

  it("rejects a wait action carrying a stray body field", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: wait_stray_body",
        "  initial: waiting",
        "  states:",
        "    waiting:",
        "      action:",
        "        kind: wait",
        '        body: "hello"',
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

    expect(result.errors).toContain(
      `workflow state waiting at ${workflowPath} wait action must not define body`
    );
  });

  it("rejects a merge_pr action carrying a stray state_reason field", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: merge_stray_state_reason",
        "  initial: merging",
        "  states:",
        "    merging:",
        "      action:",
        "        kind: merge_pr",
        "        state_reason: completed",
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

    expect(result.errors).toContain(
      `workflow state merging at ${workflowPath} merge_pr action must not define state_reason`
    );
  });

  it("rejects an agent action carrying a stray labels field", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: agent_stray_labels",
        "  initial: implementing",
        "  states:",
        "    implementing:",
        "      action:",
        "        kind: agent",
        "        prompt: prompts/implement.md",
        "        labels:",
        "          - agent-ready",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toContain(
      `workflow state implementing at ${workflowPath} agent action must not define labels`
    );
  });

  it("rejects a label_issue transition that gates on a pull-request signal it can never produce", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: label_stray_pr_signal",
        "  initial: labeling",
        "  states:",
        "    labeling:",
        "      action:",
        "        kind: label_issue",
        "        labels:",
        "          - agent-ready",
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

    expect(result.errors).toContain(
      `workflow state labeling at ${workflowPath} label_issue action's transition to done names pr_merged, which this action never produces and can never satisfy`
    );
  });

  it("rejects a close_issue complete_when that gates on an agent signal it can never produce", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: close_stray_agent_signal",
        "  initial: closing",
        "  states:",
        "    closing:",
        "      action:",
        "        kind: close_issue",
        "      complete_when:",
        "        provider_success: true",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toContain(
      `workflow state closing at ${workflowPath} close_issue action's complete_when names provider_success, which this action never produces and can never satisfy`
    );
  });

  it("rejects a comment transition that gates on claim_status, which it can never produce", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: comment_stray_claim_signal",
        "  initial: commenting",
        "  states:",
        "    commenting:",
        "      action:",
        "        kind: comment",
        "        body: Update posted.",
        "      transitions:",
        "        - to: done",
        "          when:",
        "            claim_status: blocked",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toContain(
      `workflow state commenting at ${workflowPath} comment action's transition to done names claim_status, which this action never produces and can never satisfy`
    );
  });

  it("rejects a wait transition that gates on claim_status, which it can never produce", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: wait_stray_claim_signal",
        "  initial: waiting",
        "  states:",
        "    waiting:",
        "      action:",
        "        kind: wait",
        "      transitions:",
        "        - to: done",
        "          when:",
        "            claim_status: blocked",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toContain(
      `workflow state waiting at ${workflowPath} wait action's transition to done names claim_status, which this action never produces and can never satisfy`
    );
  });

  it("rejects a merge_pr transition that gates on claim_status, which it can never produce", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await writeFile(
      workflowPath,
      [
        "workflow:",
        "  name: merge_pr_stray_claim_signal",
        "  initial: merging",
        "  states:",
        "    merging:",
        "      action:",
        "        kind: merge_pr",
        "      transitions:",
        "        - to: done",
        "          when:",
        "            claim_status: success",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );

    const result = await loadExpandedWorkflow(workflowPath);

    expect(result.errors).toContain(
      `workflow state merging at ${workflowPath} merge_pr action's transition to done names claim_status, which this action never produces and can never satisfy`
    );
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
      ]
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
      ]
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
      ]
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
      ]
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
      ]
    };

    const errors = await validateExpandedWorkflowReferences(
      workflow,
      workflowPath
    );
    expect(errors).toEqual([]);
  });
});

describe("collectWorkflowPromptConventionWarnings", () => {
  it("returns no warnings when every raw FSM agent prompt already resolves inside prompts/", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await mkdir(path.join(root, "prompts"), { recursive: true });

    const workflow: ExpandedWorkflow = {
      contentHash: "sha256:placeholder",
      initial: "implement",
      name: "consistent",
      source: { kind: "raw_fsm", path: workflowPath },
      states: [
        {
          action: {
            kind: "agent",
            provider: "codex",
            prompt: "prompts/impl.md"
          },
          completeWhen: {},
          id: "implement",
          transitions: [{ to: "done", when: {} }]
        },
        { completeWhen: {}, id: "done", terminal: "success", transitions: [] }
      ]
    };

    const warnings = await collectWorkflowPromptConventionWarnings(
      workflow,
      workflowPath
    );
    expect(warnings).toEqual([]);
  });

  it("warns when an agent prompt sits outside prompts/ even though prompts/ exists (vow-lang/vow#1277 postmortem)", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");
    await mkdir(path.join(root, "prompts"), { recursive: true });

    const workflow: ExpandedWorkflow = {
      contentHash: "sha256:placeholder",
      initial: "implement",
      name: "inconsistent",
      source: { kind: "raw_fsm", path: workflowPath },
      states: [
        {
          action: { kind: "agent", provider: "codex", prompt: "WORKFLOW.md" },
          completeWhen: {},
          id: "implement",
          transitions: [{ to: "done", when: {} }]
        },
        { completeWhen: {}, id: "done", terminal: "success", transitions: [] }
      ]
    };

    const warnings = await collectWorkflowPromptConventionWarnings(
      workflow,
      workflowPath
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("implement");
    expect(warnings[0]).toContain("WORKFLOW.md");
    expect(warnings[0]).toContain("prompts/");
  });

  it("stays silent when the workflow directory has no prompts/ at all", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "workflow.yml");

    const workflow: ExpandedWorkflow = {
      contentHash: "sha256:placeholder",
      initial: "implement",
      name: "no_prompts_dir",
      source: { kind: "raw_fsm", path: workflowPath },
      states: [
        {
          action: { kind: "agent", provider: "codex", prompt: "WORKFLOW.md" },
          completeWhen: {},
          id: "implement",
          transitions: [{ to: "done", when: {} }]
        },
        { completeWhen: {}, id: "done", terminal: "success", transitions: [] }
      ]
    };

    const warnings = await collectWorkflowPromptConventionWarnings(
      workflow,
      workflowPath
    );
    expect(warnings).toEqual([]);
  });

  it("skips markdown-sourced workflows even when a prompts/ directory happens to exist", async () => {
    const root = await makeTempRoot();
    const workflowPath = path.join(root, "WORKFLOW.md");
    await mkdir(path.join(root, "prompts"), { recursive: true });

    const workflow: ExpandedWorkflow = {
      contentHash: "sha256:placeholder",
      initial: "run_agent",
      name: "markdown_workflow",
      source: { kind: "markdown", path: workflowPath },
      states: [
        {
          action: { kind: "agent", provider: "codex", prompt: "unused.md" },
          completeWhen: {},
          id: "run_agent",
          transitions: [{ to: "done", when: {} }]
        },
        { completeWhen: {}, id: "done", terminal: "success", transitions: [] }
      ]
    };

    const warnings = await collectWorkflowPromptConventionWarnings(
      workflow,
      workflowPath
    );
    expect(warnings).toEqual([]);
  });
});
